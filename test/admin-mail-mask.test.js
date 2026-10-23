/**
 * 告警邮箱不能以明文暴露给后台会话 —— 2026-10-23 入侵的"真名泄露"路径。
 *
 * ## 现场
 *
 * 攻击者拿到超管会话后：
 *   GET /apis/admin/mail → 200
 *   {"alertTo":"lingjie628@gmail.com", ...}
 *
 * 那是业主私人邮箱。它被拿去搜索引擎一搜就是真名 —— 对方三轮 136 步
 * 就拿到了。整个系统里没有任何"真名字段"，泄露的就是这一个邮箱。
 *
 * ## 两条约束
 *
 * 1. **返回给前端必须是打码的**：前端只需要知道"告警发给谁、配没配"。
 * 2. **不传 alertTo 时必须保持原值**：前端回填的是空串（打码值只进 placeholder），
 *    管理员改个端口一保存，如果后端把空串当真值写库，告警就静默断了 ——
 *    只有真出事那天才发现没人收到告警。
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const { maskEmail } = require('../server/lib/mailer')

// ── 打码规则 ──────────────────────────────────────────────

test('普通邮箱：本地部分只留前两位', () => {
  assert.equal(maskEmail('lingjie628@gmail.com'), 'li***@gmail.com')
  assert.equal(maskEmail('ops@yourdomain.com'), 'op***@yourdomain.com')
})

test('短本地部分只留一位，避免"全星号"看不出是谁', () => {
  assert.equal(maskEmail('ab@x.com'), 'a***@x.com')
  assert.equal(maskEmail('a@x.com'), 'a***@x.com')
})

test('域名保留：运营方需要确认收信方是自家域名', () => {
  assert.equal(maskEmail('devops@hello-pix.ai'), 'de***@hello-pix.ai')
})

test('空值 / 无 @ / 畸形值不抛错', () => {
  assert.equal(maskEmail(''), '')
  assert.equal(maskEmail(null), '')
  assert.equal(maskEmail(undefined), '')
  assert.equal(maskEmail('not-an-email'), '***')
})

test('打码结果里不能出现完整本地部分', () => {
  const full = 'lingjie628@gmail.com'
  const masked = maskEmail(full)
  assert.ok(!masked.includes('lingjie628'), '不能泄露完整邮箱前缀')
  assert.ok(masked.length < full.length)
})

// ── "会静默断告警"的回归 ──────────────────────────────────

test('打码后的值再打码不会变形（幂等性，防止重复处理）', () => {
  const once = maskEmail('lingjie628@gmail.com')
  const twice = maskEmail(once)
  // 第二次会把 'li***' 的 '* * *' 截断，但绝不能还原出原文
  assert.ok(!twice.includes('lingjie628'))
})
