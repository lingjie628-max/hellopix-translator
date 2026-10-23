'use strict'

/**
 * 强制两步验证（PIX_REQUIRE_ADMIN_TOTP）。
 *
 * ## 背景
 *
 * 2026-10-23 入侵：攻击者建的后门超管**没开 TOTP**，登录一路畅通，
 * 之后 19 次操作全部放行。TOTP 当时是纯可选，等于没有。
 *
 * ## 为什么做成开关而不是直接强制
 *
 * 线上现有超管如果都没绑 TOTP，代码一上线所有人立刻进不去后台 ——
 * 那不是安全，是停机。所以默认关闭，由运维确认线上状态后再打开。
 *
 * 这个文件同时验证**两种状态**，确保：
 *   1. 关的时候行为一点没变（不能因为加了这个功能而误伤正常登录）
 *   2. 开的时候确实挡住了，并且**留着自助绑定的路**（不能把人锁死在门外）
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')

const { AuthService } = require('../server/services/auth-service')

const ADMIN_NO_TOTP = { id: 1, role: 'superadmin', status: 1, username: 'pix', totpEnabled: false, passwordHash: 'hash:pix-pass' }
const ADMIN_TOTP = { id: 2, role: 'superadmin', status: 1, username: 'pix2', totpEnabled: true, passwordHash: 'hash:pix-pass' }

function harness (admin) {
  const svc = Object.create(AuthService.prototype)
  svc.security = {
    resolveSession: async (req, type) => (type === 'admin' && admin ? { subjectId: admin.id } : null)
  }
  svc.repository = {
    adminById: async () => admin,
    sessionAccount: async () => null,
    audit: async () => {}
  }
  svc.verify = async (encoded, supplied) => encoded === `hash:${supplied}`
  return svc
}

function routerWith (routes) {
  const r = express.Router()
  for (const [m, p] of routes) r[m.toLowerCase()](p, (_q, _s) => {})
  return r
}

const ROUTER = routerWith([
  ['GET', '/admin/stats'],
  ['GET', '/admin/customers'],
  ['GET', '/admin/totp'],
  ['POST', '/admin/totp/setup'],
  ['POST', '/admin/totp/enable'],
  ['POST', '/admin/logout']
])

async function run (svc, { path, method = 'GET', headers = {} }) {
  const req = {
    path,
    method,
    headers,
    ip: '203.0.113.9',
    app: { locals: { pixRouter: ROUTER } }
  }
  let status = null
  let passed = false
  svc.middleware()(req, {}, err => {
    if (err) { status = err.status || 500; return }
    passed = true
  })
  await new Promise(r => setImmediate(r))
  return { status, next: passed }
}

/** 临时设置环境变量，测试结束还原。 */
function withEnv (key, value) {
  const before = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  return () => {
    if (before === undefined) delete process.env[key]
    else process.env[key] = before
  }
}

// ── 关闭状态（默认）：行为必须和以前一模一样 ──────────────

test('开关关闭时：没绑 TOTP 的超管照常能用后台', async () => {
  const restore = withEnv('PIX_REQUIRE_ADMIN_TOTP', undefined)
  try {
    const svc = harness(ADMIN_NO_TOTP)
    const r = await run(svc, { path: '/admin/stats' })
    assert.equal(r.next, true, '默认必须放行，否则一上线所有人进不去')
  } finally { restore() }
})

test('开关关闭时：显式的其它值（如 0）也视为关闭', async () => {
  const restore = withEnv('PIX_REQUIRE_ADMIN_TOTP', '0')
  try {
    const svc = harness(ADMIN_NO_TOTP)
    const r = await run(svc, { path: '/admin/stats' })
    assert.equal(r.next, true)
  } finally { restore() }
})

// ── 开启状态：挡住，但留出自助绑定的路 ────────────────────

test('开关开启时：没绑 TOTP 的超管访问业务接口 → 403 TOTP_SETUP_REQUIRED', async () => {
  const restore = withEnv('PIX_REQUIRE_ADMIN_TOTP', '1')
  try {
    const svc = harness(ADMIN_NO_TOTP)
    for (const path of ['/admin/stats', '/admin/customers']) {
      const r = await run(svc, { path })
      assert.equal(r.next, false, `${path} 应当被挡下`)
      assert.equal(r.status, 403)
    }
  } finally { restore() }
})

test('开关开启时：TOTP 绑定接口必须放行（否则人永远绑不上，等于锁死）', async () => {
  const restore = withEnv('PIX_REQUIRE_ADMIN_TOTP', '1')
  try {
    const svc = harness(ADMIN_NO_TOTP)
    for (const [method, path] of [
      ['GET', '/admin/totp'],
      ['POST', '/admin/totp/setup'],
      ['POST', '/admin/totp/enable']
    ]) {
      const r = await run(svc, { path, method })
      assert.equal(r.next, true, `${method} ${path} 必须放行，否则无法自助绑定`)
    }
  } finally { restore() }
})

test('开关开启时：登出必须放行（被挡住也得能退出）', async () => {
  const restore = withEnv('PIX_REQUIRE_ADMIN_TOTP', '1')
  try {
    const svc = harness(ADMIN_NO_TOTP)
    const r = await run(svc, { path: '/admin/logout', method: 'POST' })
    assert.equal(r.next, true)
  } finally { restore() }
})

test('开关开启时：已绑 TOTP 的超管不受影响', async () => {
  const restore = withEnv('PIX_REQUIRE_ADMIN_TOTP', '1')
  try {
    const svc = harness(ADMIN_TOTP)
    const r = await run(svc, { path: '/admin/stats' })
    assert.equal(r.next, true, '绑了 TOTP 就该正常用')
  } finally { restore() }
})

test('开关开启时：拒绝发生在二次认证之前（不能先要密码再说不让用）', async () => {
  const restore = withEnv('PIX_REQUIRE_ADMIN_TOTP', '1')
  try {
    const svc = harness(ADMIN_NO_TOTP)
    // 高危接口且不带 reauth：应当是 TOTP 的 403，而不是 428
    const r = await run(svc, { path: '/admin/customers' })
    assert.equal(r.status, 403, '应先拒绝"没绑 TOTP"，而不是先索要二次认证密码')
  } finally { restore() }
})

test('环境变量的大小写和常见写法都认', async () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'YES']) {
    const restore = withEnv('PIX_REQUIRE_ADMIN_TOTP', value)
    try {
      const svc = harness(ADMIN_NO_TOTP)
      const r = await run(svc, { path: '/admin/stats' })
      assert.equal(r.next, false, `value=${value} 应当视为开启`)
    } finally { restore() }
  }
})
