'use strict'

/**
 * 邮件通道巡检的测试。
 *
 * ## 背景：为什么这条巡检必须存在
 *
 * 2026-10-23 入侵者 pxroot3860 在 11:45~11:46 连改 12 次邮件配置，
 * 最后一次把 `mail.smtp.pass` 提交成空串 —— 真实 API Key 被覆盖。
 *
 * 后果：`POST /user/emailCode` 恒返回 503，注册与找回密码全废。
 * 而巡检每 10 分钟跑一次、每次都报"正常"，因为它根本不看邮件。
 *
 * 这个功能坏掉的形状极其安静：没人来投诉，他们只是关掉网页走了。
 *
 * ## 这组测试守什么
 *
 * 不测"函数返回值长什么样"，测**这次事故的每一种形状都能被抓到**：
 *
 *   1. pass 被清空            ← 事故原始形状，必须立刻报
 *   2. host / from 缺失       ← 同一次攻击的其它变体
 *   3. 配置齐全但发信被拒     ← 换 key、额度耗尽、域名被拉黑
 *   4. 没有告警收件地址       ← 告警本身哑了，也是隐患
 *   5. 探测频率限制           ← 不能每 10 分钟给供应商发一封
 */

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { checkMail } = require('../scripts/alert')

/** 造一个临时状态文件路径，避免测试互相污染，也避免写 /var/lib */
function tmpStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-health-'))
  return path.join(dir, 'probe.json')
}

/**
 * 搭一套可注入依赖。
 *
 * 关键：**永远不碰真实 SMTP**。这组测试跑在开发机和 CI 上，
 * 真发信既慢又可能触发供应商风控。
 */
function harness ({ configured = true, missing = [], sendResult, settings, sendCalls }) {
  const calls = sendCalls || []

  class FakeMailer {
    async config () {
      return { configured, missing }
    }
    async sendTest (to) {
      calls.push(to)
      if (sendResult instanceof Error) throw sendResult
      return sendResult || { ok: true }
    }
  }

  class FakeRepo {
    async settings () {
      return settings || {
        'mail.smtp': { host: 'smtp.resend.com', user: 'resend', pass: 're_xxx', from: 'no-reply@pixfanyi.com' },
        'mail.alert_to': 'ops@pixfanyi.com'
      }
    }
  }

  return {
    pool: {},
    stateFile: tmpStateFile(),
    calls,
    deps: { Mailer: FakeMailer, ProductionRepository: FakeRepo, readAlertTo: (s) => String(s['mail.alert_to'] || '') }
  }
}

test('事故原始形状：pass 被清空 → 必须判定故障', async () => {
  const h = harness({
    configured: false,
    missing: ['pass'],
    // 连 sendTest 都不该被调用：配置都没齐，发什么信
    sendResult: { ok: true }
  })
  const r = await checkMail(h.pool, { deps: h.deps, stateFile: h.stateFile })

  assert.equal(r.ok, false)
  assert.match(r.detail, /未配置/)
  assert.match(r.detail, /pass/)
  // 必须点名后果，否则运维不知道这事的严重性
  assert.match(r.detail, /注册与找回密码/)
  assert.equal(h.calls.length, 0, '配置不全时不应该发起真实发信')
})

test('host / from 缺失同样要报，且把所有缺失项一次列全', async () => {
  const h = harness({ configured: false, missing: ['host', 'from'] })
  const r = await checkMail(h.pool, { deps: h.deps, stateFile: h.stateFile })

  assert.equal(r.ok, false)
  assert.match(r.detail, /host/)
  assert.match(r.detail, /from/)
})

test('配置齐全、实发成功 → 正常，且确实发到了告警邮箱', async () => {
  const h = harness({ sendResult: { ok: true } })
  const r = await checkMail(h.pool, { deps: h.deps, stateFile: h.stateFile })

  assert.equal(r.ok, true)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0], 'ops@pixfanyi.com')
})

test('配置齐全但发信被拒（换了 key / 额度耗尽）→ 必须判定故障', async () => {
  const h = harness({
    sendResult: { ok: false, stage: 'deliver', code: 'EAUTH', msg: 'invalid api key' }
  })
  const r = await checkMail(h.pool, { deps: h.deps, stateFile: h.stateFile })

  assert.equal(r.ok, false)
  // 卡在哪一步必须报出来，否则排障又从零开始
  assert.match(r.detail, /deliver/)
  assert.match(r.detail, /EAUTH/)
})

test('sendTest 抛异常（不是返回 ok:false）也要被兜住，不能反过来把巡检打挂', async () => {
  const h = harness({ sendResult: new Error('socket hang up') })
  const r = await checkMail(h.pool, { deps: h.deps, stateFile: h.stateFile })

  assert.equal(r.ok, false)
  assert.match(r.detail, /socket hang up/)
})

test('SMTP 正常但告警收件地址为空 → 也算隐患（告警会哑）', async () => {
  const h = harness({
    sendResult: { ok: true },
    settings: {
      'mail.smtp': { host: 'smtp.resend.com', user: 'resend', pass: 're_xxx', from: 'no-reply@pixfanyi.com' },
      'mail.alert_to': ''
    }
  })
  const r = await checkMail(h.pool, { deps: h.deps, stateFile: h.stateFile })

  assert.equal(r.ok, false)
  assert.match(r.detail, /mail\.alert_to/)
  assert.equal(h.calls.length, 0)
})

test('探测频率限制：6 小时内不重复实发，避免把供应商惹毛', async () => {
  const h = harness({ sendResult: { ok: true } })

  await checkMail(h.pool, { deps: h.deps, stateFile: h.stateFile })
  const again = await checkMail(h.pool, { deps: h.deps, stateFile: h.stateFile })

  assert.equal(h.calls.length, 1, '第二轮应该被频率限制挡住')
  assert.equal(again.ok, true)
  assert.match(again.detail, /跳过/)
})

test('--force 手工排障时无视频率限制', async () => {
  const h = harness({ sendResult: { ok: true } })

  await checkMail(h.pool, { deps: h.deps, stateFile: h.stateFile })
  await checkMail(h.pool, { deps: h.deps, stateFile: h.stateFile, force: true })

  assert.equal(h.calls.length, 2)
})

test('频率限制不能掩盖已发生的故障：配置层每轮都查，不受间隔影响', async () => {
  const h = harness({ configured: false, missing: ['pass'] })

  const first = await checkMail(h.pool, { deps: h.deps, stateFile: h.stateFile })
  const second = await checkMail(h.pool, { deps: h.deps, stateFile: h.stateFile })

  // 两条都必须报错 —— 如果第二轮回"跳过"，就等于故障只报一次就哑了
  assert.equal(first.ok, false)
  assert.equal(second.ok, false)
})
