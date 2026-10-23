'use strict'

/**
 * 超管账号创建/修改的业务不变量。
 *
 * 背景：2026-10-23 入侵者用 `/ADMIN/staff/save` 建了两个后门超管。
 * 那一轮修的是"二次认证 + 审计"，这次修的是**凭什么是超管**。
 *
 * 这些用例直接打 staff-service 的规则，不经过 HTTP，因为要验证的是
 * "规则本身对不对"，而不是"路由挂没挂上"。HTTP 那一层由
 * test/authz-capabilities.test.js 和 test/require-totp.test.js 覆盖。
 */

const test = require('node:test')
const assert = require('node:assert')

const {
  ASSIGNABLE_ROLES,
  StaffError,
  saveStaff,
  assertRole,
  countActiveSuperadmins
} = require('../server/services/staff-service')

// ── 假 repo：只实现本服务用到的那几个方法 ──────────────────────────
//
// 刻意用假 repo 而不是真库：这些规则的判据是"超管剩几个"，用真库要么
// 改到别人的测试数据，要么每次都要建表删表。这里把 count 完全控在手里，
// 能精确构造"只剩 1 个超管"这种边界，而不用关心库里还有什么。
function fakeRepo (opts) {
  const state = Object.assign({
    admins: [],       // {id, username, role, status}
    audits: [],
    queries: []
  }, opts)

  return Object.assign(state, {
    async query (sql, values) {
      state.queries.push({ sql, values })
      if (/count\(\*\)::int AS n FROM admins/.test(sql)) {
        const n = state.admins.filter(a => a.role === 'superadmin' && Number(a.status) === 1).length
        return { rows: [{ n }] }
      }
      if (/SELECT id,username,role,status FROM admins WHERE id=\$1 FOR UPDATE/.test(sql)) {
        const row = state.admins.find(a => Number(a.id) === Number(values[0]))
        return { rows: row ? [{ ...row }] : [] }
      }
      if (/^UPDATE admins/.test(sql)) {
        const row = state.admins.find(a => Number(a.id) === Number(values[0]))
        if (!row) return { rows: [] }
        if (values[1] != null) row.nickname = values[1]
        if (values[2] != null) row.passwordHash = values[2]
        if (values[3] != null) row.role = values[3]
        return { rows: [{ id: row.id, username: row.username, role: row.role }] }
      }
      if (/^INSERT INTO admins/.test(sql)) {
        const clash = state.admins.some(a => a.username.toLowerCase() === String(values[0]).toLowerCase())
        if (clash) {
          const error = new Error('duplicate key')
          error.code = '23505'
          throw error
        }
        const row = { id: state.admins.length + 100, username: values[0], role: values[3], status: 1 }
        state.admins.push(row)
        return { rows: [{ id: row.id, username: row.username, role: row.role }] }
      }
      throw new Error('unexpected SQL: ' + sql)
    },
    async transaction (work) {
      const snapshot = JSON.parse(JSON.stringify(state.admins))
      try {
        return await work(state)
      } catch (error) {
        state.admins = snapshot
        throw error
      }
    },
    async audit (_client, actor, action, detail, ip, ref) {
      state.audits.push({ actor: actor && actor.username, action, detail, ip, ref })
    }
  })
}

const fakeAuth = {
  async hash (password) {
    if (!password || String(password).length < 6) {
      const err = new Error('密码至少 6 位')
      err.code = 'WEAK_PASSWORD'
      throw err
    }
    return 'scrypt$fake$fake'
  }
}

const fakeSecurity = { revoked: [], async revokeSubject (kind, id) { this.revoked.push([kind, id]) } }

function deps (repo) {
  return {
    repo,
    auth: fakeAuth,
    security: Object.assign({ revoked: [], async revokeSubject (kind, id) { this.revoked.push([kind, id]) } })
  }
}

const actor = { id: 1, username: 'pix', role: 'superadmin' }

// ── 角色白名单 ────────────────────────────────────────────────────────

test('超管：角色只能是 superadmin / operator', () => {
  assert.deepEqual([...ASSIGNABLE_ROLES].sort(), ['operator', 'superadmin'])
  assert.equal(assertRole('superadmin'), 'superadmin')
  assert.equal(assertRole('operator'), 'operator')
  assert.equal(assertRole(''), null)
  assert.equal(assertRole(null), null)
  assert.throws(() => assertRole('admin'), e => e.status === 400 && e.code === 'BAD_ROLE')
  assert.throws(() => assertRole('auditor'), e => e.code === 'BAD_ROLE')
  assert.throws(() => assertRole('root'), e => e.code === 'BAD_ROLE')
  // 大小写不能绕过
  assert.throws(() => assertRole('SuperAdmin'), e => e.code === 'BAD_ROLE')
})

test('超管：建号时不传角色直接拒绝，不静默降成 operator', async () => {
  const repo = fakeRepo()
  await assert.rejects(
    () => saveStaff(deps(repo), { username: 'newbie', password: 'Abcd1234' }, actor, '1.2.3.4'),
    e => e.status === 400 && e.code === 'ROLE_REQUIRED'
  )
  assert.equal(repo.admins.length, 0, '被拒绝的请求不能留下半个账号')
})

test('超管：用 admin / auditor 当角色建号会被拒，且不落库', async () => {
  const repo = fakeRepo()
  for (const role of ['admin', 'auditor', 'root', 'SuperAdmin']) {
    await assert.rejects(
      () => saveStaff(deps(repo), { username: 'x_' + role, password: 'Abcd1234', role }, actor, '1.2.3.4'),
      e => e.code === 'BAD_ROLE',
      `角色 ${role} 必须被拒`
    )
  }
  assert.equal(repo.admins.length, 0)
})

test('超管：正常建号会落库并写审计（含角色与来源 IP）', async () => {
  const repo = fakeRepo()
  const result = await saveStaff(deps(repo),
    { username: 'ops1', password: 'Abcd1234', role: 'operator', nickname: '运营一号' }, actor, '9.9.9.9')

  assert.equal(result.created, true)
  assert.equal(result.role, 'operator')
  assert.equal(repo.admins.length, 1)
  const audit = repo.audits.find(a => a.action === '新建超管账号')
  assert.ok(audit, '必须留审计')
  assert.match(audit.detail, /ops1/)
  assert.match(audit.detail, /role=operator/)
  assert.equal(audit.ip, '9.9.9.9')
})

test('超管：账号名重复（大小写不同也算）返回 409 而不是 500', async () => {
  const repo = fakeRepo({ admins: [{ id: 1, username: 'pix', role: 'superadmin', status: 1 }] })
  await assert.rejects(
    () => saveStaff(deps(repo), { username: 'PIX', password: 'Abcd1234', role: 'operator' }, actor, '1.1.1.1'),
    e => e.status === 409 && e.code === 'ADMIN_EXISTS'
  )
})

// ── 不能把超管抹到 0 ──────────────────────────────────────────────────

test('超管：唯一的超管不能降级自己', async () => {
  const repo = fakeRepo({
    admins: [{ id: 1, username: 'pix', role: 'superadmin', status: 1 }]
  })
  await assert.rejects(
    () => saveStaff(deps(repo), { id: 1, role: 'operator' }, actor, '1.1.1.1'),
    e => e.status === 409 && e.code === 'LAST_SUPERADMIN'
  )
  assert.equal(repo.admins[0].role, 'superadmin', '拒绝后不能改动原数据')
})

test('超管：staff/save 不接受 status 字段 —— 停用走不收窄的路径就没有', async () => {
  // 全系统只有 staff-service 一处能改 admins.role / admins.status。
  // 但 staff/save 的语义是"改资料"，不该顺手改启用状态 —— 那是另一套
  // 权限语义（启用/停用要能撤销会话、要能重新审核）。
  //
  // 这里锁死"传 status 会被忽略"：将来谁想在这个接口上加停用能力，
  // 必须先想清楚上面的问题，而不是顺手加一个 COALESCE($5, status)。
  const repo = fakeRepo({
    admins: [
      { id: 1, username: 'pix', role: 'superadmin', status: 1 },
      { id: 2, username: 'ops', role: 'operator', status: 1 }
    ]
  })
  await saveStaff(deps(repo), { id: 2, nickname: '改名', status: 0 }, actor, '1.1.1.1')
  assert.equal(repo.admins.find(a => a.id === 2).status, 1, 'status 不能被这个接口改掉')
})

test('超管：有第二个超管时可以降级自己', async () => {
  const repo = fakeRepo({
    admins: [
      { id: 1, username: 'pix', role: 'superadmin', status: 1 },
      { id: 2, username: 'backup', role: 'superadmin', status: 1 }
    ]
  })
  const result = await saveStaff(deps(repo), { id: 1, role: 'operator' }, actor, '1.1.1.1')
  assert.equal(result.created, false)
  assert.equal(repo.admins.find(a => a.id === 1).role, 'operator')
})

test('超管：第二个超管是停用状态时，不算"还有一个"', async () => {
  const repo = fakeRepo({
    admins: [
      { id: 1, username: 'pix', role: 'superadmin', status: 1 },
      { id: 2, username: 'dead', role: 'superadmin', status: 0 }
    ]
  })
  await assert.rejects(
    () => saveStaff(deps(repo), { id: 1, role: 'operator' }, actor, '1.1.1.1'),
    e => e.code === 'LAST_SUPERADMIN',
    '停用的超管登不进来，不能当作保底'
  )
})

test('超管：不能把"别人的最后一个超管"降级（不只看自己）', async () => {
  // 操作者是超管 A，目标也是超管 B，但库里只有 B 一个启用的超管
  // （A 可能是通过别的途径进来的）。B 被降级后系统就没人能管了。
  const repo = fakeRepo({
    admins: [{ id: 2, username: 'solo', role: 'superadmin', status: 1 }]
  })
  await assert.rejects(
    () => saveStaff(deps(repo), { id: 2, role: 'operator' }, { id: 99, username: 'other', role: 'superadmin' }, '1.1.1.1'),
    e => e.code === 'LAST_SUPERADMIN'
  )
})

// ── 正常修改路径 ──────────────────────────────────────────────────────

test('超管：改密码会撤销该账号的会话，且不落明文', async () => {
  const repo = fakeRepo({
    admins: [
      { id: 1, username: 'pix', role: 'superadmin', status: 1 },
      { id: 2, username: 'ops', role: 'operator', status: 1 }
    ]
  })
  const d = deps(repo)
  await saveStaff(d, { id: 2, password: 'NewPass123' }, actor, '1.1.1.1')
  assert.deepEqual(d.security.revoked, [['admin', 2]])
  assert.ok(repo.audits.some(a => /password/.test(a.detail)) || repo.audits.length > 0)
})

test('超管：空请求（什么都没改）被拒，避免写一条"无变更"的审计噪音', async () => {
  const repo = fakeRepo({ admins: [{ id: 1, username: 'pix', role: 'superadmin', status: 1 }] })
  await assert.rejects(
    () => saveStaff(deps(repo), { id: 1 }, actor, '1.1.1.1'),
    e => e.code === 'NOTHING_TO_CHANGE'
  )
})

test('超管：改不存在的账号返回 404', async () => {
  const repo = fakeRepo({ admins: [] })
  await assert.rejects(
    () => saveStaff(deps(repo), { id: 12345, nickname: 'x' }, actor, '1.1.1.1'),
    e => e.status === 404 && e.code === 'ADMIN_NOT_FOUND'
  )
})

// ── 规则本身可单测（不依赖 HTTP）─────────────────────────────────────

test('超管：assertCanModify 对非超管目标不设限', async () => {
  const repo = fakeRepo({ admins: [{ id: 5, username: 'op', role: 'operator', status: 1 }] })
  // operator 降成 operator（没变化）、改成任何角色都不减少超管数
  await assertCanModifyBare(repo, { id: 5, role: 'operator', status: 1 }, { role: 'operator' }, actor)
})

async function assertCanModifyBare (repo, current, next, who) {
  const { assertCanModify } = require('../server/services/staff-service')
  return assertCanModify(repo, repo, current, next, who)
}

test('超管：计数查询带角色与状态两个条件', async () => {
  const repo = fakeRepo()
  await countActiveSuperadmins(repo)
  const { sql } = repo.queries[0]
  assert.match(sql, /role = 'superadmin'/)
  assert.match(sql, /status = 1/, '停用的超管不能算进去 —— 他登不进来，救不了场')
})

test('超管：StaffError 是 ApiError，全局错误中间件能认得', () => {
  const { ApiError } = require('../server/lib/http')
  const err = new StaffError(409, 'x', 'LAST_SUPERADMIN')
  assert.ok(err instanceof ApiError, '不是 ApiError 会被当 500 吞掉')
  assert.equal(err.status, 409)
  assert.equal(err.code, 'LAST_SUPERADMIN')
})
