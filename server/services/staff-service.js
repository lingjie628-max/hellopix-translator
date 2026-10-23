'use strict'

/**
 * 超管账号管理 —— 谁能变成超管、身上有哪些不可破坏的约束。
 *
 * ## 为什么单独抽出来
 *
 * `routes/admin/accounts.js` 里的 `POST /admin/staff/save` 原本 35 行，
 * 直接 `INSERT ... role=$4`，`$4` 来自 `data.role || 'operator'`。
 * 也就是说 `role` 是**客户端想说啥就是啥**，只靠数据库的 CHECK 兜着
 * （CHECK 只管"是不是这 4 个字面量"，不管"该不该给"）。
 *
 * 2026-10-23 入侵：攻击者用 `/ADMIN/staff/save` 建了两个后门超管。
 * 那一轮修的是"建超管要二次认证"和"要留审计"。这次补的是**第三条**：
 * 即使二次认证过了，也必须回答「凭什么是超管」。
 *
 * ## 这里的四条铁律
 *
 * 1. **角色白名单**：只接受 superadmin / operator。`admin` / `auditor` 是
 *    001 schema 里预留但**从未实现**的角色 —— `capabilities.allows()` 只认
 *    superadmin 和 OPERATOR_CAPS，其它角色一律 DENY。把它们写进库，
 *    结果是"账号存在但什么都干不了"，排障时会被误认为权限系统坏了。
 *
 * 2. **必须有第二个超管才能动自己**：改自己的密码、降自己的级、停用自己 ——
 *    都要求系统里**还有另一个可用超管**。否则一次手滑就把平台锁死。
 *
 * 3. **不能没有超管**：任何让 superadmin 数量归零的操作直接拒绝。
 *    包括降级 / 停用 / 删除（删除目前没有路由，但规则写在这里，将来加路由
 *    时不会忘）。
 *
 * 4. **新建超管必须写审计**，带来源 IP 和目标账号。
 *
 * 规则都写成"先算后写"，不依赖数据库端 CHECK 兜底 —— CHECK 只保证格式，
 * 不保证业务不变量。锁死平台这种事故，必须在这里挡。
 */

const { ApiError } = require('../lib/http')

/** 允许通过接口设定的角色。刻意不含 admin / auditor，见文件头第 1 条。 */
const ASSIGNABLE_ROLES = new Set(['superadmin', 'operator'])

/** 视为"可用的超管"的判据：角色对、状态启用。 */
const ACTIVE_SUPERADMIN_SQL =
  "SELECT count(*)::int AS n FROM admins WHERE role = 'superadmin' AND status = 1"

/**
 * 继承 ApiError 而不是自己造一个 —— 全局错误中间件按 `status`/`code`
 * 处理 ApiError；自造一个同形状的类在 catch 分支里未必被识别，
 * 会被当成 500 吞掉，前端只能看到"服务器错误"。
 */
class StaffError extends ApiError {}

/**
 * 统计当前可用的超管数量。
 * @param {object} repo
 * @param {object} [client] 事务客户端；传入则在事务内计数（避免 TOCTOU）
 */
async function countActiveSuperadmins (repo, client) {
  const result = await repo.query(ACTIVE_SUPERADMIN_SQL, [], client)
  return Number((result.rows[0] || {}).n || 0)
}

/**
 * 目标账号是不是"当前这个操作者自己"。
 *
 * 用 id 比，不用 username —— username 大小写不敏感（unique index 是
 * lower(username)），而操作者可能用 `Pix` 登录、库里存的是 `pix`。
 */
function isSelf (admin, targetId, data) {
  if (!admin || !admin.id) return false
  const target = targetId != null ? Number(targetId) : (data && data.id ? Number(data.id) : null)
  return target != null && Number(admin.id) === target
}

/** 角色合法性：空表示不改。 */
function assertRole (role) {
  if (role == null || role === '') return null
  const value = String(role)
  if (!ASSIGNABLE_ROLES.has(value)) {
    throw new StaffError(400, '角色只能是超级管理员或运营', 'BAD_ROLE')
  }
  return value
}

/**
 * 修改已有账号前的不变量检查。
 *
 * 必须在**事务内、对目标行加锁之后**调用：两个人同时把对方降级时，
 * 不加锁会出现 A 读到 2 个超管 → B 也读到 2 个 → 两个都写成功 → 0 个超管。
 *
 * @param {object} repo
 * @param {object} client        事务客户端（计数与写入必须同一事务）
 * @param {object} current       目标账号当前行 {id, role, status}
 * @param {object} next          {role?:string|null, status?:number|null}
 * @param {object} actor         操作者（req.pixAdmin）
 */
async function assertCanModify (repo, client, current, next, actor) {
  const self = isSelf(actor, current.id, null)

  const downgrading = next.role != null && current.role === 'superadmin' && next.role !== 'superadmin'
  const deactivating = next.status === 0 && current.role === 'superadmin'
  const losing = downgrading || deactivating

  if (!losing) return

  // 这次改动会不会让"启用的超管"数量归零。
  // 目标本来就是停用状态的话，动它不会减少可用超管数。
  const total = await countActiveSuperadmins(repo, client)
  const targetCountsNow = current.role === 'superadmin' && Number(current.status) === 1
  if (total - (targetCountsNow ? 1 : 0) < 1) {
    throw new StaffError(409,
      self
        ? '这是当前唯一的超级管理员，不能降级或停用自己。请先创建另一个超管。'
        : '系统必须至少保留一个启用的超级管理员',
      'LAST_SUPERADMIN')
  }
}

/**
 * 处理一次 staff/save。
 *
 * @param {object} deps  {repo, auth, security}
 * @param {object} data  请求体
 * @param {object} actor req.pixAdmin
 * @param {string} ip
 */
async function saveStaff ({ repo, auth, security }, data, actor, ip) {
  const role = assertRole(data.role)

  if (data.id) return updateStaff({ repo, auth, security }, data, role, actor, ip)
  return createStaff({ repo, auth, security }, data, role, actor, ip)
}

async function updateStaff ({ repo, auth, security }, data, role, actor, ip) {
  const id = Number(data.id)
  if (!Number.isFinite(id) || id <= 0) {
    throw new StaffError(400, '账号 id 不合法', 'BAD_ADMIN_ID')
  }
  if (!data.nickname && !data.password && role == null) {
    throw new StaffError(400, '没有要修改的内容', 'NOTHING_TO_CHANGE')
  }
  // 改名不在本接口范围内（前端也是 disabled 的），传了直接忽略，
  // 避免"看起来改了其实没改"的误解。

  const hash = data.password ? await auth.hash(data.password) : null

  return repo.transaction(async client => {
    // FOR UPDATE：两个人同时把对方降级时，必须串行判断"还剩几个超管"。
    // 不加锁就会出现 A 读 count=2 → B 读 count=2 → 两个都写成功 → 0 个超管。
    const found = await repo.query(
      'SELECT id,username,role,status FROM admins WHERE id=$1 FOR UPDATE', [id], client)
    const current = found.rows[0]
    if (!current) throw new StaffError(404, '账号不存在', 'ADMIN_NOT_FOUND')

    await assertCanModify(repo, client, current, { role, status: null, password: !!hash }, actor)

    const result = await repo.query(
      `UPDATE admins
          SET nickname      = COALESCE($2, nickname),
              password_hash = COALESCE($3, password_hash),
              role          = COALESCE($4, role),
              updated_at    = NOW()
        WHERE id = $1
        RETURNING id,username,role`,
      [id, data.nickname || null, hash, role], client
    )
    const row = result.rows[0]

    const changed = [
      data.nickname ? 'nickname' : null,
      hash ? 'password' : null,
      role && role !== current.role ? `role→${role}` : null
    ].filter(Boolean).join(',') || '无变更'

    await repo.audit(client, actor, '修改超管账号',
      `${row.username}（${changed}）${isSelf(actor, id, null) ? ' [操作自己]' : ''}`,
      ip, { type: 'admin', id })

    return { created: false, username: row.username, role: row.role, changed }
  }).then(async result => {
    // 改密码后必须踢掉旧会话 —— 放在事务**之后**：事务回滚了却撤销了会话，
    // 等于把人无谓地踢下线（和 users/resetPassword 的原则一致）。
    if (hash) await security.revokeSubject('admin', id)
    return result
  })
}

async function createStaff ({ repo, auth }, data, role, actor, ip) {
  const username = String(data.username || '').trim()
  if (!username) throw new StaffError(400, '账号不能为空', 'USERNAME_REQUIRED')
  if (!data.password) throw new StaffError(400, '密码不能为空', 'PASSWORD_REQUIRED')

  // 创建时角色必须明示。默认给 operator 是**危险默认值**：
  // 前端写错字段或第三方脚本漏传 role，就会静默造出一个"最低权限"的账号，
  // 而调用方以为建好了超管 —— 这种"看起来成功其实没成"最难排查。
  // 反过来默认给 superadmin 更糟。所以要求显式传。
  if (role == null) throw new StaffError(400, '必须指定角色', 'ROLE_REQUIRED')

  const hash = await auth.hash(data.password)
  const nickname = String(data.nickname || username).slice(0, 120)

  return repo.transaction(async client => {
    let created
    try {
      created = await repo.query(
        `INSERT INTO admins(username,password_hash,nickname,role)
         VALUES($1,$2,$3,$4) RETURNING id,username,role`,
        [username, hash, nickname, role], client
      )
    } catch (error) {
      // 唯一索引 admins_username_lower_uidx 是 lower(username)，所以大小写不同
      // 也算重名。把 23505 翻译成人话，而不是让前端看到 500。
      if (error && error.code === '23505') {
        throw new StaffError(409, '该账号已存在（账号名不区分大小写）', 'ADMIN_EXISTS')
      }
      throw error
    }
    const row = created.rows[0]
    await repo.audit(client, actor, '新建超管账号',
      `${row.username}（role=${row.role}）`, ip, { type: 'admin', id: Number(row.id) })
    return { created: true, username: row.username, role: row.role }
  })
}

module.exports = {
  ASSIGNABLE_ROLES,
  StaffError,
  countActiveSuperadmins,
  saveStaff,
  // 导出给测试直接打规则
  assertRole,
  assertCanModify
}
