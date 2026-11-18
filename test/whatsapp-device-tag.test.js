'use strict'

/**
 * 联系人设备标签 —— 页面内采集与渲染的护栏。
 *
 * 这段代码跑在**别人家的页面里**（web.whatsapp.com），出错的代价是
 * 用户聊天界面坏掉。所以这里锁三条硬约束：
 *
 *   1. 只读：不发送、不点击、不改用户消息；
 *   2. 可降级：认不出来必须显示「未知设备」，不能空白、不能抛错；
 *   3. 不阻塞：所有入口都有 try/catch，失败不影响翻译与聊天。
 *
 * 另外锁住规则本身与 device-platform.js 一致 —— 两边是拷贝关系，
 * 改了一边忘了另一边，测试要能红。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const guest = fs.readFileSync(path.join(root, 'desktop', 'guest-inject.js'), 'utf8')
const platform = require('../desktop/src/whatsapp/device-platform')

/** 取出设备采集那一段（两个 ==== 标记之间）。 */
function deviceSection () {
  const start = guest.indexOf('联系人设备来源（2026-11-11）')
  const end = guest.indexOf('==== PEER DEVICE UI END ====')
  assert.ok(start > 0, '找不到设备采集段落')
  assert.ok(end > start, '找不到设备采集段落结束标记')
  return guest.slice(start, end)
}

test('★ 只读：采集段落里没有任何写操作', () => {
  const sec = deviceSection()
  // 这些 API 会改变页面状态或触发网络行为，一个都不能有
  const forbidden = [
    [/\bclick\s*\(/, 'click()'],
    [/\bdispatchEvent\s*\(/, 'dispatchEvent()'],
    [/\bexecCommand\s*\(/, 'execCommand()'],
    [/\bfetch\s*\(/, 'fetch()'],
    [/XMLHttpRequest/, 'XMLHttpRequest'],
    [/\bwindow\.Store\b/, 'window.Store（逆向内部 API，封号高危）'],
    [/\bwebpackChunk/, 'webpackChunk（挖模块系统）'],
    [/\.value\s*=/, '直接赋值 .value（会改输入框）'],
    [/\binsertBefore\s*\(\s*[^)]*msg/i, '往消息节点里插东西']
  ]
  for (const [re, name] of forbidden) {
    assert.ok(!re.test(sec), '采集逻辑里不能出现 ' + name)
  }
})

test('★ 采集只扫当前会话容器，不回退 document', () => {
  const sec = deviceSection()
  // 必须用 conversationScope()（#main），否则左侧会话列表的行会混进来，
  // 把别的联系人的设备当成当前的 —— 这是 chatKind 里踩过的坑。
  assert.ok(/conversationScope\s*\(\s*\)/.test(sec),
    '必须通过 conversationScope() 限定范围')
  assert.ok(!/document\.querySelectorAll\(\s*['"]\[data-id\]/.test(sec),
    '不能直接在 document 上扫 [data-id]')
})

test('★ 认不出来必须返回 unknown 并有中文文案，不能返回 null', () => {
  const sec = deviceSection()
  assert.ok(/PEER_DEVICE\.UNKNOWN/.test(sec), '必须使用 UNKNOWN 常量')
  assert.ok(/unknown:\s*['"]未知设备['"]/.test(sec),
    'unknown 必须有展示文案，否则 UI 上是空白')
})

test('★ 群聊不显示设备标签', () => {
  const sec = deviceSection()
  // 群里几十个人设备不同，"对方的设备"没有意义
  assert.ok(/isGroupChat\s*\(\s*\)/.test(sec) && /removePeerDeviceTag/.test(sec),
    '群聊必须摘掉标签')
})

test('★ 所有入口都有 try/catch（页面内绝不抛错）', () => {
  const sec = deviceSection()
  for (const fn of ['collectPeerDevice', 'renderPeerDeviceTag', 'syncPeerDevice']) {
    const idx = sec.indexOf('function ' + fn)
    assert.ok(idx > 0, '找不到函数 ' + fn)
    // 取函数体前 600 字符，确认里面有 try
    assert.ok(/try\s*\{/.test(sec.slice(idx, idx + 600)),
      fn + ' 必须有 try/catch —— 它在别人家页面里跑')
  }
})

test('★ 日志上报只传设备类型，不传 JID（隐私）', () => {
  const sec = deviceSection()
  // reportPeerDevice 的载荷只能是 device + seen
  const call = /reportPeerDevice\(\s*\{([^}]*)\}/.exec(sec)
  assert.ok(call, '找不到 reportPeerDevice 调用')
  const body = call[1]
  assert.ok(!/jid/i.test(body), '不能把 JID 传给主进程（那是手机号）')
  assert.ok(!/msgId/i.test(body), '不能传原始 msgId')
  assert.ok(/device/.test(body), '必须传 device')
})

test('★ 页面内规则与 device-platform.js 完全一致', () => {
  const sec = deviceSection()

  // 页面内必须是「前缀优先，长度兜底」
  assert.ok(/indexOf\('3A'\)\s*===\s*0/.test(sec), '页面版必须有「3A 开头 = iPhone」')
  assert.ok(/indexOf\('3E'\)\s*===\s*0/.test(sec), '页面版必须有「3E 开头 = 网页版」')
  assert.ok(/indexOf\('3F'\)\s*===\s*0/.test(sec), '页面版必须有「3F 开头 = 电脑版」')
  assert.ok(/\^\(\.\{21\}\|\.\{32\}\)\$/.test(sec), '页面版必须有「21 或 32 位 = 安卓」')

  // 与模块版逐条对拍：两边对同一批样本必须给出同样结论
  const samples = [
    '3EB0B04053AA94DD0BA334',     // 真机 22 位 web
    '3EB0872294EF67F1C4EB',       // 真机 20 位 web（关键回归样本）
    '3A7F2C1D4E5F6A7B8C9D',       // iphone
    '3F1A2B3C4D5E6F7A8B9C',       // desktop
    'A'.repeat(21),                // android
    'B'.repeat(32),                // android
    '2A' + 'C'.repeat(16),         // 18 位 desktop
    '2A327AC82CD56D95E087',       // 20 位无前缀 → unknown
    'XYZ123',
    ''
  ]
  const pageImpl = id => {
    if (!id) return 'unknown'
    if (id.indexOf('3A') === 0) return 'iphone'
    if (id.indexOf('3E') === 0) return 'web'
    if (id.indexOf('3F') === 0) return 'desktop'
    if (/^(.{21}|.{32})$/.test(id)) return 'android'
    if (id.length === 18) return 'desktop'
    return 'unknown'
  }
  for (const s of samples) {
    assert.equal(pageImpl(s), platform.deviceFromMessageId(s),
      '两边规则不一致：' + JSON.stringify(s) + ' → 页面=' + pageImpl(s) +
      ' 模块=' + platform.deviceFromMessageId(s))
  }
})

test('★ 必须同时支持复合 data-id 与裸消息 ID 两种格式', () => {
  const sec = deviceSection()
  assert.ok(/lastIndexOf\('_'\)/.test(sec), '必须检测有没有下划线（区分两种格式）')
  assert.ok(/\/\^\[0-9A-Za-z\]\+\$\//.test(sec),
    '裸 ID 必须做字符集校验，否则聊天列表行会被当成消息')
})

test('★ 裸 ID 拿不到 fromMe 时，必须用气泡 class 判断方向', () => {
  const sec = deviceSection()
  assert.ok(/message-out/.test(sec) && /message-in/.test(sec),
    '新格式没有 fromMe 前缀，必须用 .message-out / .message-in 判断是谁发的')
})

test('★ 前缀判据必须写在长度判据之前', () => {
  const sec = deviceSection()
  const idxPrefix = sec.indexOf("indexOf('3A')")
  const idxLen = sec.indexOf('(.{21}|.{32})')
  assert.ok(idxPrefix > 0 && idxLen > 0, '找不到判据')
  assert.ok(idxPrefix < idxLen,
    '前缀是协议强信号，必须先判 —— 否则 3E 开头的 ID 会被长度规则抢走')
})

test('★ 没有 chat-subtitle 时必须退到 header 挂载', () => {
  const sec = deviceSection()
  // 2026-11-11 真机实测：私聊头部**没有** chat-subtitle
  //   scopeFound ✔ headerFound ✔ subtitleFound ✘
  // 只依赖副标题的话标签永远不出现 —— 功能等于没做。
  assert.ok(/mode:\s*['"]append['"]/.test(sec),
    'peerDeviceAnchor 必须返回 append 模式作为兜底')
  assert.ok(/querySelector\('header'\)/.test(sec),
    '必须能拿到 header（chat-subtitle 的反查父节点就是 header）')
  assert.ok(/anchor\.appendChild\(tag\)/.test(sec),
    '没有副标题时要把标签 append 到 header')
  // 有副标题时仍优先插在它后面（位置更好）
  assert.ok(/mode:\s*['"]after['"]/.test(sec), '有副标题时仍要用 after 模式')
})

test('★ 找已渲染的标签必须限定在 header 内，不能用 anchor.parentNode', () => {
  const sec = deviceSection()
  // anchor 可能是 header 本身，那时 anchor.parentNode 已经跑到 header 外面，
  // 在里面找 .pix-peer-device 找不到 → 每次都会重建标签 → 闪烁。
  assert.ok(/holder\.querySelector\('\.pix-peer-device'\)/.test(sec),
    '必须在 header 范围内查已有标签，避免重复创建')
})

test('★ 必须接进 schedule() 的防抖窗口，不能自己开定时器', () => {
  // 独立定时器会让每次聊天 DOM 变化触发两次重排；共用一个防抖窗口才不会卡
  assert.ok(/syncPeerDevice\(\)/.test(guest), 'syncPeerDevice 必须被调用')
  const sched = /function schedule\(\)[\s\S]{0,400}/.exec(guest)
  assert.ok(sched && /syncPeerDevice\(\)/.test(sched[0]),
    'syncPeerDevice 必须接在 schedule() 里，与翻译扫描共用防抖')
})

test('★ 上报要去重，不能每次 DOM 变化都发 IPC', () => {
  const sec = deviceSection()
  assert.ok(/peerDeviceReported/.test(sec), '必须有上报去重标记')
  assert.ok(/signature\s*===\s*peerDeviceReported/.test(sec),
    '必须比较签名后再决定是否上报')
})
