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
  antiRevoke: false
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
  doc.execCommand = (cmd, ui, value) => {
    editor.attempts++
    const accept = o.editorHonorsWrite ? o.editorHonorsWrite(editor.attempts) : true
    if (accept) { editor.accepted++; editor.setModel(String(value == null ? '' : value)) }
    // **无论是否真的写进去都返回 true** —— 与真机一致，失败对调用方不可见。
    return true
  }

  const translateCalls = []
  const ipc = {
    invoke: (channel, payload) => {
      if (channel === 'translate:guestPrefs') return Promise.resolve(Object.assign({}, BASE_PREFS, o.prefs || {}))
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
      await settle()
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
    await settle()
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
    await settle()
    const box = h.doc.getElementById('pix-send-failure')
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
    await settle()
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
    await settle()
    const btn = noticeButton(h.doc, '重试翻译')
    assert.ok(btn)
    btn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
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
    await settle()
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
    await settle()
    const before = h.translateCalls.length
    // 点「重试翻译」之外的地方：点提示框本体不该触发发送翻译
    const box = h.doc.getElementById('pix-send-failure')
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

test('源码守卫：deliverSend 必须把 TRIGGER_SEND 传进 translateText', () => {
  assert.match(guestSrc, /const TRIGGER_SEND = 'manual_send'/,
    'TRIGGER_SEND 必须存在且等于 manual_send')
  const body = guestSrc.slice(guestSrc.indexOf('async function deliverSend'), guestSrc.indexOf('function scrubBusy'))
  assert.ok(body.length > 0, '找不到 deliverSend')
  assert.match(body, /translateText\(\s*[\s\S]*?TRIGGER_SEND\s*\)/,
    'deliverSend 必须把 TRIGGER_SEND 传给 translateText，否则 trigger 恒为空串')
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
    await settle()
    assert.equal(h.composer.textContent, '你好，今天下午三点开会', '原文必须退回输入框')
    const box = h.doc.getElementById('pix-send-failure')
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
    await settle()
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

test('翻译期间用户打新消息 → 草稿必须完整保留，不能被译文覆盖掉', async () => {
  // 用户在等翻译时开始打**下一条**。老实现直接 writeAndVerify(译文) 把草稿
  // 整段覆盖，翻译回来那一下用户正在打的内容凭空消失（真机已复现）。
  const h = await mount({ slowMs: 300, translation: 'Hello there' })
  try {
    h.composer.textContent = '你好，今天下午三点开会'
    h.pressEnter()
    await sleep(120)                       // 翻译还在路上
    const DRAFT = '下一条消息的草稿，千万不要丢'
    h.composer.textContent = DRAFT

    await until(() => h.sent.length === 1, 3000, '第一条译文发出')
    await settle(200)

    assert.deepEqual(h.sent, ['Hello there'], '第一条应当照常发出译文')
    assert.equal(String(h.doc.__editor.model || ''), DRAFT,
      '用户的草稿被吃掉了 —— 这是数据丢失，不是"没反应"')
    assert.equal(String(h.composer.textContent || ''), DRAFT, 'DOM 投影也要一致')
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
