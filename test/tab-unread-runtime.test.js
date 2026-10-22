const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { JSDOM } = require('jsdom')

const root = path.join(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
const rendererSrc = require('./helpers/renderer-src')
const appSrc = rendererSrc.all()

function extract(src, name) {
  const at = src.indexOf('function ' + name + '(')
  assert.ok(at >= 0, '找不到 ' + name)
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error('未闭合：' + name)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const DELAY = 40

/**
 * 装配 main.js 里**真实的**未读逻辑。只把清零延迟从 2500ms 换成 40ms，
 * 让时序用例跑得快；其余代码一字不改。
 */
function harness() {
  const tabs = []
  const badges = []
  let sends = 0
  const app = { setBadgeCount: n => { badges.push(n); return true } }
  const api = {}
  const sendTabs = () => { sends++; api.syncGlobalUnread() }
  const body = [
    'const UNREAD_CLEAR_DELAY_MS = ' + DELAY,
    extract(mainSrc, 'bindTabUnread'),
    'let lastGlobalUnread = -1',
    extract(mainSrc, 'syncGlobalUnread'),
    'return { unreadFromTitle, bindTabUnread, syncGlobalUnread }'
  ].join('\n')
  // unreadFromTitle 已搬进 src/window/hidden-tabs.js，直接注入真身，
  // 不再从 main.js 切片（那里只剩一行转发）。
  const { unreadFromTitle } = require('../desktop/src/window/hidden-tabs')
  // eslint-disable-next-line no-new-func
  Object.assign(api, new Function('tabs', 'sendTabs', 'app', 'unreadFromTitle', body)(tabs, sendTabs, app, unreadFromTitle))

  function addTab(settings) {
    const wc = new EventEmitter()
    let destroyed = false
    let title = ''
    wc.isDestroyed = () => destroyed
    wc.getTitle = () => title
    const tab = { id: 't' + tabs.length, settings: settings || {}, view: { webContents: wc } }
    tab.setTitle = t => { title = t; wc.emit('page-title-updated', {}, t) }
    tab.destroy = () => { destroyed = true; wc.emit('destroyed') }
    api.bindTabUnread(tab)
    tabs.push(tab)
    return tab
  }
  return { tabs, addTab, badges, sends: () => sends, api }
}

// ---------------------------------------------------------------------------
// 冒烟
// ---------------------------------------------------------------------------

test('冒烟：有未读 → 推一次；同值重复 → 不再推；变化 → 再推', () => {
  const h = harness()
  const t = h.addTab()
  t.setTitle('WhatsApp')
  assert.equal(h.sends(), 0, '一直没有未读，不该推界面')
  t.setTitle('(3) WhatsApp')
  assert.equal(t.unread, 3)
  assert.equal(h.sends(), 1)
  t.setTitle('(3) WhatsApp')
  assert.equal(h.sends(), 1, '同一个数不重复刷新标签栏')
  t.setTitle('(5) WhatsApp')
  assert.equal(t.unread, 5)
  assert.equal(h.sends(), 2)
  assert.deepEqual(h.badges, [3, 5])
})

test('冒烟：读完消息 → 延迟确认后清零，角标消失', async () => {
  const h = harness()
  const t = h.addTab()
  t.setTitle('(2) WhatsApp')
  t.setTitle('WhatsApp')
  assert.equal(t.unread, 2, '不立刻清零')
  await sleep(DELAY + 30)
  assert.equal(t.unread, 0)
  assert.deepEqual(h.badges, [2, 0])
})

test('冒烟：清零确认期间又来了未读 → 不清零', async () => {
  const h = harness()
  const t = h.addTab()
  t.setTitle('(1) Messenger')
  t.setTitle('张三 给你发了消息')
  await sleep(DELAY / 2)
  t.setTitle('(1) Messenger')
  await sleep(DELAY + 30)
  assert.equal(t.unread, 1)
  assert.equal(h.sends(), 1, '角标全程没有闪烁')
})

test('冒烟：清零确认期间关闭窗口 → 定时器不再动已销毁的窗口', async () => {
  const h = harness()
  const t = h.addTab()
  t.setTitle('(4) WhatsApp')
  t.setTitle('WhatsApp')
  t.destroy()
  const before = h.sends()
  await sleep(DELAY + 30)
  assert.equal(h.sends(), before)
})

test('冒烟：全局角标 = 各窗口之和，排除关了「全局未读提示」的窗口', () => {
  const h = harness()
  const a = h.addTab()
  const b = h.addTab({ globalUnread: false })
  const c = h.addTab()
  a.setTitle('(2) WhatsApp')
  b.setTitle('(7) Telegram')
  c.setTitle('(3) Zalo')
  assert.equal(h.badges[h.badges.length - 1], 5)
})

test('冒烟：真实 makeTabEl 渲染 —— 0 不出角标、有数出数字、超过 99 出 99+、开关关掉不出', () => {
  const dom = new JSDOM('<!doctype html><body></body>')
  const body = [
    extract(appSrc, 'makeTabEl'),
    'return makeTabEl'
  ].join('\n')
  const deps = {
    document: dom.window.document,
    iconTag: () => '<img class="tab-icon">',
    tabLabel: t => t.name,
    esc: s => String(s),
    showPixContextMenu: () => {},
    startTabRename: () => {},
    // 拖拽排序：这个测试只关心角标，拖拽桩成空实现即可。
    // 拖拽本身由 desktop/scripts/verify-tab-drag.js 覆盖。
    attachTabDrag: () => {},
    window: { pix: { switchTab: () => {}, close: () => {} } }
  }
  // eslint-disable-next-line no-new-func
  const makeTabEl = new Function(...Object.keys(deps), body)(...Object.values(deps))
  const badge = tab => {
    const el = makeTabEl(Object.assign({ id: 'x', platform: 'whatsapp', name: '凯瑟琳' }, tab), false)
    const b = el.querySelector('.tab-unread')
    return b ? b.textContent : null
  }
  assert.equal(badge({ unread: 0 }), null)
  assert.equal(badge({}), null)
  assert.equal(badge({ unread: 3 }), '3')
  assert.equal(badge({ unread: 99 }), '99')
  assert.equal(badge({ unread: 150 }), '99+')
  assert.equal(badge({ unread: 'abc' }), null)
  // 主进程在开关关掉时下发 0，界面就不出角标（实现在 src/window/tab-payload.js）
  const payloadSrc = fs.readFileSync(
    path.join(root, 'desktop', 'src', 'window', 'tab-payload.js'), 'utf8')
  assert.match(payloadSrc, /unread: \(t\.settings && t\.settings\.tabUnread === false\) \? 0 : \(t\.unread \|\| 0\)/)
})

// ---------------------------------------------------------------------------
// 压力
// ---------------------------------------------------------------------------

test('压力：30 个窗口 × 3000 次标题变化 —— 只在数值真变时刷新标签栏', async () => {
  const h = harness()
  const N = 30
  const ROUNDS = 3000
  for (let i = 0; i < N; i++) h.addTab()
  let expected = 0
  const t0 = process.hrtime.bigint()
  let seed = 7
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  for (let r = 0; r < ROUNDS; r++) {
    for (const t of h.tabs) {
      const n = rnd() < 0.7 ? (t.unread || 1) : 1 + Math.floor(rnd() * 200)
      if (n !== (t.unread || 0)) expected++
      t.setTitle('(' + n + ') WhatsApp')
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  assert.equal(h.sends(), expected, '标签栏刷新次数必须等于真实变化次数')
  assert.ok(ms < 3000, '9 万次标题事件耗时 ' + ms.toFixed(0) + 'ms，过慢')
  const total = h.tabs.reduce((s, t) => s + t.unread, 0)
  assert.equal(h.badges[h.badges.length - 1], total, '全局角标与各窗口之和一致')
  for (const t of h.tabs) {
    assert.equal(t.view.webContents.listenerCount('page-title-updated'), 1, '监听器不能越挂越多')
  }
  console.log('  9 万次标题事件 ' + ms.toFixed(1) + 'ms，标签栏刷新 ' + h.sends() + ' 次')
})

/**
 * 标题闪烁 + 清零延迟的确定性子测试。
 *
 * 原先写的是"真实循环 1 秒、每 DELAY/3 毫秒翻转一次标题"。
 * 全量并发时事件循环被拖住，最后一次翻转可能整轮都没跑完 ——
 * 于是 `unread` 停在 0，报 `0 !== 2`。这是测试在赌 CPU，不是在验逻辑。
 *
 * 改成显式推演时序：手动翻若干次，再放足够长的空格让它到期。
 * 断言的仍然是"闪烁期间角标不归零、只有清零延迟到期才归零"。
 */
test('标题反复闪烁期间角标保持，只在静默超过清零延迟后归零', async () => {
  const h = harness()
  const t = h.addTab()
  t.setTitle('(2) Messenger')
  assert.equal(t.unread, 2)
  assert.equal(h.sends(), 1)

  // 模拟 Messenger：(2) X 与「某人发来消息」交替出现，间隔远小于清零延迟
  for (let i = 0; i < 6; i++) {
    t.setTitle(i % 2 ? '(2) Messenger' : '李四 给你发了消息')
    await sleep(5)
    assert.equal(t.unread, 2, `第 ${i} 次闪烁后角标被误清`)
  }
  assert.equal(h.sends(), 1, '闪烁不应产生额外刷新')

  // 现在标题稳定为无数字（真的读完了），等清零延迟到期
  t.setTitle('Messenger')
  await sleep(DELAY + 80)
  assert.equal(t.unread, 0, '没人再发消息，延迟到期后必须归零')
  assert.equal(h.sends(), 2)
})

/**
 * 清零窗口只排一次，不随后续无数字标题反复重置。
 *
 * 这是上面那条的分支加强版：平台在"读完"之后还会连续推送不带数字的标题
 * （`Messenger`、`Messenger - 3 条未读`、`Messenger`…）。
 * 如果每条无数字标题都重置定时器，清零就永远排不到期，
 * 角标一直挂着 —— 用户看到"读完了还在提示"。
 */
test('清零窗口期间的后续无数字标题不得重置定时器', async () => {
  const h = harness()
  const t = h.addTab()
  t.setTitle('(3) Messenger')
  t.setTitle('Messenger')          // t=0：排上清零（DELAY=40ms）
  await sleep(25)
  t.setTitle('Messenger 有 1 条未读')  // t=25：间隔 25ms < DELAY，重置后被推到 t=65
  await sleep(30)                  // t=55：正常实现已到期；被重置的实现还没
  assert.equal(t.unread, 0, '定时器被后续无数字标题重置了：清零永远排不到期')
  await sleep(40)
  assert.equal(t.unread, 0)
})

test('压力：大批窗口同时读完再全部关闭 —— 无残留定时器、无多余刷新', async () => {
  const h = harness()
  for (let i = 0; i < 200; i++) h.addTab()
  h.tabs.forEach((t, i) => t.setTitle('(' + (i + 1) + ') WhatsApp'))
  h.tabs.forEach(t => t.setTitle('WhatsApp'))
  h.tabs.slice(0, 100).forEach(t => t.destroy())
  const before = h.sends()
  await sleep(DELAY + 60)
  assert.equal(h.sends() - before, 100, '只有没关的 100 个窗口清零')
  assert.ok(h.tabs.slice(100).every(t => t.unread === 0))
})

test('压力：怪异标题不会让解析出错或卡住', () => {
  const { unreadFromTitle } = harness().api
  const evil = [
    '('.repeat(50000) + '1', ')'.repeat(50000), '(' + '9'.repeat(5000) + ') x',
    '\u0000(3)\u0000', '(-1) x', '(3.5) x', '(０３) x', '🔥'.repeat(10000)
  ]
  const t0 = Date.now()
  for (const s of evil) {
    const n = unreadFromTitle(s)
    assert.ok(Number.isInteger(n) && n >= 0 && n <= 99999, JSON.stringify(s.slice(0, 20)) + ' → ' + n)
  }
  assert.ok(Date.now() - t0 < 200, '解析存在回溯风险')
})
