'use strict'

/**
 * 发送翻译（WhatsApp）—— 「翻译成功才发送」。
 *
 * ## 被修的三个 P0
 *
 * 真机 0.1.12：用户开启「发送翻译」，输入中文按回车，**中文原文被直接发了出去**。
 * 分层跟踪（真 DOM + 真事件路径）定位到三处**互相独立**的缺陷：
 *
 * ### D1 · 装载即崩，拦截器从未挂上（阻断级）
 *
 *     guest-inject.js:63   const historyGate = MessageParser.createHistoryGate()
 *     guest-inject.js:248  var MessageParser = (function () { ... })()
 *
 * `var` 会提升但值是 undefined，第 63 行执行时 MessageParser 还是 undefined →
 * `TypeError: Cannot read properties of undefined (reading 'createHistoryGate')`。
 * preload 脚本一抛错就**整份停摆**：后面所有 `addEventListener` 都不执行 ——
 * keydown / click / scan 全部没有。于是
 *   · Enter 不被拦截 → 中文原文直通 WhatsApp
 *   · 发送按钮不被拦截 → 同上
 *   · scan 不存在 → 群聊自动翻译（auto_receive）也一起死
 *   · 界面毫无提示（错误只进 webContents 控制台）
 *
 * 这一条解释了「发送翻译完全失效」与「群组翻译=自动 不生效」两个看起来无关的
 * 现象 —— 它们是同一个装载错误。
 *
 * ### D2 · 翻译失败时静默降级成"发原文"
 *
 *     const finalText = out ? 译文 : raw
 *     fireSend(box)
 *
 * 超时 / 断网 / 余额不足 / 通道不在套餐里 → `out` 是空串 → 把中文原文发了出去。
 * 用户以为在"发送翻译"，对方收到的是看不懂的中文，而且这一下用户没同意。
 *
 * ### D3 · 发送路径不声明来源
 *
 * `translateText(masked.masked, false)` 只传两个参数，trigger 恒为空串 →
 * `translate_logs.trigger` 里**永远不会出现 manual_send**，事后审计无法归因。
 *
 * ## 怎么测
 *
 * 把**整份** guest-inject.js 跑进 jsdom（不是抽片段），走真实的 keydown / click
 * 事件路径，并挂一个"模拟 WhatsApp 原生发送"的冒泡监听器统计真实发出的内容。
 * 只有这样才测得到 D1（片段抽取式测试永远看不到装载错误）与 D2（发送时机）。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { JSDOM } = require('jsdom')

const root = path.join(__dirname, '..')
const guestSrc = fs.readFileSync(path.join(root, 'desktop', 'guest-inject.js'), 'utf8')
const preloadSrc = fs.readFileSync(path.join(root, 'desktop', 'preload.js'), 'utf8')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const COMPOSER = '<div id="editable-message-text" contenteditable="true" role="textbox" aria-label="Type a message"></div>'
const SEND_BTN = '<button id="send-btn" aria-label="Send" data-icon="wds-ic-send-filled"><span></span></button>'

/** 一对一会话的 #main（@c.us）。 */
const DIRECT_MAIN = '<div id="main"><div id="msg-list"></div><footer>' + COMPOSER + SEND_BTN + '</footer></div>'

/** 群聊的 #main（@g.us）。发送路径不该因为群聊而不同。 */
const GROUP_MAIN = '<div id="main"><div id="msg-list">' +
  '<div class="message-in" role="row" data-id="true_1203630199@g.us_M1">' +
  '<div class="copyable-text"><span class="selectable-text">昨天的会议纪要</span></div></div>' +
  '</div><footer>' + COMPOSER + SEND_BTN + '</footer></div>'

const BASE_PREFS = {
  transRecv: true,
  transSend: true,
  transGroup: false,
  langMine: 'auto',
  langOther: 'auto',
  sendTo: 'en',
  includeZh: false,
  antiRevoke: false,
  // 沉降观察窗默认调到 0：绝大多数用例关心的是"发没发对、发没发两次"，
  // 不需要为每次发送多等 500ms。需要验证漂移时间线的用例显式设成 500。
  sendSettleMs: 0
}

/**
 * 装配真源码 + 真 jsdom。
 *
 * jsdom 的 getBoundingClientRect 全返回 0，而 guest-inject 的 `visible()` 要求
 * 尺寸 > 8 —— 不打桩的话 composerEl() 找不到输入框，测试会在错误的层面上通过。
 *
 * ## 输入框必须按真机建（否则会漏掉整类 P0）
 *
 * 真机输入框是 **React/Lexical 托管编辑器**，两处与朴素打桩相反，曾经把
 * 「[正在翻译中...] 被真实发出」整类问题遮住：
 *
 *   1. `execCommand` **即使什么都没写进去也返回 true**，所以
 *      `writeComposer` 的 `if (!ok)` 兜底永远不会触发 —— 写回失败是**静默**的。
 *      所以这里把编辑器做成有**自己的一份正文**（`editor.model`），
 *      并允许用 `editorHonorsWrite` 指定"第几次写入会被拒"。
 *   2. 原生发送发的是编辑器**内部正文**，不是 DOM。两者一旦分叉，
 *      测试看到干净的 DOM、客户收到脏的正文。
 */
async function mount (opts) {
  const o = opts || {}
  const dom = new JSDOM('<!doctype html><html><body>' + (o.html || DIRECT_MAIN) + '</body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://web.whatsapp.com/'
  })
  const win = dom.window
  const doc = win.document
  win.Element.prototype.getBoundingClientRect = () => ({
    width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0
  })

  const composerForEditor = doc.getElementById('editable-message-text')
  // 托管编辑器：`model` 才是"会被发出去的那一份"，DOM 只是它的投影。
  const editor = {
    model: '',
    attempts: 0,
    accepted: 0,
    // 原生输入计数（0.1.19）：写入只允许走 Chromium 原生编辑命令，
    // 所以这两个计数就是"发送链到底怎么写进去的"最直接的证据。
    nativeClears: 0,
    nativeInserts: 0,
    setModel (text) {
      this.model = text
      if (composerForEditor) composerForEditor.textContent = text
    }
  }
  doc.__editor = editor
  // 让 `composer.textContent` 与编辑器内部正文**始终同步**：
  // 测试里写 `composer.textContent = '你好'` 等于"用户输入"，
  // 而挂载方读到的永远是编辑器真正持有的那一份。
  const nodeText = Object.getOwnPropertyDescriptor(win.Node.prototype, 'textContent')
  Object.defineProperty(composerForEditor, 'textContent', {
    configurable: true,
    enumerable: true,
    get () { return editor.model },
    set (v) { editor.model = String(v == null ? '' : v); nodeText.set.call(composerForEditor, editor.model) }
  })
  /**
   * ★ 0.1.19：页面内改 DOM 的写入通道**已经被移除** ★
   *
   * 真机证据（0.1.18）：`execCommand` 在 WhatsApp 上根本没生效 ——
   * expected=29 字符的译文 vs actual=6 字符的原文，`sawBeforeInput:false`。
   * 所以这里把 `execCommand` 打桩成**必然失败**（不改 model、只返回 true，
   * 与真机一致：调用方拿不到失败信号）。任何还想靠它写入的代码都会立刻暴露。
   */
  doc.execCommand = () => {
    editor.attempts++
    return true
  }

  const translateCalls = []
  const ipc = {
    invoke: (channel, payload) => {
      if (channel === 'translate:guestPrefs') return Promise.resolve(Object.assign({}, BASE_PREFS, o.prefs || {}))
      // ---- 原生输入通道（0.1.19）：模拟主进程的 Chromium 编辑命令 ----
      // 这一步就是真机上"能生效的那条路"：事件由浏览器进程发起 → 编辑器必须认。
      if (channel === 'translate:composerSelectAllDelete') {
        editor.nativeClears++
        editor.setModel('')
        return Promise.resolve({ ok: true, focused: true })
      }
      if (channel === 'translate:composerInsertText') {
        editor.nativeInserts++
        const value = String((payload && payload.text) || '')
        // 允许用例注入"原生插入也被拒"（例如编辑器整体不可用），
        // 但默认是接受的 —— 这正是原生输入与页面内改 DOM 的本质区别。
        const accept = o.nativeHonorsInsert ? o.nativeHonorsInsert(editor.nativeInserts) : true
        if (accept) { editor.accepted++; editor.setModel(value) }
        if (typeof o.afterNativeInsert === 'function') {
          try { o.afterNativeInsert(editor, editor.nativeInserts) } catch (e) {}
        }
        return Promise.resolve({ ok: true, chars: value.length })
      }
      if (channel === 'translate:run') {
        translateCalls.push(payload)
        // 按调用次序依次取响应，用来测「第一次失败、重试成功」这类序列。
        if (Array.isArray(o.responses)) {
          const spec = o.responses[Math.min(translateCalls.length - 1, o.responses.length - 1)]
          if (spec === 'reject') return Promise.reject(new Error('socket hang up'))
          return Promise.resolve(spec)
        }
        if (o.fail === 'reject') return Promise.reject(new Error('socket hang up'))
        if (o.fail) return Promise.resolve({ success: false, code: o.fail, msg: '服务端原文' })
        if (o.slowMs) return new Promise(resolve => setTimeout(() => resolve({ success: true, translation: o.translation || 'Hello there' }), o.slowMs))
        return Promise.resolve({ success: true, translation: o.translation || 'Hello there' })
      }
      return Promise.resolve({ success: true })
    },
    on: () => {},
    removeAllListeners: () => {}
  }
  win.require = () => ({ ipcRenderer: ipc })

  let loadError = null
  try {
    win.eval(guestSrc)
  } catch (e) {
    loadError = e
  }
  // boot() 挂在 DOMContentLoaded 上；真机里 preload 早于页面，路径一致。
  await new Promise(resolve => {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', resolve, { once: true })
    else resolve()
  })
  await sleep(20)

  const composer = doc.getElementById('editable-message-text')
  const sendBtn = doc.getElementById('send-btn')

  // 模拟真实的 WhatsApp：发送动作挂在**冒泡阶段**的容器上。
  // guest-inject 必须在捕获阶段 preventDefault/stopPropagation 才能拦住它。
  const sent = []
  const nativeSend = () => {
    // 发出去的是编辑器**内部正文**（真机行为），不是 DOM。
    const text = String(editor.model || '')
    // 忠实模拟 WhatsApp：输入框为空时不会真的发出消息。
    if (!text.trim()) return
    sent.push(text)
    editor.setModel('')
  }
  composer.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) nativeSend()
  })
  sendBtn.addEventListener('click', nativeSend)

  if (o.prefs) win.__helloPixApplyPrefs(Object.assign({}, BASE_PREFS, o.prefs))

  const pressEnter = (init) => {
    const ev = new win.KeyboardEvent('keydown', Object.assign({
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
    }, init))
    composer.dispatchEvent(ev)
    return ev.defaultPrevented
  }
  const clickSendButton = () => {
    const ev = new win.MouseEvent('click', { bubbles: true, cancelable: true })
    sendBtn.dispatchEvent(ev)
    return ev.defaultPrevented
  }

  return {
    dom, win, doc, composer, translateCalls, sent, loadError, pressEnter, clickSendButton,
    close: () => { try { win.close() } catch (e) {} }
  }
}

/** 提示里的按钮，按文案找。 */
function noticeButton (doc, label) {
  const box = doc.getElementById('pix-send-failure')
  if (!box) return null
  return Array.from(box.querySelectorAll('button')).find(b => b.textContent === label) || null
}

/**
 * 真源码里的 `canonicalizeSendBody()` —— 测试**直接复用**实现，而不是自己再写一份。
 * 自己写一份的话，测试和实现可以一起错，什么也证明不了。
 */
const canonical = (() => {
  const at = guestSrc.indexOf('function canonicalizeSendBody')
  assert.ok(at > 0, '源码里找不到 canonicalizeSendBody')
  const end = guestSrc.indexOf('\n  }', at)
  assert.ok(end > at, '找不到 canonicalizeSendBody 的结尾')
  const fnSrc = guestSrc.slice(at, end + 4) + '\nreturn canonicalizeSendBody'
  // eslint-disable-next-line no-new-func
  return new Function(fnSrc)()
})()

/** 轮询等待条件成立，避免用固定 sleep 造成的偶发失败。 */
async function until (fn, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs == null ? 2000 : timeoutMs)
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(10)
  }
  throw new Error('等待超时：' + (label || '条件未成立'))
}

/** 让所有待处理的微任务/定时器跑完（翻译 + wait(50) + fireSend 都在里面）。 */
async function settle (ms) {
  await sleep(ms == null ? 200 : ms)
}

/**
 * 等「失败提示」真的画出来。
 *
 * 不能用固定 `settle(200)`：失败提示是在 `nativeSetComposer()`（原生写入 +
 * 编辑器沉降轮询）**之后**才画的，而沉降轮询自带真实定时器（下限默认 0 /
 * 上限 400ms，负载下单次 sleep 还会明显超时）。固定等待会让这条 P0 用例在
 * 并行跑全量时偶发假红 —— 而假红会让人不再相信这道闸。
 *
 * 所以这里等"条件成立"而不是等"够久了"：提示真的没画出来时用例仍然会红，
 * 只是多等一会儿，并把原因说清楚。
 */
async function untilSendFailure (h, timeoutMs) {
  await until(() => !!h.doc.getElementById('pix-send-failure'),
    timeoutMs == null ? 5000 : timeoutMs, '失败提示必须画出来（原文已退回输入框）')
  return h.doc.getElementById('pix-send-failure')
}

// ---------------------------------------------------------------------------
// D1 · 装载守卫：整份 preload 必须能在真 DOM 里起来
// ---------------------------------------------------------------------------

test('guest-inject.js 必须能装载完成，不得抛异常', async () => {
  const h = await mount()
  try {
    assert.equal(h.loadError, null,
      'preload 抛错 = 整份脚本停摆，拦截器/扫描/自动翻译全部消失：' + (h.loadError && h.loadError.message))
  } finally { h.close() }
})

test('preload.js 也必须能装载完成（contextBridge / ipcRenderer 打桩）', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' })
  const exposed = {}
  dom.window.require = () => ({
    contextBridge: { exposeInMainWorld: (key, val) => { exposed[key] = val } },
    ipcRenderer: { invoke: () => Promise.resolve(null), send: () => {} }
  })
  let err = null
  try { dom.window.eval(preloadSrc) } catch (e) { err = e }
  try {
    assert.equal(err, null, 'preload.js 装载失败：' + (err && err.message))
    assert.ok(exposed.pix, 'contextBridge 必须真的暴露 pix')
  } finally { dom.window.close() }
})

test('装载之后监听器必须真的挂上：Enter 必须被拦截', async () => {
  const h = await mount()
  try {
    h.composer.textContent = '你好，今天下午三点开会'
    const prevented = h.pressEnter()
    assert.equal(prevented, true,
      'Enter 没被拦截说明 keydown 监听器根本没挂上（正是 D1 的表现：原文直通 WhatsApp）')
  } finally { h.close() }
})

test('源码守卫：不得在 MessageParser 定义之前引用它（D1 回归护栏）', () => {
  const lines = guestSrc.split('\n')
  // 必须锚定"整行就是标记"，否则注释里提到标记名会被误当成真标记。
  const defLine = lines.findIndex(l => /^\s*var MessageParser = \(function/.test(l))
  const endLine = lines.findIndex(l => l.trim() === '// ==== MESSAGE PARSER END ====')
  assert.ok(defLine > 0, '找不到 MessageParser 定义（结构被改了？）')
  assert.ok(endLine > defLine, 'MESSAGE PARSER END 标记必须在定义之后')
  const offenders = []
  for (let i = 0; i < defLine; i++) {
    const code = lines[i].split('//')[0]
    if (/\bMessageParser\s*\./.test(code)) offenders.push((i + 1) + ': ' + lines[i].trim())
  }
  assert.deepEqual(offenders, [],
    'MessageParser 是 var（提升后为 undefined），提前调用会抛 TypeError 并让整份 preload 停摆')
})

// ---------------------------------------------------------------------------
// 成功路径
// ---------------------------------------------------------------------------

test('Enter 发送中文 → 只发 1 条英文译文', async () => {
  const h = await mount({ translation: 'Let us meet at 3 PM today' })
  try {
    h.composer.textContent = '你好，今天下午三点开会'
    assert.equal(h.pressEnter(), true, 'Enter 必须被拦截')
    await settle()
    assert.equal(h.translateCalls.length, 1, '必须恰好调一次翻译接口')
    assert.deepEqual(h.sent, ['Let us meet at 3 PM today'], '对方只该收到一条英文')
    assert.equal(h.composer.textContent, '', '发送之后输入框应当被清空')
  } finally { h.close() }
})

test('英语 → 中文（反向）：只发 1 条中文译文', async () => {
  // 「英语 → 中文」是发送翻译的反方向：输入是英语，输出中文。
  // 这条路径过去完全没有用例 —— 而"不允许只修其中一种发送方式"也包括方向。
  const h = await mount({ prefs: { sendFrom: 'en', sendTo: 'zh' }, translation: '今天下午三点开会' })
  try {
    h.composer.textContent = 'Let us meet at 3 PM today'
    const ev = new h.win.KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
    })
    h.composer.dispatchEvent(ev)
    assert.equal(ev.defaultPrevented, true, 'Enter 必须被拦截')
    await settle()
    assert.equal(h.translateCalls.length, 1, '必须恰好调一次翻译接口')
    assert.equal(h.translateCalls[0].incoming, false, '仍然走的是发送（outgoing）路径')
    assert.deepEqual(h.sent, ['今天下午三点开会'], '对方只该收到一条中文译文')
    assert.equal(h.composer.textContent, '', '发送之后输入框应当被清空')
  } finally { h.close() }
})

test('点击发送按钮与 Enter 结果一致', async () => {
  const h = await mount({ translation: 'Let us meet at 3 PM today' })
  try {
    h.composer.textContent = '你好，今天下午三点开会'
    assert.equal(h.clickSendButton(), true, '点发送按钮也必须被拦截')
    await settle()
    assert.equal(h.translateCalls.length, 1)
    assert.deepEqual(h.sent, ['Let us meet at 3 PM today'])
  } finally { h.close() }
})

test('群聊与私聊的发送路径结果一致', async () => {
  const outcomes = []
  for (const html of [DIRECT_MAIN, GROUP_MAIN]) {
    const h = await mount({ html, translation: 'Hello there' })
    try {
      h.composer.textContent = '你好'
      h.pressEnter()
      await settle()
      outcomes.push({ calls: h.translateCalls.length, sent: h.sent.slice(), trigger: h.translateCalls.map(c => c.trigger) })
    } finally { h.close() }
  }
  assert.deepEqual(outcomes[0], outcomes[1], '发送翻译不该因为群聊/私聊而不同')
  assert.deepEqual(outcomes[0].sent, ['Hello there'])
})

test('连续发送 5 条：每条恰好发送一次译文，一条不漏一条不重', async () => {
  const h = await mount({ translation: 'Hello there' })
  try {
    for (let i = 0; i < 5; i++) {
      h.composer.textContent = '第' + (i + 1) + '条消息'
      h.pressEnter()
      await until(() => h.sent.length === i + 1, 3000, '第 ' + (i + 1) + ' 条发送完成')
    }
    assert.equal(h.translateCalls.length, 5, '5 条不同内容应当调 5 次翻译')
    assert.equal(h.sent.length, 5, '每条只能发送一次')
    h.sent.forEach(s => assert.equal(s, 'Hello there', '发出去的一律是译文'))
  } finally { h.close() }
})

test('已发送的内容不会被重复发送（占位符硬闸）', async () => {
  const h = await mount({ translation: 'Hello there' })
  try {
    h.composer.textContent = '你好'
    h.pressEnter()
    await until(() => h.sent.length === 1, 3000, '第一条发送出去')
    assert.equal(h.sent.length, 1)
    // 发送后输入框已清空，再按一次 Enter 不该产生任何东西
    h.pressEnter()
    await settle()
    assert.equal(h.sent.length, 1, '空输入框不该再发')
    assert.equal(h.translateCalls.length, 1, '也不该重复调接口')
  } finally { h.close() }
})

// ---------------------------------------------------------------------------
// D2 · 失败策略：翻译没成功，一个字节都不许发
// ---------------------------------------------------------------------------

const FAILURES = [
  ['余额不足', 'INSUFFICIENT_CHARS'],
  ['通道不在套餐里', 'ENGINE_NOT_ALLOWED'],
  ['通道未配置', 'ENGINE_NOT_CONFIGURED'],
  ['服务端内部错误', 'INTERNAL_ERROR']
]

for (const [label, code] of FAILURES) {
  test('翻译失败（' + label + ' / ' + code + '）→ 对方什么都收不到', async () => {
    const h = await mount({ fail: code })
    try {
      h.composer.textContent = '你好，今天下午三点开会'
      assert.equal(h.pressEnter(), true, 'Enter 仍然必须被拦截')
      await untilSendFailure(h)
      assert.equal(h.translateCalls.length, 1, '失败是要调接口才知道的')
      assert.deepEqual(h.sent, [], '翻译失败时绝不允许发送任何内容（这就是本次的 P0）')
      assert.equal(h.composer.textContent, '你好，今天下午三点开会', '原文必须退回输入框')
      assert.ok(h.doc.getElementById('pix-send-failure'), '必须给出可见提示')
    } finally { h.close() }
  })
}

test('线路层失败（超时 / 断网 reject）→ 对方什么都收不到', async () => {
  const h = await mount({ fail: 'reject' })
  try {
    h.composer.textContent = '你好，今天下午三点开会'
    h.pressEnter()
    await untilSendFailure(h)
    assert.deepEqual(h.sent, [], '断网时更不能静默发原文')
    assert.equal(h.composer.textContent, '你好，今天下午三点开会')
    assert.ok(h.doc.getElementById('pix-send-failure'))
  } finally { h.close() }
})

test('失败提示必须写明「翻译失败，消息尚未发送」并给两个明确出口', async () => {
  const h = await mount({ fail: 'INSUFFICIENT_CHARS' })
  try {
    h.composer.textContent = '你好'
    h.pressEnter()
    const box = await untilSendFailure(h)
    assert.ok(box, '必须有提示框')
    assert.match(box.textContent, /翻译失败/, '文案要点明是翻译失败')
    assert.match(box.textContent, /尚未发送|没有收到/, '必须告诉用户消息没发出去')
    assert.ok(noticeButton(h.doc, '重试翻译'), '必须提供「重试翻译」')
    assert.ok(noticeButton(h.doc, '发送原文'), '必须提供「发送原文」')
    assert.equal(box.getAttribute('data-pix-ui'), 'send-failure', '必须标记成我们自己的界面')
    assert.ok(box.style.zIndex, '必须浮在最上层，否则会被 WhatsApp 盖住')
  } finally { h.close() }
})

test('「发送原文」必须由用户明确点击才发送，且只发一次', async () => {
  const h = await mount({ fail: 'INSUFFICIENT_CHARS' })
  try {
    h.composer.textContent = '你好，今天下午三点开会'
    h.pressEnter()
    await untilSendFailure(h)
    assert.deepEqual(h.sent, [], '失败时不能自动发')

    const btn = noticeButton(h.doc, '发送原文')
    assert.ok(btn)
    btn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
    await settle(250)

    assert.deepEqual(h.sent, ['你好，今天下午三点开会'], '用户点击后才发原文，且只发一次')
    assert.equal(h.doc.getElementById('pix-send-failure'), null, '点完提示应当消失')
    assert.equal(h.translateCalls.length, 1, '「发送原文」不该再调一次翻译')
  } finally { h.close() }
})

test('「重试翻译」成功 → 发译文；再次失败 → 仍然一个字节都不发', async () => {
  // 第一次失败（余额不足），点重试后仍然失败
  const h = await mount({ fail: 'INSUFFICIENT_CHARS' })
  try {
    h.composer.textContent = '你好'
    h.pressEnter()
    await untilSendFailure(h)
    const btn = noticeButton(h.doc, '重试翻译')
    assert.ok(btn)
    btn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
    // 重试提示是「粘性」的（不会自己消失），所以要等的是"第二次翻译真的回来了"，
    // 不是"提示又出现了一次"。
    await until(() => h.translateCalls.length === 2, 3000, '重试真的再调一次接口')
    await settle()
    assert.deepEqual(h.sent, [], '重试再失败也不能发原文')
    assert.equal(h.translateCalls.length, 2, '重试必须真的再调一次接口')
    assert.ok(h.doc.getElementById('pix-send-failure'), '仍然要给提示')
  } finally { h.close() }
})

test('「重试翻译」在恢复后成功 → 发出译文', async () => {
  const h = await mount({
    responses: [
      { success: false, code: 'INSUFFICIENT_CHARS', msg: '余额不足' },
      { success: true, translation: 'Hello there' }
    ]
  })
  try {
    h.composer.textContent = '你好'
    h.pressEnter()
    await untilSendFailure(h)
    assert.deepEqual(h.sent, [], '第一次失败：不发')
    assert.ok(noticeButton(h.doc, '重试翻译'))

    noticeButton(h.doc, '重试翻译').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
    await until(() => h.sent.length > 0, 3000, '重试成功并发送')
    assert.deepEqual(h.sent, ['Hello there'], '重试成功后发出的必须是译文')
    assert.equal(h.translateCalls.length, 2, '重试必须真的再调一次接口')
    assert.equal(h.doc.getElementById('pix-send-failure'), null, '重试成功后提示应当消失')
  } finally { h.close() }
})

test('提示里的按钮不会被误判成「点了发送」（自噬保护）', async () => {
  const h = await mount({ fail: 'INSUFFICIENT_CHARS' })
  try {
    h.composer.textContent = '你好'
    h.pressEnter()
    const box = await untilSendFailure(h)
    const before = h.translateCalls.length
    // 点「重试翻译」之外的地方：点提示框本体不该触发发送翻译
    box.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
    await settle()
    assert.deepEqual(h.sent, [], '点提示框本体不该发出任何东西')
    assert.equal(h.translateCalls.length, before, '不该多调接口')
  } finally { h.close() }
})

// ---------------------------------------------------------------------------
// 不许破坏其它发送方式
// ---------------------------------------------------------------------------

test('Shift+Enter 换行：不拦截、不翻译、不发送', async () => {
  const h = await mount()
  try {
    h.composer.textContent = '你好'
    assert.equal(h.pressEnter({ shiftKey: true }), false, 'Shift+Enter 必须放行换行')
    await settle()
    assert.equal(h.translateCalls.length, 0)
    assert.deepEqual(h.sent, [])
  } finally { h.close() }
})

test('中文输入法 composition 状态的 Enter：不拦截', async () => {
  const h = await mount()
  try {
    h.composer.textContent = '你好'
    assert.equal(h.pressEnter({ isComposing: true }), false, '确认候选词的 Enter 不能被当成发送')
    await settle()
    assert.equal(h.translateCalls.length, 0)
    assert.deepEqual(h.sent, [])
  } finally { h.close() }
})

test('发送翻译关闭时：不拦截，原文照常发送', async () => {
  const h = await mount({ prefs: { transSend: false } })
  try {
    h.composer.textContent = '你好'
    assert.equal(h.pressEnter(), false, '关掉发送翻译就不该拦')
    await settle()
    assert.equal(h.translateCalls.length, 0)
    assert.deepEqual(h.sent, ['你好'], '这是用户自己关的功能，原样发送')
  } finally { h.close() }
})

test('英文发英文（目标语言相同）：不拦截、不调接口', async () => {
  const h = await mount()
  try {
    h.composer.textContent = 'hello there'
    assert.equal(h.pressEnter(), false, '同语言不需要翻译，直接放行')
    await settle()
    assert.equal(h.translateCalls.length, 0)
    assert.deepEqual(h.sent, ['hello there'])
  } finally { h.close() }
})

test('纯表情消息：不拦截、不调接口', async () => {
  const h = await mount()
  try {
    h.composer.textContent = '😀😀'
    h.pressEnter()
    await settle()
    assert.equal(h.translateCalls.length, 0)
  } finally { h.close() }
})

// ---------------------------------------------------------------------------
// API 慢：译文没回来之前，一个中文都不许漏出去
// ---------------------------------------------------------------------------

test('API 慢 5 秒：5 秒内对方收不到中文原文', async () => {
  const h = await mount({ slowMs: 5000, translation: 'Hello there' })
  try {
    h.composer.textContent = '你好，今天下午三点开会'
    assert.equal(h.pressEnter(), true)
    // 5 秒里多次取样：任何一次看见原文都是 P0
    const started = Date.now()
    for (const at of [300, 1000, 2000, 3500, 4800]) {
      const remain = at - (Date.now() - started)
      if (remain > 0) await sleep(remain)
      assert.deepEqual(h.sent, [], '翻译没回来之前绝不能发原文（第 ' + at + 'ms 采样）')
    }
    // 响应回来之后才发送，且发的是译文
    await until(() => h.sent.length > 0, 4000, '译文回来之后发送')
    assert.deepEqual(h.sent, ['Hello there'], '发出去的必须是译文，不是原文')
  } finally { h.close() }
})

// ---------------------------------------------------------------------------
// D3 · 计费归因：trigger 必须是 manual_send
// ---------------------------------------------------------------------------

test('发送翻译必须以 trigger=manual_send 上报（translate_logs 归因）', async () => {
  const h = await mount({ translation: 'Hello there' })
  try {
    h.composer.textContent = '你好'
    h.pressEnter()
    await settle()
    assert.equal(h.translateCalls.length, 1)
    assert.equal(h.translateCalls[0].trigger, 'manual_send',
      '发送翻译是「用户按了发送」，既不是 manual_click 也不是 auto_receive')
    assert.equal(h.translateCalls[0].incoming, false, '发送翻译是 outgoing')
  } finally { h.close() }
})

test('源码守卫：提取标记必须整份各出现一次（否则 indexOf 抽取会错位）', () => {
  // 这些 BEGIN/END 标记是别的测试用来抽取代码块的锚点。在别处的注释里提到
  // 标记原文，会让 indexOf 找到错误的位置 —— 01 次事故就是 `historyGate` 的
  // 注释里写了 MESSAGE PARSER END 的原文，导致三个解析器测试集体报"标记被删了"。
  for (const marker of [
    '// ==== MESSAGE PARSER BEGIN ====',
    '// ==== MESSAGE PARSER END ====',
    '// ==== TRANSLATE FAILURE NOTICE BEGIN ====',
    '// ==== TRANSLATE FAILURE NOTICE END ====',
    '// ==== SEND FAILURE NOTICE BEGIN ====',
    '// ==== SEND FAILURE NOTICE END ===='
  ]) {
    const count = guestSrc.split(marker).length - 1
    assert.equal(count, 1, marker + ' 必须恰好出现 1 次（实际 ' + count + ' 次）')
  }
})

test('源码守卫：deliverSend 必须把 TRIGGER_SEND 传进带错误码的翻译调用', () => {
  assert.match(guestSrc, /const TRIGGER_SEND = 'manual_send'/,
    'TRIGGER_SEND 必须存在且等于 manual_send')
  const body = guestSrc.slice(guestSrc.indexOf('async function deliverSend'), guestSrc.indexOf('function scrubBusy'))
  assert.ok(body.length > 0, '找不到 deliverSend')
  // 发送链必须用**带错误码**的版本：统一压成"翻译失败"会把余额不足/断线/
  // 空结果全糊掉，真机取证与用户提示都看不出死在哪一步（收口要求：不许吞错）。
  assert.match(body, /translateTextDetailed\(\s*[\s\S]*?TRIGGER_SEND\s*\)/,
    'deliverSend 必须把 TRIGGER_SEND 传给 translateTextDetailed，否则 trigger 恒为空串')
  assert.match(body, /code:\s*code/,
    'deliverSend 失败提示必须带上真实错误码，不许用统一文案掩盖')
})

test('manual_send 必须在服务端 trigger 白名单里（否则落库被 CHECK 拒绝）', () => {
  const migration = fs.readFileSync(path.join(root, 'migrations', '042_translate_log_trigger.js'), 'utf8')
  assert.match(migration, /'manual_send'/, "042 的 CHECK 约束必须收下 'manual_send'")
})

// ---------------------------------------------------------------------------
// 计费：每次成功只产生一次请求
// ---------------------------------------------------------------------------

test('一次成功发送只调用一次翻译接口（只扣一次字符）', async () => {
  const h = await mount({ translation: 'Hello there' })
  try {
    h.composer.textContent = '你好'
    h.pressEnter()
    await settle()
    assert.equal(h.translateCalls.length, 1, '一次发送只该产生一次计费请求')
  } finally { h.close() }
})

test('失败不产生成功计费：接口被调但没拿到译文，且不发送', async () => {
  const h = await mount({ fail: 'INSUFFICIENT_CHARS' })
  try {
    h.composer.textContent = '你好'
    h.pressEnter()
    await settle()
    assert.equal(h.translateCalls.length, 1)
    assert.deepEqual(h.sent, [], '失败不计费也不发送')
  } finally { h.close() }
})

test('并发重复按 Enter 只产生一次请求（占位符硬闸去重）', async () => {
  const h = await mount({ slowMs: 200, translation: 'Hello there' })
  try {
    h.composer.textContent = '你好'
    h.pressEnter()
    h.pressEnter()
    h.pressEnter()
    await settle(500)
    assert.equal(h.translateCalls.length, 1, '翻译进行中重复按 Enter 不能重复计费')
    assert.equal(h.sent.length, 1, '也不能重复发送')
  } finally { h.close() }
})

// ---------------------------------------------------------------------------
// D4 · 崩溃兜底：拦截流程**中途抛错**，也绝不放行
// ---------------------------------------------------------------------------
// 这与 D1 是同一族的失效：不是"翻错了"，而是"根本没拦"。
//
// `runIntercept` 里 `preventDefault()` 在第一个 await 之前同步执行，所以已经进到
// 翻译流程的那一下是安全的；但在它**之前**的每一步（readComposer / detectLang /
// maskUrls / hasTranslatableText）只要抛一次，就是一个 unhandled rejection：
// preventDefault 还没执行，这一下 Enter 直接落到 WhatsApp 的发送逻辑上 ——
// 中文原文出网，而且界面上一点反应都没有。
//
// 所以规矩必须是：抛错 = 拦下 + 提示，不依赖"翻译流程自己不抛错"。

test('拦截流程抛错 → Enter 仍被拦下，且一个字节都不发', async () => {
  const h = await mount()
  try {
    h.composer.textContent = '你好，今天下午三点开会'
    h.win.__helloPixFaultInject = () => { throw new Error('模拟解析器遇到没见过的 DOM') }
    const prevented = h.pressEnter()
    await settle()
    assert.equal(prevented, true, '抛错也必须 preventDefault —— 否则原文直通 WhatsApp')
    assert.deepEqual(h.sent, [], '抛错时绝不允许发送任何内容')
    assert.equal(h.translateCalls.length, 0, '连翻译都没走到，不该产生请求')
  } finally { h.close() }
})

test('拦截流程抛错 → 点发送按钮同样被拦下（不允许只修 Enter）', async () => {
  const h = await mount()
  try {
    h.composer.textContent = '你好，今天下午三点开会'
    h.win.__helloPixFaultInject = () => { throw new Error('boom') }
    const prevented = h.clickSendButton()
    await settle()
    assert.equal(prevented, true, '发送按钮是 Enter 之外唯一的出口，处理必须一致')
    assert.deepEqual(h.sent, [])
  } finally { h.close() }
})

test('拦截流程抛错 → 原文退回输入框，并给出可操作提示', async () => {
  const h = await mount()
  try {
    h.composer.textContent = '你好，今天下午三点开会'
    h.win.__helloPixFaultInject = () => { throw new Error('boom') }
    h.pressEnter()
    const box = await untilSendFailure(h)
    // 崩溃兜底这条路的原文还原是**异步且不被 await** 的（`nativeSetComposer().catch()`），
    // 所以提示框会先出现、原文晚一拍才回填。这里必须等"还原完成"，不是等"够久了"。
    await until(() => h.composer.textContent === '你好，今天下午三点开会', 3000, '原文必须退回输入框')
    assert.equal(h.composer.textContent, '你好，今天下午三点开会', '原文必须退回输入框')
    assert.ok(box, '异常不能是静默的 —— 必须有可见提示')
    assert.ok(noticeButton(h.doc, '重试翻译'), '必须能重试')
    assert.ok(noticeButton(h.doc, '发送原文'), '「发送原文」必须由用户明确点击')
  } finally { h.close() }
})

test('抛错解除后重试可以正常发送译文（兜底不能把功能一起禁掉）', async () => {
  const h = await mount({ translation: 'Hello there' })
  try {
    h.composer.textContent = '你好'
    h.win.__helloPixFaultInject = () => { throw new Error('boom') }
    h.pressEnter()
    await untilSendFailure(h)
    assert.deepEqual(h.sent, [], '第一次被兜底拦下')

    h.win.__helloPixFaultInject = null
    const btn = noticeButton(h.doc, '重试翻译')
    assert.ok(btn, '必须能重试')
    btn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
    await settle(300)
    assert.deepEqual(h.sent, ['Hello there'], '故障排除后必须能正常发出译文')
  } finally { h.close() }
})

test('源码守卫：三个发送入口都必须走 safeIntercept，不得直接调决策函数', () => {
  const hits = guestSrc.split('decideIntercept(').length - 1
  assert.equal(hits, 2,
    'decideIntercept 只允许出现在「定义」和 safeIntercept 内部各一次；' +
    '事件处理器里直接调用它，等于放弃崩溃兜底')
  assert.match(guestSrc, /function safeIntercept\(/, 'safeIntercept 必须存在')
  for (const entry of ['onKeyDown', 'onBeforeInput', 'onClick']) {
    const body = guestSrc.slice(guestSrc.indexOf('function ' + entry + '('))
    const end = body.indexOf('\n  }')
    assert.ok(/safeIntercept\(/.test(body.slice(0, end)),
      entry + ' 必须走 safeIntercept（否则这一步抛错就会放行原文）')
  }
})

test('源码守卫：决策阶段必须是同步函数（async 的抛错会晚一个微任务，来不及拦）', () => {
  assert.match(guestSrc, /\n  function decideIntercept\(event, box\) \{/,
    'decideIntercept 必须是同步函数：async 会把抛错变成 rejected promise，' +
    '而 WhatsApp 的原生发送在冒泡阶段早已执行完 —— 这正是 0.1.12 "没拦住"的根子')
  assert.doesNotMatch(guestSrc, /async function decideIntercept/,
    'decideIntercept 一旦变成 async，preventDefault 就再也不是同步的')
})

test('源码守卫：兜底外壳必须同时盖住同步抛错与异步 reject', () => {
  const body = guestSrc.slice(guestSrc.indexOf('function safeIntercept('))
  const end = body.indexOf('\n  function onInterceptCrash')
  const shell = body.slice(0, end > 0 ? end : 1600)
  assert.match(shell, /try\s*\{/, '决策阶段的同步抛错要能被抓住')
  assert.match(shell, /\.catch\(/, '投递阶段 async 函数的 reject 也必须挂上 catch')
  const crash = guestSrc.slice(guestSrc.indexOf('function onInterceptCrash('))
  assert.match(crash.slice(0, 1600), /event\.preventDefault\(\)/,
    '兜底路径必须自己 preventDefault —— 此时拦截还没发生过')
})

// ---------------------------------------------------------------------------
// D1 观测面 · 桥健康看门狗：装载失败必须留痕 + 让用户看见
// ---------------------------------------------------------------------------
// 0.1.12 能把客户坑到底，是因为 preload 装载即崩之后**一点痕迹都没有**：
// 界面照常可用，日志一片空白，只能靠用户复述。修掉 D1 之外，还要保证
// 这类失效永远不会再"静默"。

test('main.js 必须有 preload-error 监听（装载失败要进客户端日志）', () => {
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  assert.match(main, /on\('preload-error'/, 'preload 装载失败必须留痕')
  assert.match(main, /clientLog\.error\('preload'/, '必须以 error 级别写进客户端日志')
})

test('main.js 必须用「guest 是否来问 prefs」判断桥是否活着', () => {
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  const handler = main.slice(main.indexOf("ipcMain.handle('translate:guestPrefs'"))
  assert.match(handler.slice(0, 400), /bridgeReport\(\s*tab\.id,\s*true/,
    'guest 能问到 prefs = preload 真的跑起来了，这是最可靠的存活证据')
})

test('main.js 必须有看门狗：到点没通信就判桥未启动', () => {
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  assert.match(main, /function watchdogBridge\(/)
  assert.match(main, /BRIDGE_PROBE_MS/)
  assert.match(main, /未启动/, '必须给出人能看懂的结论')
})

test('主进程必须能在 guest 页面里画警告条（渲染层 DOM 会被原生视图盖住）', () => {
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  assert.match(main, /require\('\.\/bridge-warning'\)/,
    '渲染层弹窗会被 WebContentsView 挡住，警告必须从主进程注入 guest 页面')
  assert.match(main, /showBridgeWarning\(/, '必须调用注入实现')
  assert.ok(!main.includes('executeJavaScript('),
    'main.js 里不得出现 page world 的 executeJavaScript（见 desktop-security 测试）')

  const mod = fs.readFileSync(path.join(root, 'desktop', 'bridge-warning.js'), 'utf8')
  assert.match(mod, /executeJavaScriptInIsolatedWorld/, '必须走隔离世界')
  assert.ok(!/\.executeJavaScript\s*\(/.test(mod), '不得使用 page world 的 executeJavaScript')
  assert.match(mod, /pix-bridge-down/, '警告条要有固定 id 才能幂等')
  assert.match(mod, /data-pix-ui/, '警告条必须标记成我们自己的界面，不能被采集/解析')
  assert.match(mod, /未经翻译直接发出/, '必须明说风险：消息可能未经翻译直接发出')
  assert.match(mod, /__pixBridgeWarnShown/, '必须幂等，不能重复叠一堆警告条')

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('bridge-warning.js'),
    'bridge-warning.js 不在 build.files 里，打包后会缺失导致启动即崩')
})

test('警告条文案必须转义实例名与原因（不能被页面数据带进注入）', () => {
  const mod = require(path.join(root, 'desktop', 'bridge-warning.js'))
  const script = mod.buildScript({ name: "a');alert(1);//", reason: 'x</script>' })
  assert.ok(!script.includes("alert(1)'),"),
    '实例名必须经 JSON.stringify 转义，不能原样拼进脚本')
  assert.match(script, /a'\);alert\(1\);\/\//, '转义后仍应保留原文，只是变成字符串字面量')
})

test('侧边栏必须能标出「翻译桥未启动」的窗口', () => {
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  assert.match(main, /bridgeDown:\s*bridgeHealth/, 'tabPayload 必须带上 bridgeDown')
  const app = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'app.js'), 'utf8')
  assert.match(app, /tab\.bridgeDown/, '侧边栏必须据此打标记')
})

test('preload 必须把桥健康暴露给渲染层', () => {
  assert.match(preloadSrc, /bridgeStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('translate:bridgeStatus'\)/)
  assert.match(preloadSrc, /onBridgeDown:/)
})

test('销毁窗口必须清掉看门狗定时器与健康记录（不泄漏）', () => {
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  const body = main.slice(main.indexOf('function destroyTab('))
  const end = body.indexOf('\n}')
  const head = body.slice(0, end)
  assert.match(head, /clearTimeout\(tab\.bridgeTimer\)/, '定时器必须清掉')
  assert.match(head, /bridgeHealth\.delete\(tab\.id\)/, '健康记录必须清掉')
})

// ---------------------------------------------------------------------------
// 发版闸门自身：执行级校验必须真的能跑、且真的会拦
// ---------------------------------------------------------------------------
// 0.1.12 事故的根因之一是"检查方式不对"（搜关键字）。所以闸门本身也要有守卫：
// 一旦它被改坏（跑不起来、或者永远通过），下一个 0.1.12 就会照样发出去。

test('发版闸门：verify-preload-load.js 在源码模式下必须通过', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify-preload-load.js'), '--source'], {
    cwd: root, encoding: 'utf8'
  })
  assert.equal(result.status, 0,
    '执行级校验没通过 —— 这是发版闸门，必须修好才能发：\n' + String(result.stdout || '') + String(result.stderr || ''))
  assert.match(String(result.stdout || ''), /全部 \d+ 项通过/, '必须给出明确的通过结论')
})

test('发版闸门：必须是「执行」而不是「搜关键字」', () => {
  const gate = fs.readFileSync(path.join(root, 'scripts', 'verify-preload-load.js'), 'utf8')
  assert.match(gate, /win\.eval\(src\)/, '必须真的把 preload 跑起来（0.1.12 那次关键字全在，照样是死的）')
  assert.match(gate, /dispatchEvent/, '必须派发真实事件，才能验证监听器有没有挂上')
  assert.match(gate, /defaultPrevented/, '必须检查 preventDefault 是否真的生效')
  assert.match(gate, /process\.exit\(1\)/, '不通过必须以非 0 退出，否则 CI/发版流程看不出来')
})

test('发版闸门：必须覆盖模块齐全性与版本号', () => {
  const gate = fs.readFileSync(path.join(root, 'scripts', 'verify-preload-load.js'), 'utf8')
  assert.match(gate, /REQUIRED_MODULES/, '少一个本地模块 = 启动即崩，必须在闸门里挡住')
  assert.match(gate, /产物版本号与源码一致/, '验收过的是 A 版、发出去的是 B 版，必须挡')
})

test('发版闸门：崩溃兜底必须也在闸门里（不只是单测里）', () => {
  const gate = fs.readFileSync(path.join(root, 'scripts', 'verify-preload-load.js'), 'utf8')
  assert.match(gate, /crash/, '必须能注入故障')
  assert.match(gate, /崩溃兜底：抛错时对方什么都收不到/, '发版闸门必须亲自验证这条不变量')
})

// ---------------------------------------------------------------------------
// 发送链的数据丢失三连 —— 都不外发占位符，但都会**弄丢用户内容**，
// 真机表现是"我按了没反应""我打了一半自己没了"，比报错更难排查。
// ---------------------------------------------------------------------------

test('翻译期间用户打新消息 → 立即中止发送，绝不覆盖用户新草稿', async () => {
  // 用户在等翻译时开始打**下一条**。老实现直接 writeAndVerify(译文) 把草稿
  // 整段覆盖，翻译回来那一下用户正在打的内容凭空消失（真机已复现）。
  //
  // ★ 0.1.19 定案策略 ★：发现草稿被用户改过 → **立即中止**。
  //   这一条不发送，也**一个字节都不碰**用户的新输入。
  //   绝不允许"为了把这条发出去"而先覆盖草稿、事后再想办法放回去 ——
  //   放不回去就是数据丢失。宁可漏发一条，也不许吃掉用户正在打的内容。
  const h = await mount({ slowMs: 300, translation: 'Hello there' })
  try {
    h.composer.textContent = '你好，今天下午三点开会'
    h.pressEnter()
    await sleep(120)                       // 翻译还在路上
    const DRAFT = '下一条消息的草稿，千万不要丢'
    h.composer.textContent = DRAFT

    await until(() => !!h.doc.getElementById('pix-translate-notice'), 3000, '中止提示出现')
    await settle(200)

    assert.deepEqual(h.sent, [], '用户已经改了草稿，这一条必须中止，不许发出任何内容')
    assert.equal(String(h.doc.__editor.model || ''), DRAFT,
      '用户的草稿被吃掉了 —— 这是数据丢失，不是"没反应"')
    assert.equal(String(h.composer.textContent || ''), DRAFT, 'DOM 投影也要一致')
    // 全程不许有原生写入：中止路径必须连清空都不做。
    assert.equal(h.doc.__editor.nativeClears, 0, '中止路径不许碰输入框（不许原生清空）')
    assert.equal(h.doc.__editor.nativeInserts, 0, '中止路径不许碰输入框（不许原生插入）')
  } finally { h.close() }
})

test('翻译失败时也不能拿原文盖掉用户正在打的下一条', async () => {
  const h = await mount({ slowMs: 300, fail: 'INSUFFICIENT_CHARS' })
  try {
    h.composer.textContent = '你好，今天下午三点开会'
    h.pressEnter()
    await sleep(120)
    const DRAFT = '草稿不能被失败兜底覆盖'
    h.composer.textContent = DRAFT

    await until(() => !!h.doc.getElementById('pix-send-failure'), 3000, '失败提示出现')
    await settle(150)

    assert.deepEqual(h.sent, [], '失败时一个字节都不能发')
    assert.equal(String(h.doc.__editor.model || ''), DRAFT, '失败兜底 writeComposer(raw) 把草稿盖掉了')
  } finally { h.close() }
})

test('连续快速发送 5 条 → 5 条都发出去（用户回车不许被吞）', async () => {
  // 老实现里 fireSend() 会开一个 400ms 的 suppression 时间窗，把窗口内
  // **任何**发送事件都当成"我们自己发的"吞掉 —— 用户这 400ms 里按的回车没了。
  // 另有一个更隐蔽的：上一条的 400ms phase 复位定时器会清掉下一条正在飞的
  // phase，下一条被 STALE_ACTION 拦下。两者叠加 = 连发几条，中间几条消失。
  const h = await mount({
    responses: [
      { success: true, translation: 'T1' },
      { success: true, translation: 'T2' },
      { success: true, translation: 'T3' },
      { success: true, translation: 'T4' },
      { success: true, translation: 'T5' }
    ]
  })
  try {
    const N = 5
    for (let i = 1; i <= N; i++) {
      h.composer.textContent = '消息内容' + i
      h.pressEnter()
      await sleep(160)
    }
    await until(() => h.sent.length >= N, 4000, '五条全部发出')
    await settle(500)

    assert.equal(h.sent.length, N, '发出了 ' + h.sent.length + ' / ' + N + ' 条，有回车被吞掉了')
    assert.equal(new Set(h.sent).size, N, '每一条都应当是独立的译文')
    assert.equal(h.translateCalls.length, N, '五条各翻一次，不该重复请求')
    for (const t of h.sent) {
      assert.ok(!/翻译中/.test(t), '绝不外发占位符：' + JSON.stringify(t))
    }
  } finally { h.close() }
})

test('suppression 只能是同步窗口 —— 不许用时间去吞用户输入', () => {
  // 把不变量钉在源码上：fireSend 必须在 finally 里复位，且不得再用
  // "setTimeout(..., 400) 之后才复位"的一刀切时间窗。
  const fnAt = guestSrc.indexOf('function fireSend(box)')
  assert.ok(fnAt > 0, '找不到 fireSend')
  // 先剔掉注释：注释里正记着"老实现是 setTimeout(() => suppression = false, 400)"。
  const fn = guestSrc.slice(fnAt, guestSrc.indexOf('function sendButton', fnAt))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  assert.match(fn, /suppression = true/, 'fireSend 必须置位 suppression')
  assert.match(fn, /finally\s*\{[\s\S]*suppression = false/, 'suppression 必须在 finally 里同步复位')
  assert.ok(!/setTimeout\([\s\S]{0,80}suppression = false/.test(fn),
    '不得再用延时窗口复位 suppression —— 那会吞掉用户窗口期内的回车')
})

test('phase 复位定时器必须按 actionId 归属，不许清掉下一条动作', () => {
  const fnAt = guestSrc.indexOf('async function deliverSend')
  assert.ok(fnAt > 0, '找不到 deliverSend')
  const fn = guestSrc.slice(fnAt, guestSrc.indexOf('function composerDraftChanged', fnAt))
  assert.match(fn, /sendActionId === myAction/,
    'phase 复位必须校验 actionId，否则上一条的定时器会清掉下一条正在飞的 phase')
})

// ---------------------------------------------------------------------------
// 0.1.16 Mac 真机 FAIL 的两个 P0 —— 这一组是**行为级**回归，直接钉真机现象。
//
// 真机现象：
//   P0-1  翻译异常 → 点「重试翻译」→ 最终「重试失败」→ 原文退回输入框。
//         failed → retrying → translated → sent 没有闭环。
//   P0-2  消息显示「已翻译」，但绿色译文跑到**整个聊天区域底部**。
//
// 下面用**贴近真实 WhatsApp 的结构**建 DOM（含那条最坑的
// `#msg-list[data-testid="msg-container"]` —— 老 hostOf 正是一路 closest 到这里，
// 才把译文 append 到聊天底部）。
// ---------------------------------------------------------------------------

/** 一条真实感的 WhatsApp 群消息行：行([data-id]) > copyable-text > 正文 span。 */
const WA_ROW =
  '<div class="message-in focusable-list-item" role="row" data-id="true_1203630199@g.us_3EB0ABC">' +
    '<div class="_amk4"><div class="_amk1">' +
      '<div class="copyable-text" data-pre-plain-text="[10:00, 1/1/2026] Bob: ">' +
        '<div class="_akbw"><span class="selectable-text copyable-text" dir="ltr"><span>Hello there</span></span></div>' +
      '</div>' +
    '</div></div>' +
  '</div>'

// #msg-list 故意带上 msg-container：复现"老 hostOf 向上兜底到列表根"的真机环境。
const WA_MAIN = '<div id="main"><div id="msg-list" data-testid="msg-container">' + WA_ROW + '</div>' +
  '<footer>' + COMPOSER + SEND_BTN + '</footer></div>'

// 群聊 + 手动（transGroup 关）= messageAction 返回 'chip'，也就是真机上那个「译」按钮。
const WA_PREFS = { transRecv: true, transSend: true, includeZh: false, langMine: 'zh', transGroup: false }

/**
 * 短消息 fixture（P0-3 真机现场）：正文很短 + 右侧带 WhatsApp 的 metadata（时间/勾）。
 * 真机上入口就是在这块区域被 metadata 盖住的。
 */
const WA_SHORT_ROW =
  '<div class="message-out focusable-list-item" role="row" data-id="true_1203630199@g.us_SHORT1">' +
    '<div class="_amk4"><div class="_amk1">' +
      '<div class="copyable-text" data-pre-plain-text="[10:00, 1/1/2026] Me: ">' +
        '<div class="_akbw"><span class="selectable-text copyable-text" dir="ltr"><span>Hi</span></span></div>' +
        '<div class="MessageMeta message-time"><span>10:00</span><span data-icon="msg-dblcheck"></span></div>' +
      '</div>' +
    '</div></div>' +
  '</div>'

const WA_SHORT_MAIN = '<div id="main"><div id="msg-list" data-testid="msg-container">' + WA_SHORT_ROW + '</div>' +
  '<footer>' + COMPOSER + SEND_BTN + '</footer></div>'

function captureTraces (h) {
  const traces = []
  h.win.console.info = function () {
    traces.push(Array.prototype.slice.call(arguments).join(' '))
  }
  return traces
}

/**
 * ★0.1.23 真机形状★：中文界面的左侧会话列表（header 里有「群组」筛选标签，
 * 列表里还混着别的群）+ 右侧是**私聊**。
 *
 * 老 isGroupChat() 用 `document.querySelector('.ChatInfo, header')` 查**整个文档**，
 * 而 document order 上排在 #main 之前的就是这个左侧列表 header → 命中「群组」
 * → 私聊被判成群 → 自动翻译整个失效，只能手动点「译」。
 */
const WA_ZH_SIDEBAR = '<div id="side"><header><div role="tablist">' +
  '<span>全部</span><span>未读</span><span>收藏</span><span>群组</span></div></header>' +
  '<div data-testid="chat-list">' +
  '<div data-testid="cell-frame-container" data-id="true_1203630199@g.us_1"><span>某个群</span></div>' +
  '</div></div>'

const WA_PRIVATE_MAIN = '<div id="main"><header><h1>Alice</h1></header>' +
  '<div id="msg-list" data-testid="msg-container">' +
    '<div class="message-in focusable-list-item" role="row" data-id="false_8613800138000@c.us_PRIV1">' +
      '<div class="copyable-text" data-pre-plain-text="[10:00, 1/1/2026] Alice: ">' +
        '<div class="_akbw"><span class="selectable-text copyable-text" dir="ltr">' +
          '<span>Hello there, how are you?</span></span></div>' +
      '</div>' +
    '</div>' +
  '</div><footer>' + COMPOSER + SEND_BTN + '</footer></div>'

const WA_ZH_PRIVATE = WA_ZH_SIDEBAR + WA_PRIVATE_MAIN

test('★0.1.23 P0★ 私聊必须自动翻译（左侧列表的「群组」筛选标签不许把私聊判成群）', async () => {
  const h = await mount({ html: WA_ZH_PRIVATE, prefs: WA_PREFS, translation: '你好，你好吗？' })
  try {
    const doc = h.doc
    const traces = captureTraces(h)
    // ★关键：不点任何东西★ 自动翻译必须自己发生。
    await until(() => !!doc.querySelector('.pix-trans'), 3000,
      '私聊没有自动出译文 —— 用户就只能手动点「译」了（真机现象）')
    const box = doc.querySelector('.pix-trans')
    assert.equal(box.textContent, '你好，你好吗？', '自动译文内容不对')
    assert.equal(box.closest('[data-id]'), doc.querySelector('[data-id="false_8613800138000@c.us_PRIV1"]'),
      '译文必须落在这条私聊消息内')
    // 私聊不该只给「译」按钮
    assert.equal(doc.querySelector('.pix-click'), null,
      '私聊出现了手动「译」按钮 —— 说明被判成了群（自动翻译被关掉）')
    // 取证：CHAT_KIND 必须打出结论与判据来源
    const kindLine = traces.find(t => t.indexOf('CHAT_KIND') >= 0)
    assert.ok(kindLine, '缺少 CHAT_KIND 取证行')
    assert.match(kindLine, /"group":false/, 'CHAT_KIND 把私聊判成了群：' + kindLine)
    assert.match(kindLine, /"evidence":"dataid:c\.us"/, 'CHAT_KIND 没记正确的判据来源：' + kindLine)
  } finally { h.close() }
})

test('守卫：私聊自动翻译不受「群聊自动翻译」开关影响（transGroup 关也要自动）', async () => {
  const h = await mount({ html: WA_ZH_PRIVATE, prefs: Object.assign({}, WA_PREFS, { transGroup: false }), translation: '你好' })
  try {
    await until(() => !!h.doc.querySelector('.pix-trans'), 3000,
      'transGroup 关闭时私聊就不自动翻了 —— 这个开关只该管群聊')
  } finally { h.close() }
})

test('P0-2：点「译」→ 译文必须落在被点那条消息内，绝不能画到聊天底部/列表根', async () => {
  const h = await mount({ html: WA_MAIN, prefs: WA_PREFS, translation: '你好呀，这条消息' })
  try {
    const doc = h.doc
    const row = doc.querySelector('[data-id]')
    const list = doc.getElementById('msg-list')
    await until(() => !!doc.querySelector('.pix-click'), 3000, '「译」按钮出现')

    doc.querySelector('.pix-click')
      .dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
    await until(() => !!doc.querySelector('.pix-trans'), 3000, '译文出现')

    const box = doc.querySelector('.pix-trans')
    assert.equal(box.textContent, '你好呀，这条消息', '译文内容不对')
    assert.equal(box.closest('[data-id]'), row, '译文必须挂在被点的那条消息行内')
    assert.notEqual(box.parentElement, list,
      '译文直接挂在消息列表根上了 —— 这正是真机"译文跑到聊天底部"的现象')
    assert.notEqual(box.parentElement, doc.getElementById('main'), '#main 是会话根，绝不许当渲染目标')
    assert.equal(box.parentElement.closest('[data-id]'), row,
      '译文的直接父节点也必须在同一条消息内（不许跨到列表/会话根）')
  } finally { h.close() }
})

test('P0-2 fail-closed：精确目标找不到时，宁可什么都不显示，也不许画到别处', async () => {
  const h = await mount({ html: WA_MAIN, prefs: WA_PREFS, slowMs: 260, translation: '你好呀' })
  try {
    const doc = h.doc
    const traces = captureTraces(h)
    await until(() => !!doc.querySelector('.pix-click'), 3000, '「译」按钮出现')
    const chip = doc.querySelector('.pix-click')
    chip.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(80)
    // 模拟列表重绘 / 目标滚出视图：响应回来之前，正文节点已经不在原位了。
    const span = doc.querySelector('.selectable-text')
    if (span) span.remove()
    assert.equal(!!doc.querySelector('.pix-trans'), false, '测试时序：此刻译文还没画出来才对')
    await sleep(900)

    assert.equal(doc.querySelector('.pix-trans'), null,
      '定位不到精确原消息时必须**不显示**，而不是放到页面底部。\n traces=\n' + traces.join('\n') +
      '\n list=' + doc.getElementById('msg-list').innerHTML)
    assert.equal(chip.getAttribute('data-pix-state'), 'fail', '这条消息应被标成翻译失败')
    assert.ok(traces.some(t => t.indexOf('TRANSLATION_RENDER_TARGET_MISSING') >= 0),
      '必须留下 TRANSLATION_RENDER_TARGET_MISSING 取证事件')
    assert.equal(doc.querySelectorAll('.pix-trans').length, 0, '全局不得出现任何漂移的译文节点')
  } finally { h.close() }
})

// 0.1.22 真机缺陷：底层是 NETWORK_UNREACHABLE（连不上服务器），chip 却写死
// 「翻译失败 · 点击重试」，用户一直以为是翻译坏了。失败态必须按真实错误类别说话。
test('失败 chip 按错误类别说话：连不上服务器 ≠ 翻译失败', async () => {
  const h = await mount({ html: WA_MAIN, prefs: WA_PREFS, fail: 'NETWORK_UNREACHABLE' })
  try {
    const doc = h.doc
    await until(() => !!doc.querySelector('.pix-click'), 3000, '「译」按钮出现')
    const chip = doc.querySelector('.pix-click')
    chip.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
    await until(() => chip.getAttribute('data-pix-state') === 'fail', 3000, 'chip 进入失败态')

    assert.match(chip.textContent, /连不上服务器/,
      '网络不可达时必须显示"连不上服务器"，不许退回笼统的"翻译失败"')
    assert.equal(chip.getAttribute('data-pix-fail-code'), 'NETWORK_UNREACHABLE',
      '真实错误码必须钉在 chip 上（取证 + 重试前先看清上次为什么失败）')
    assert.equal(chip.style.pointerEvents, 'auto', '失败后必须仍可点击重试')
  } finally { h.close() }
})

test('失败 chip 兜底：认不出的码仍然显示「翻译失败 · 点击重试」', async () => {
  const h = await mount({ html: WA_MAIN, prefs: WA_PREFS, fail: 'TRANSLATE_FAILED' })
  try {
    const doc = h.doc
    await until(() => !!doc.querySelector('.pix-click'), 3000, '「译」按钮出现')
    const chip = doc.querySelector('.pix-click')
    chip.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
    await until(() => chip.getAttribute('data-pix-state') === 'fail', 3000, 'chip 进入失败态')
    assert.equal(chip.textContent, '翻译失败 · 点击重试', '服务端翻译失败仍用默认文案')
  } finally { h.close() }
})

test('P0-2 守卫：路径漂移后命中我们自己的控件时也必须拒绝绘制', async () => {
  // 索引路径在 DOM 变动后会漂移 —— 最坏情况会命中 chip 自身（已复现）。
  // 渲染前必须验证"命中的仍是 .selectable-text 正文且不在我们自己的 UI 里"。
  const h = await mount({
    html: WA_MAIN,
    prefs: WA_PREFS,
    responses: [
      { success: true, translation: '你好呀' },
      { success: true, translation: '你好呀' }
    ]
  })
  try {
    const doc = h.doc
    const row = doc.querySelector('[data-id]')
    await until(() => !!doc.querySelector('.pix-click'), 3000, '「译」按钮出现')
    const chip = doc.querySelector('.pix-click')
    // 把正文节点挪走，让原路径落到 chip 上。
    const span = doc.querySelector('.selectable-text')
    span.parentElement.removeChild(span)
    chip.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(500)
    assert.equal(doc.querySelector('.pix-trans'), null,
      '路径漂移到我们自己的控件上时，绝不能把译文画进去')
    assert.equal(row.querySelector('.pix-trans'), null, '该消息行内不该出现译文')
  } finally { h.close() }
})

// ---------------------------------------------------------------------------
// 0.1.18 · P0-1：重试链路报 BODY_MISMATCH
//
// 真机现象：RETRY_TRANSLATE_CLICK → … → INPUT_REPLACED 都过了，最后 BODY_MISMATCH。
// 说明**写入成功之后正文又被改掉**（托管编辑器用自己状态重画 DOM）。
// 修复要点：canonical 只放行无语义差异；不一致就就地重写；仍不一致才 fail-closed。
// ---------------------------------------------------------------------------

const RAW_CN = '你好，今天下午三点开会'
const T9 = 'Hello there'

test('P0-1a：原生插入后编辑器只做「无语义」改写（NBSP/零宽/CRLF）时必须照样发送', async () => {
  let mutated = false
  const h = await mount({
    translation: T9,
    // 原生插入成功后，编辑器把正文换成"等价但字面不同"的写法：NBSP + 零宽 + CRLF。
    afterNativeInsert: (editor, n) => {
      if (n !== 1 || mutated) return
      mutated = true
      editor.setModel(editor.model.replace(/ /g, '\u00a0') + '\u200b' + '\r\n')
    }
  })
  try {
    const traces = captureTraces(h)
    h.composer.textContent = RAW_CN
    h.pressEnter()
    await until(() => h.sent.length >= 1, 6000, '译文发出')
    await settle(400)

    assert.equal(h.sent.length, 1, '必须恰好发出一次（不双发、不丢发）')
    assert.equal(canonical(T9), canonical(h.sent[0]),
      '对方收到的必须与译文**无语义差异**：' + JSON.stringify(h.sent[0]))
    assert.ok(traces.some(t => /FINAL_TEXT_VALIDATED/.test(t) && /"ok":true/.test(t)),
      'FINAL_TEXT_VALIDATED 必须判 ok —— 无语义差异不该被拦下')
    assert.ok(!traces.some(t => t.indexOf('SEND_BODY_MISMATCH_DETAIL') >= 0),
      '无语义差异不该产生 BODY_MISMATCH 取证')
    assert.equal(h.doc.getElementById('pix-send-failure'), null, '不该弹失败提示')
    // ★ 关键：写入必须走原生通道，且**没有**走任何页面内改 DOM 的路子。
    assert.equal(h.doc.__editor.nativeClears, 1, '必须恰好走一次原生清空')
    assert.equal(h.doc.__editor.nativeInserts, 1, '必须恰好走一次原生插入')
    assert.equal(h.doc.__editor.attempts, 0, '绝不允许再退回 execCommand 页面内写入')
  } finally { h.close() }
})

test('P0-1b：原生插入后被编辑器还原成原文 → 第二次原生插入自愈并最终成功发送', async () => {
  let reverted = false
  const h = await mount({
    translation: T9,
    // 第一次原生插入后，编辑器调和把正文**还原成原文**。
    afterNativeInsert: (editor, n) => {
      if (n !== 1 || reverted) return
      reverted = true
      setTimeout(() => { editor.setModel(RAW_CN) }, 10)
    }
  })
  try {
    const traces = captureTraces(h)
    h.composer.textContent = RAW_CN
    h.pressEnter()
    await until(() => h.sent.length >= 1, 6000, '译文发出')
    await settle(400)

    assert.equal(h.sent.length, 1, '必须恰好发出一次最终译文（不双发、不发原文）')
    assert.notEqual(h.sent[0], RAW_CN, '绝不能把中文原文发出去')
    assert.equal(canonical(T9), canonical(h.sent[0]), '发出的必须是译文')
    assert.ok(traces.some(t => t.indexOf('NATIVE_INPUT_RETRY') >= 0),
      '必须留下"第二次原生插入"的证据 —— 这是重试闭环的关键动作')
    assert.equal(h.doc.__editor.nativeInserts, 2, '应当插入两次（第二次把正文救回来）')
    assert.equal(h.doc.__editor.attempts, 0, '整个过程不允许出现 execCommand 页面内写入')
    assert.equal(h.doc.getElementById('pix-send-failure'), null, '最终成功了，不该留失败提示')
  } finally { h.close() }
})

test('P0-1c：原生插入也被拒（真实内容变化）必须 fail-closed，一个字节都不发', async () => {
  const h = await mount({
    translation: T9,
    // 编辑器整体拒绝插入 → 回读到的一直是原文（真实语义差异，不是空白差异）。
    nativeHonorsInsert: () => false
  })
  try {
    const traces = captureTraces(h)
    h.composer.textContent = RAW_CN
    h.pressEnter()
    await until(() => !!h.doc.getElementById('pix-send-failure'), 6000, '失败提示出现')
    await settle(300)

    assert.deepEqual(h.sent, [], 'canonical 后仍不一致 → 禁止发送任何内容')
    const notice = h.doc.getElementById('pix-send-failure')
    assert.match(notice.textContent, /BODY_MISMATCH/, '必须把真实错误码露出来，不许用笼统文案掩盖')
    assert.ok(traces.some(t => t.indexOf('SEND_BODY_MISMATCH_DETAIL') >= 0),
      'BODY_MISMATCH 必须留下完整差异取证')
    const detail = traces.find(t => t.indexOf('SEND_BODY_MISMATCH_DETAIL') >= 0)
    // 取证字段必须齐全（0.1.19 起 head/tail 原文改为字符码，避免整行被脱敏）。
    for (const field of ['expected', 'actual', 'firstDiffRaw', 'boxTag', 'writeMethod',
      'actualCodes', 'trustedEvent']) {
      assert.ok(detail.indexOf(field) >= 0, '取证字段缺失：' + field)
    }
    // ★ 关键：绝不泄漏消息原文（0.1.18 真机就因为 payload 带原文，整行被脱敏成
    //   <已脱敏长串>，连事件名都看不见，真机分诊直接失效）。
    assert.ok(detail.indexOf(RAW_CN) < 0, 'trace 里不许出现原文 —— 否则整行会被日志脱敏器打掉')
    assert.ok(detail.indexOf(T9) < 0, 'trace 里不许出现译文原文')
    // 原生插入被拒 → 走满两次尝试后 fail-closed。
    // （不按"总插入次数"断言：失败兜底还会把原文还原回去，那也是原生插入。）
    const begin = traces.filter(t => t.indexOf('NATIVE_TEXT_INSERTED') >= 0)
    assert.ok(begin.some(t => /"attempt":1/.test(t)) && begin.some(t => /"attempt":2/.test(t)),
      '必须能看到两次原生插入尝试（attempt=1 / attempt=2）')
    assert.equal(h.doc.__editor.attempts, 0, '不允许退回 execCommand 页面内写入')
  } finally { h.close() }
})

test('P0-1d：写进去之后必须逐点采样（0/100/300/500ms），能看出正文有没有漂移', async () => {
  // 这个用例专门验证"漂移时间线"能力 —— 必须把观察窗开到 500ms。
  const h = await mount({ translation: T9, prefs: { sendSettleMs: 500 } })
  try {
    const traces = captureTraces(h)
    h.composer.textContent = RAW_CN
    h.pressEnter()
    await until(() => h.sent.length >= 1, 6000, '译文发出')
    await settle(400)

    // 关键 trace 顺序（本轮要求的第一份证据）。
    const order = ['NATIVE_INPUT_BEGIN', 'COMPOSER_CLEARED', 'NATIVE_TEXT_INSERTED',
      'LEXICAL_SETTLED', 'FINAL_TEXT_VALIDATED', 'PROGRAMMATIC_SEND_BEGIN', 'PROGRAMMATIC_SEND_DONE']
    const events = traces.map(t => (t.match(/\[PIX_TRACE\] (\w+)/) || [])[1]).filter(Boolean)
    let cursor = -1
    for (const ev of order) {
      const at = events.indexOf(ev, cursor + 1)
      assert.ok(at > cursor, '关键 trace 顺序不对：' + ev + ' 应出现在 ' + (events[cursor] || '开头') +
        ' 之后。实际序列=' + events.join(' → '))
      cursor = at
    }
    // 逐点漂移采样：0 / 100 / 300 / 500ms 四个标记都要有。
    const samples = traces.filter(t => t.indexOf('COMPOSER_DRIFT_SAMPLE') >= 0)
    const marks = samples.map(t => Number((t.match(/"mark":(\d+)/) || [])[1]))
    for (const m of [0, 100, 300, 500]) {
      assert.ok(marks.indexOf(m) >= 0, '缺少 ' + m + 'ms 的漂移采样：' + JSON.stringify(marks))
    }
    // LEXICAL_SETTLED 必须报告"稳定且与预期一致"。
    const settled = traces.find(t => t.indexOf('LEXICAL_SETTLED') >= 0)
    assert.ok(settled, '缺少 LEXICAL_SETTLED')
    assert.match(settled, /"canonicalEqual":true/, 'LEXICAL_SETTLED 应当报告 canonical 一致')
    assert.ok(!traces.some(t => t.indexOf('SEND_BODY_MISMATCH_DETAIL') >= 0), '正常路径不该有 mismatch')
  } finally { h.close() }
})

test('P0-1 守卫：canonicalizeSendBody 只放行无语义差异，真实变化必须判不等', () => {
  // 允许抹掉：CRLF/LF、NBSP 等不可见空格、零宽字符、Unicode 归一化。
  assert.equal(canonical('a\u00a0b'), canonical('a b'), 'NBSP 应等价于普通空格')
  assert.equal(canonical('a\r\nb'), canonical('a\nb'), 'CRLF 应等价于 LF')
  assert.equal(canonical('a\u200bb'), canonical('ab'), '零宽字符应被清理')
  assert.equal(canonical('a\u3000b'), canonical('a b'), '全角空格应等价于普通空格')
  assert.equal(canonical('e\u0301'), canonical('\u00e9'), 'Unicode 归一化：合成/分解写法应等价')
  // 绝不允许抹掉：真实文字 / 数字 / 标点 / 换行结构 / URL。
  assert.notEqual(canonical('hello'), canonical('Hello'), '大小写是真实差异，不能忽略')
  assert.notEqual(canonical('价格 10 元'), canonical('价格 100 元'), '数字变化是真实差异，不能忽略')
  assert.notEqual(canonical('a b'), canonical('ab'), '空格增删会改变词，不能忽略')
  assert.notEqual(canonical('你好。'), canonical('你好'), '标点增删不能忽略')
  assert.notEqual(canonical('a\nb'), canonical('a b'), '换行结构不能忽略（老 normalizeBody 就错在这里）')
  assert.notEqual(canonical('https://a.com/x'), canonical('https://a.com/y'), 'URL 变化不能忽略')
})

test('P0-1：翻译失败 → 点「重试翻译」→ 真正重试并成功发送（状态机闭环）', async () => {
  const h = await mount({
    responses: [
      { success: false, code: 'UPSTREAM_TIMEOUT', msg: '上游超时' },
      { success: true, translation: 'Hello there', requestId: 'req-after-retry' }
    ]
  })
  try {
    const doc = h.doc
    const traces = captureTraces(h)
    h.composer.textContent = '你好，今天下午三点开会'
    h.pressEnter()

    await until(() => !!doc.getElementById('pix-send-failure'), 3000, '失败提示出现')
    await settle(200)
    assert.deepEqual(h.sent, [], 'P0：翻译失败时一个字节都不许发')

    const notice = doc.getElementById('pix-send-failure')
    assert.ok(/UPSTREAM_TIMEOUT/.test(notice.textContent),
      '提示必须暴露真实错误码，禁止用统一的"状态异常/重试失败"掩盖：' + notice.textContent)

    const retry = noticeButton(doc, '重试翻译')
    assert.ok(retry, '失败提示里必须有「重试翻译」')
    retry.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))

    await until(() => h.sent.length === 1, 4000, '重试后成功发送')
    await settle(300)
    assert.deepEqual(h.sent, ['Hello there'], '重试必须真正重翻并发送译文，而不是又回到失败')
    assert.equal(h.doc.getElementById('pix-send-failure'), null, '重试成功后提示必须收起')

    assert.ok(traces.some(t => t.indexOf('RETRY_TRANSLATE_CLICK') >= 0),
      '缺少 RETRY_TRANSLATE_CLICK 取证事件 —— 无法证明重试链走过')
    assert.ok(traces.some(t => t.indexOf('TRANSLATE_FAILED') >= 0),
      '第一次失败必须留痕（否则事后无法定位死在哪一步）')
    assert.ok(traces.some(t => t.indexOf('FINAL_TEXT_VALIDATED') >= 0),
      '重试成功路径必须跑过 FINAL_TEXT_VALIDATED 闸门')
    assert.ok(traces.some(t => t.indexOf('PROGRAMMATIC_SEND_DONE') >= 0),
      '重试成功必须留下程序化发送完成事件')
  } finally { h.close() }
})

test('P0-1 守卫：重试必须换新的 sendActionId 并归位 phase（不许复用残留状态）', () => {
  const notice = guestSrc.slice(guestSrc.indexOf('function showSendFailureNotice'),
    guestSrc.indexOf('// ==== SEND FAILURE NOTICE END ===='))
  assert.match(notice, /sendActionId = newSendActionId\(\)/,
    '重试必须开新的发送动作号，否则复用上一轮的残留状态')
  assert.match(notice, /sendActionPhase = 'idle'/,
    '重试前必须把 phase 归零，否则会带着失败态进状态机')
  assert.match(notice, /RETRY_TRANSLATE_CLICK/,
    '重试点击必须留 RETRY_TRANSLATE_CLICK 取证事件')
  // deliverSend 的失败分支也必须把 phase 归位（老实现直接 return，永远停在 translating）
  const deliver = guestSrc.slice(guestSrc.indexOf('async function deliverSend'),
    guestSrc.indexOf('const finalText = out === masked.masked'))
  assert.match(deliver, /sendActionPhase = 'idle'/,
    'deliverSend 失败分支必须归位 phase，否则重试会撞上残留状态')
})

test('P0-2 守卫：hostOf 不得再有任何向上兜底（msg-container / node 自身）', () => {
  const hostFn = guestSrc.slice(guestSrc.indexOf('function hostOf(node)'),
    guestSrc.indexOf('function indexPath('))
  assert.ok(hostFn.length > 0, '找不到 hostOf')
  assert.ok(!/msg-container/.test(hostFn), 'hostOf 不得再兜底到 msg-container（这就是译文跑到聊天底部的入口）')
  assert.ok(!/\|\|\s*node\s*$/.test(hostFn.replace(/\s+$/, '')), 'hostOf 不得再兜底到 node 自身')
  assert.match(hostFn, /rowOf\(node\)/, 'hostOf 必须先从节点解析出消息行')
  assert.match(hostFn, /bubbleFromSpan\(/, 'hostOf 必须从消息行**向下**推导气泡，而不是向上 closest')
  const bubble = guestSrc.slice(guestSrc.indexOf('function bubbleFromSpan'),
    guestSrc.indexOf('function hostOf(node)'))
  assert.match(bubble, /row\.contains\(el\)/, 'bubbleFromSpan 必须限定在消息行内')
  assert.match(bubble, /return row\.contains\(span\) \? row : null/,
    '没有块级容器时只能退回消息行本身，绝不越过它')
})

// ---------------------------------------------------------------------------
// 0.1.18 · P0-3：短消息的「译」按钮被 WhatsApp 时间/勾遮挡
//
// 真机现场：单行/超短消息时，入口和 WhatsApp 的时间/单勾/双勾挤在气泡右下角，
// 按钮被盖住、点不动。修复要点：入口搬进**正常文档流**的独立操作行，整行块、
// 位于正文下方，结构上不可能与右下角的 metadata 同排/重叠。
// ---------------------------------------------------------------------------

test('P0-3a：入口必须住在气泡内的 .pix-trans-action-row（整行块），而不是直接贴在正文尾部', async () => {
  const h = await mount({ html: WA_SHORT_MAIN, prefs: WA_PREFS, translation: '你好' })
  try {
    const doc = h.doc
    const row = doc.querySelector('[data-id]')
    await until(() => !!doc.querySelector('.pix-click'), 3000, '「译」按钮出现')
    const chip = doc.querySelector('.pix-click')
    const actionRow = chip.parentElement

    assert.equal(actionRow.className, 'pix-trans-action-row', '入口必须住在独立操作行里')
    assert.equal(actionRow.getAttribute('data-pix-ui'), 'translate-action-row',
      '操作行必须带上 [data-pix-ui] 标记（解析/采集/发送链要跳过它）')
    assert.ok(row.contains(actionRow), '操作行必须是当前消息气泡的后代')
    assert.equal(actionRow.parentElement.closest('[data-id]'), row,
      '操作行不得越出消息行（禁止挂到 #main / msg-list / 会话根）')
    assert.equal(doc.querySelector('#main > .pix-trans-action-row'), null, '禁止把操作行挂到 #main')
    const inList = doc.querySelectorAll('#msg-list .pix-trans-action-row')
    assert.equal(inList.length, 1, '消息区里只应有唯一一个操作行')
    assert.notEqual(inList[0].parentElement.id, 'main', '操作行不得直接挂在 #main 下')

    // 入口必须是"正文之后的独立一行"，而不是挤在正文那一行末尾。
    const meta = row.querySelector('.MessageMeta')
    assert.ok(meta, 'fixture 里应有 WhatsApp 的 metadata（时间/勾）')
    const order = Array.from(row.querySelectorAll(
      '.selectable-text, .pix-trans-action-row, .MessageMeta'))
    assert.ok(order.indexOf(actionRow) > order.indexOf(row.querySelector('.selectable-text')),
      '操作行必须在正文**之后**（位于正文下方）')
    assert.ok(order.indexOf(actionRow) < order.indexOf(meta),
      '操作行必须排在 metadata **之前**，让 metadata 走它自己的位置，不与入口同排')
  } finally { h.close() }
})

test('P0-3b：三种状态（译 / 翻译中… / 已翻译）必须共用同一个操作行，绝不跳位', async () => {
  const h = await mount({ html: WA_SHORT_MAIN, prefs: WA_PREFS, translation: '你好', slowMs: 120 })
  try {
    const doc = h.doc
    const row = doc.querySelector('[data-id]')
    await until(() => !!doc.querySelector('.pix-click'), 3000, '「译」按钮出现')
    const chip = doc.querySelector('.pix-click')
    const actionRow = chip.parentElement
    assert.equal(chip.getAttribute('data-pix-state'), 'idle')

    chip.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
    await until(() => doc.querySelector('.pix-click').getAttribute('data-pix-state') === 'busy',
      3000, '进入翻译中')
    assert.equal(doc.querySelector('.pix-click').parentElement, actionRow,
      '「翻译中…」必须还在同一个操作行里（不许换位置）')
    assert.equal(doc.querySelectorAll('.pix-trans-action-row').length, 1, '操作行只能有一个，不许每状态新建')

    await until(() => doc.querySelector('.pix-click').getAttribute('data-pix-state') === 'done',
      4000, '进入已翻译')
    assert.equal(doc.querySelector('.pix-click').parentElement, actionRow,
      '「已翻译」必须还在同一个操作行里')
    assert.equal(doc.querySelector('.pix-click').textContent, '已翻译')
    // 阅读顺序：正文 → 操作行 → 译文。
    const box = doc.querySelector('.pix-trans')
    assert.ok(box, '译文必须画出来')
    const order = Array.from(row.querySelectorAll('.pix-trans-action-row, .pix-trans'))
    assert.ok(order.indexOf(actionRow) < order.indexOf(box),
      '译文必须排在操作行**之后**（正文 → 操作行 → 译文）')
    assert.equal(doc.querySelectorAll('.pix-click').length, 1,
      '成功后入口必须保留在操作行里显示「已翻译」，不许删掉（也不许复制出第二个）')
  } finally { h.close() }
})

test('P0-3c：超短正文（1~3 字）也必须给出可点的入口，且不依赖 z-index / 绝对定位', () => {
  // 结构级守卫：入口/操作行都不许用绝对定位去抢 metadata 区域。
  const rowRule = (guestSrc.match(/\.pix-trans-action-row\s*\{[\s\S]*?\}/) || [''])[0]
  const chipRule = (guestSrc.match(/\.pix-click\s*\{[\s\S]*?\}/) || [''])[0]
  for (const [name, rule] of [['操作行', rowRule], ['入口', chipRule]]) {
    assert.ok(rule.length > 0, '找不到 ' + name + ' 的样式规则')
    assert.ok(!/position:\s*absolute/.test(rule), name + ' 禁止绝对定位（right/bottom 抢 metadata）')
    assert.ok(!/z-index/.test(rule), name + ' 禁止靠 z-index 压 metadata')
  }
  assert.match(rowRule, /display:\s*block/, '操作行必须是块级（单独成行）')
  assert.match(rowRule, /width:\s*100%/, '操作行必须占满整行')
  assert.match(chipRule, /pointer-events:\s*auto/, '入口必须显式打开 pointer-events（否则点不动）')
  // 所有状态文案都必须写在 chip 自己身上（不新建元素、不换容器）。
  assert.match(guestSrc, /chip\.textContent = '翻译中…'/)
  assert.match(guestSrc, /chip\.textContent = '已翻译'/)
  assert.match(guestSrc, /chip\.textContent = '译'/)
})


// ---------------------------------------------------------------------------
// 0.1.28 真机缺陷：发送「图文消息」时文字不翻译
// ---------------------------------------------------------------------------
// 用户报障：「图文一起发送的时候，不翻译」——文字原样发出去了，消息发成功。
// 真机日志里**一条 SEND_CAPTURED 都没有**，说明发送拦截根本没触发（不是翻译失败）。
//
// 根因：附加图片后，WhatsApp 的输入区变成**图片预览面板**，footer 里会出现
// 不止一个 contenteditable（媒体标题框 + caption 框）。老 composerEl() 按选择器
// 顺序取"第一个可见的"，拿到的可能不是用户正在打字的 caption 框 ——
// 于是 eventInComposer 不匹配 / readComposer 读到空 → 静默放行。
//
// 修法：composerEl() 优先返回 document.activeElement（用户正在打字的框）。
// 下面用真 jsdom 把"附件预览面板"这套结构锁死。

/**
 * 附件预览面板：footer 里**先**出现一个媒体标题框（不可见/非焦点），
 * caption 框（真机里同样是 #editable-message-text）排在它**后面**。
 *
 * 这个"错序"就是缺陷的触发器：老 composerEl() 按选择器顺序取第一个可见框，
 * 会拿到前面那个，于是用户真正在打字的 caption 被漏掉 → 静默放行。
 */
const ATTACH_PREVIEW_MAIN =
  '<div id="main"><div id="msg-list"></div><footer>' +
  '<div id="media-editor">' +
  '<div id="media-title" contenteditable="true" role="textbox" aria-label="Add a caption"></div>' +
  '<div id="editable-message-text" contenteditable="true" role="textbox" aria-label="Type a message"></div>' +
  '</div>' + SEND_BTN + '</footer></div>'

test('0.1.28-图文发送：附件预览面板里打字，按回车必须被拦下并翻译（不是静默放行）', async () => {
  const h = await mount({ html: ATTACH_PREVIEW_MAIN, translation: 'Image caption translated' })
  try {
    // 用户把光标放进 caption 框（真机上 attachment 后焦点自动落在这里）
    const caption = h.doc.getElementById('editable-message-text')
    caption.focus()
    caption.textContent = '这张图很好看'
    h.doc.__editor.setModel('这张图很好看')

    const prevented = h.pressEnter()
    assert.equal(prevented, true,
      '图文消息的发送必须被拦下（defaultPrevented）——没拦就是原文直接出网')

    await sleep(200)
    assert.equal(h.translateCalls.length, 1, '必须发起 1 次翻译请求')
    assert.equal(h.translateCalls[0].text, '这张图很好看', '翻译的必须是 caption 正文')
    assert.deepEqual(h.sent, ['Image caption translated'], '发出的必须是译文，只能一条')
  } finally { h.close() }
})

test('0.1.28-图文发送：焦点在 caption 框时点发送按钮，也必须被拦下', async () => {
  const h = await mount({ html: ATTACH_PREVIEW_MAIN, translation: 'Image caption translated' })
  try {
    const caption = h.doc.getElementById('editable-message-text')
    caption.focus()
    caption.textContent = '这张图很好看'
    h.doc.__editor.setModel('这张图很好看')

    h.clickSendButton()

    await sleep(200)
    assert.equal(h.translateCalls.length, 1,
      '点发送按钮也必须触发翻译（否则就是原文出网）')
    assert.equal(h.translateCalls[0].text, '这张图很好看', '翻译的必须是 caption 正文')
    assert.deepEqual(h.sent, ['Image caption translated'], '发出的必须是译文')
  } finally { h.close() }
})

test('0.1.28-图文发送：附件场景下"媒体标题框"不该被误当成正文', async () => {
  // 防回归：修好"取错框"之后，绝不能反过来把前面的媒体标题框当正文翻译。
  const h = await mount({ html: ATTACH_PREVIEW_MAIN, translation: 'Image caption translated' })
  try {
    const title = h.doc.getElementById('media-title')
    title.textContent = 'IMG_2043.HEIC'
    const caption = h.doc.getElementById('editable-message-text')
    caption.focus()
    caption.textContent = '这张图很好看'
    h.doc.__editor.setModel('这张图很好看')

    h.pressEnter()
    await sleep(200)
    assert.equal(h.translateCalls.length, 1)
    assert.equal(h.translateCalls[0].text, '这张图很好看',
      '翻译的必须是 caption 框的正文，而不是媒体标题框里的文件名')
  } finally { h.close() }
})

test('0.1.28-图文发送：composerEl 必须优先取"焦点所在"的输入框，而不是第一个 contenteditable', () => {
  // 结构级守卫：composerEl() 里 activeElement 分支必须排在 firstMatch 之前。
  const at = guestSrc.indexOf('function composerEl()')
  assert.ok(at > 0, '找不到 composerEl')
  const body = guestSrc.slice(at, guestSrc.indexOf('\n  function readComposer', at))
  const aeAt = body.indexOf('document.activeElement')
  const fmAt = body.indexOf('firstMatch(')
  assert.ok(aeAt > 0, 'composerEl 必须考虑 document.activeElement')
  assert.ok(fmAt > 0, 'composerEl 仍然要有选择器兜底')
  assert.ok(aeAt < fmAt,
    'activeElement 必须排在 firstMatch 之前 —— 附件后 footer 里有多个输入框，' +
    '只按选择器顺序取会拿错框，导致发送静默放行')
})

test('0.1.28-图文发送：焦点不在 caption 框（用户先打字后附加图片）时，Enter 也必须被拦下', async () => {
  // 真机最可能的现场：用户先在普通输入框打出中文 → 点附加图片 → 焦点没跟着切到
  // caption 框 → Enter 事件发生在 caption 框里，但 composerEl()（取焦点）拿到的是
  // 前面那个框 → eventInComposer 失败 → **静默放行**，中文原文原样出网。
  // 这条用例把"事件优先、焦点兜底"这个修复钉死。
  const h = await mount({ html: ATTACH_PREVIEW_MAIN, translation: 'Image caption translated' })
  try {
    const title = h.doc.getElementById('media-title') // 让焦点**故意**留在别的框上
    title.focus()
    assert.equal(h.doc.activeElement.id, 'media-title', '前置条件：焦点必须不在 caption 框')

    const caption = h.doc.getElementById('editable-message-text')
    caption.textContent = '这张图很好看'
    h.doc.__editor.setModel('这张图很好看')

    const ev = new h.win.KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
    })
    caption.dispatchEvent(ev)

    assert.equal(ev.defaultPrevented, true,
      '即使焦点不在 caption 框，也要按"事件发生在哪个框"来拦 —— 否则原文直接出网')

    await sleep(200)
    assert.equal(h.translateCalls.length, 1, '必须发起 1 次翻译请求')
    assert.equal(h.translateCalls[0].text, '这张图很好看', '翻译的必须是 caption 正文')
    assert.deepEqual(h.sent, ['Image caption translated'], '发出的必须是译文')
  } finally { h.close() }
})
