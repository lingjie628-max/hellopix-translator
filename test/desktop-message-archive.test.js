'use strict'

/**
 * 消息归档（messages 表）守卫。
 *
 * ## 被修的缺陷
 *
 * `messages` 表一直是空的。根因在客户端：`reportClue(body, direction)` 全文只有
 * `reportIfPeerChanged()` 一个调用点，而它传的 body **恒为空字符串**，
 * 服务端的写入条件是 `if (payload.body)` —— 永远进不去。
 *
 * 于是 conversations / customers / customer_owners 都建得好好的，
 * 消息正文一条都不写：消息归档能力等于没接上，`messages` 那张按月分区、
 * 带留存策略的表完全是空转的。
 *
 * 这个文件盯住三件事：
 *   1. 客户端**真的**把消息正文报上去了，而且去重
 *   2. 归档发生在翻译开关判断**之前**（不翻译的消息也要留档）
 *   3. 出向消息的发送方不能被记成客户
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const guest = fs.readFileSync(path.join(root, 'desktop', 'guest-inject.js'), 'utf8')
const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
// customer:ingest 等 handler 已迁到 src/ipc/app.js
const ipcApp = fs.readFileSync(path.join(root, 'desktop', 'src', 'ipc', 'app.js'), 'utf8')
const service = fs.readFileSync(path.join(root, 'server/services/customer-identity-service.js'), 'utf8')

test('客户端确实上报了消息正文（不再是恒空的 body）', () => {
  // 原来的唯一调用点是 reportClue('', 'in') —— body 永远是空串
  const emptyCalls = [...guest.matchAll(/reportClue\(\s*''\s*,/g)]
  assert.equal(emptyCalls.length, 1,
    '只应剩下 reportIfPeerChanged 里那一处空 body 调用（表示"只是打开了会话"）')

  assert.match(guest, /function reportMessage\(/, '缺少 reportMessage')
  assert.match(guest, /reportClue\(text, direction, messageTime\(node\)\)/,
    'reportMessage 必须把真实正文和时间传给 reportClue')
})

test('归档发生在翻译开关判断之前（不翻译的消息也要留档）', () => {
  const scanAt = guest.indexOf('async function scan()')
  assert.ok(scanAt > 0, '找不到 scan()')
  const scan = guest.slice(scanAt, guest.indexOf('function schedule()', scanAt))

  const reportAt = scan.indexOf('reportMessage(')
  assert.ok(reportAt > 0, 'scan() 里没有调用 reportMessage')

  // 归档必须**无条件**发生：翻译相关的一切判断都不许出现在它前面。
  // 曾经的写法是 `if (!prefs.transRecv) continue` 挂在归档之前，关掉接收翻译
  // 就不再留档；现在翻译判断全部收进 MessageParser.messageAction()，
  // 归档更彻底地独立于翻译开关。
  const prefHits = ['prefs.transRecv', 'prefs.transGroup']
    .map(name => scan.indexOf(name))
    .filter(at => at >= 0)
  const firstPrefAt = prefHits.length ? Math.min.apply(null, prefHits) : Infinity
  assert.ok(firstPrefAt > reportAt,
    '翻译开关的判断出现在归档之前，关掉翻译就不再留档了')

  // 判断统一走集中决策（正是它读 prefs），且排在归档之后
  const actionAt = scan.indexOf('MessageParser.messageAction(')
  assert.ok(actionAt > reportAt,
    '集中决策必须排在归档之后，否则不翻译的消息就不留档了')
})

test('归档不吞异常（翻译主流程不能被归档拖垮）', () => {
  assert.match(guest, /try \{ reportMessage\(/, 'reportMessage 必须被 try 包住')
})

test('消息去重：MutationObserver 会反复重扫同一条消息', () => {
  assert.match(guest, /var reportedKeys = Object\.create\(null\)/, '缺少去重表')
  assert.match(guest, /textHash\(/, '缺少正文哈希')
  assert.match(guest, /if \(reportedKeys\[key\]\) return/, '没有按 key 去重')
  // 键表必须有上限，否则长时间开着的客户端会无限增长
  assert.match(guest, /REPORTED_CAP = \d+/, '去重表没有容量上限')
  assert.match(guest, /if \(reportedCount >= REPORTED_CAP\)/, '达到上限后没有处理')
})

test('去重键包含会话与方向（不同会话的同名消息不能互相顶掉）', () => {
  assert.match(guest, /var key = peer\.peerKey \+ '\|' \+ direction \+ '\|' \+ textHash\(text\)/,
    '去重键必须含 peerKey 与 direction')
})

test('消息时间优先用 DOM 里的真实时间，解析不出才退回 now()', () => {
  assert.match(guest, /function messageTime\(/, '缺少 messageTime')
  assert.match(guest, /data-pre-plain-text/, '没有解析 WhatsApp 的时间')
  assert.match(guest, /time\[datetime\]/, '没有解析 Telegram 的 time[datetime]')
  assert.match(guest, /sentAt: sentAt \|\| new Date\(\)\.toISOString\(\)/,
    'sentAt 应优先用解析值，解析不出才退回当前时间')
})

test('出向消息的发送方由主进程补成本账号，而不是默认成客户', () => {
  // 服务端在 senderKey 缺失时拿 peerKey 兜底 —— 那是"接收"的语义。
  // 用在出向上会把"我方发了什么"记成"客户发了什么"。
  assert.match(ipcApp, /if \(data\.direction === 'out' && !data\.senderKey\) data\.senderKey = data\.accountKey/,
    '主进程没有为出向消息补 senderKey')
})

test('主进程仍然不信任渲染进程自报的身份', () => {
  // platform / accountKey 必须由主进程按 webContents 反查后覆盖，
  // 不能被 payload 里带的值顶掉（渲染进程跑在网页上下文里）。
  const ingestAt = ipcApp.indexOf("'customer:ingest'")
  assert.ok(ingestAt > 0, '找不到 customer:ingest')
  const block = ipcApp.slice(ingestAt, ingestAt + 900)
  const overwriteAt = block.indexOf('const data = Object.assign({}, payload || {}, {')
  assert.ok(overwriteAt > 0, 'platform/accountKey 的覆盖写法变了')
  assert.match(block.slice(overwriteAt, overwriteAt + 200), /platform: tab\.platform/,
    'platform 必须来自可信 tab')
  assert.match(block.slice(overwriteAt, overwriteAt + 200), /accountKey: actions\.accountSlug\(\)/,
    'accountKey 必须来自主进程')
})

test('服务端「body 为空不写消息」的语义保持不变', () => {
  // 空 body 表示"只是打开了会话"，用于触发撞单检测，但**不该**产生一条消息。
  assert.match(service, /if \(payload\.body\) \{/, '服务端的 body 判空逻辑被改动了')
  assert.match(service, /insertMessage\(/, '找不到 insertMessage 调用')
})

test('服务端仍然限制单条正文长度', () => {
  assert.match(service, /String\(payload\.body\)\.slice\(0, \d+\)/, '缺少正文长度上限')
})
