'use strict'

/**
 * 发送翻译状态机 · 事件顺序验证（真事件路径 + 真发送动作）
 *
 * ## 为什么要有这个脚本
 *
 * 真机上"对方到底收到了什么"只能靠肉眼；而事故复盘真正需要的是**事件顺序**。
 * 本脚本把整份 guest-inject.js 跑起来，走真实 keydown / click 路径，
 * 采集 `[PIX_TRACE]` 结构化日志，然后对每一次发送动作断言：
 *
 *   1. 事件顺序必须是
 *        SEND_CAPTURED → NATIVE_SEND_BLOCKED → SOURCE_SNAPSHOTTED
 *        → TRANSLATE_STARTED → TRANSLATE_SUCCEEDED → INPUT_REPLACED
 *        → PROGRAMMATIC_SEND_BEGIN → PROGRAMMATIC_SEND_DONE
 *      且八个事件**同一个 sendActionId**。
 *   2. **在 TRANSLATE_SUCCEEDED 之前，绝不能出现任何真实发送。**
 *      这是硬判定：只要违反，本脚本直接判 FAIL。
 *   3. WhatsApp 输入框里**只能出现两种文本**：用户原文、最终译文。
 *      任何 loading/status/busy 文案进入输入框 → FAIL。
 *
 * 输入框按真机建：托管编辑器持有自己的正文（真正会发出去的那一份），
 * `execCommand` 即使什么都没写进去也返回 true（写回失败是静默的）。
 */

const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const root = path.join(__dirname, '..')
const guestSrc = fs.readFileSync(path.join(root, 'desktop', 'guest-inject.js'), 'utf8')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const COMPOSER = '<div id="editable-message-text" contenteditable="true" role="textbox" aria-label="Type a message"></div>'
const SEND_BTN = '<button id="send-btn" aria-label="Send" data-icon="wds-ic-send-filled"><span></span></button>'
const DIRECT = '<div id="main"><div id="msg-list"></div><footer>' + COMPOSER + SEND_BTN + '</footer></div>'
const GROUP = '<div id="main"><div id="msg-list">' +
  '<div class="message-in" role="row" data-id="true_1203630199@g.us_M1">' +
  '<div class="copyable-text"><span class="selectable-text">昨天的会议纪要</span></div></div>' +
  '</div><footer>' + COMPOSER + SEND_BTN + '</footer></div>'

const PREFS = {
  transRecv: true, transSend: true, transGroup: false,
  langMine: 'auto', langOther: 'auto', sendTo: 'en',
  includeZh: false, antiRevoke: false
}

const REQUIRED_ORDER = [
  'SEND_CAPTURED', 'NATIVE_SEND_BLOCKED', 'SOURCE_SNAPSHOTTED',
  'TRANSLATE_STARTED', 'TRANSLATE_SUCCEEDED', 'INPUT_REPLACED',
  'PROGRAMMATIC_SEND_BEGIN', 'PROGRAMMATIC_SEND_DONE'
]

/** 输入框里绝不允许出现的字样。 */
const FORBIDDEN_IN_INPUT = ['正在翻译', '翻译中', '[正在翻译中...]', 'busy']

async function mount (o) {
  const opts = o || {}
  const dom = new JSDOM('<!doctype html><html><body>' + (opts.html || DIRECT) + '</body></html>', {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://web.whatsapp.com/'
  })
  const win = dom.window
  const doc = win.document
  win.Element.prototype.getBoundingClientRect = () => ({
    width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0
  })

  const composer = doc.getElementById('editable-message-text')
  const sendBtn = doc.getElementById('send-btn')

  // 托管编辑器：model 才是"会被发出去的那一份"。
  const editor = {
    model: '', attempts: 0, accepted: 0,
    writes: [],                       // 每一次尝试写入的内容（用来抓 loading 文案）
    setModel (t) { this.model = t; composer.textContent = t }
  }
  const nodeText = Object.getOwnPropertyDescriptor(win.Node.prototype, 'textContent')
  Object.defineProperty(composer, 'textContent', {
    configurable: true,
    get () { return editor.model },
    set (v) { editor.model = String(v == null ? '' : v); nodeText.set.call(composer, editor.model) }
  })
  doc.execCommand = () => {
    // 页面内改 DOM 的写入通道已被移除（0.1.19 根因）：恒返回 true 但**不生效**，
    // 与真机一致（execCommand 返回 true 而正文原地不动）。
    editor.attempts++
    return true
  }

  // ---- 采集 trace ----
  const trace = []
  const realLog = win.console.info
  win.console.info = (...a) => {
    const line = a.map(String).join(' ')
    if (line.indexOf('[PIX_TRACE]') !== -1) {
      const m = line.match(/\[PIX_TRACE\]\s+(\w+)\s+(\{.*\})/)
      if (m) {
        let payload = {}
        try { payload = JSON.parse(m[2]) } catch (e) {}
        trace.push({ event: m[1], payload, at: Date.now() })
      }
    }
    if (realLog) realLog.apply(win.console, a)
  }
  const realErr = win.console.error
  win.console.error = (...a) => {
    const line = a.map(String).join(' ')
    if (line.indexOf('BLOCKED_') !== -1) trace.push({ event: 'BLOCKED', payload: { line }, at: Date.now() })
    if (realErr) realErr.apply(win.console, a)
  }

  const translateCalls = []
  const ipc = {
    invoke: (channel, payload) => {
      if (channel === 'translate:guestPrefs') return Promise.resolve(Object.assign({}, PREFS, { sendSettleMs: 0 }, opts.prefs || {}))
      // 原生输入通道（0.1.19：唯一的写入方式）。
      if (channel === 'translate:composerSelectAllDelete') {
        editor.setModel('')
        return Promise.resolve({ ok: true, focused: true })
      }
      if (channel === 'translate:composerInsertText') {
        editor.attempts++
        const value = String((payload && payload.text) || '')
        editor.writes.push(value)
        const accept = opts.editorHonorsWrite ? opts.editorHonorsWrite(editor.attempts) : true
        if (accept) { editor.accepted++; editor.setModel(value) }
        return Promise.resolve({ ok: true, chars: value.length })
      }
      if (channel === 'translate:run') {
        translateCalls.push(payload)
        if (opts.fail === 'reject') return Promise.reject(new Error('socket hang up'))
        if (opts.fail) return Promise.resolve({ success: false, code: opts.fail, msg: '服务端返回' })
        const done = { success: true, translation: opts.translation || ('T(' + String(payload.text || '') + ')') }
        if (opts.slowMs) return new Promise(res => setTimeout(() => res(done), opts.slowMs))
        return Promise.resolve(done)
      }
      return Promise.resolve({ success: true })
    },
    on: () => {}, removeAllListeners: () => {}
  }
  win.require = () => ({ ipcRenderer: ipc })

  let loadError = null
  try { win.eval(guestSrc) } catch (e) { loadError = e }
  await new Promise(res => {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', res, { once: true })
    else res()
  })
  await sleep(20)

  // ---- 真实发送：记录"对方收到了什么" + 发生时刻 ----
  const received = []
  const nativeSend = () => {
    const text = String(editor.model || '')
    if (!text.trim()) return
    received.push({ text, at: Date.now() })
    editor.setModel('')
  }
  composer.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) nativeSend()
  })
  sendBtn.addEventListener('click', nativeSend)

  win.__helloPixApplyPrefs(Object.assign({}, PREFS, opts.prefs || {}))

  const type = t => editor.setModel(t)
  const pressEnter = extra => {
    const ev = new win.KeyboardEvent('keydown', Object.assign({
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
    }, extra || {}))
    composer.dispatchEvent(ev)
    return ev.defaultPrevented
  }
  const clickSendButton = () => {
    const ev = new win.MouseEvent('click', { bubbles: true, cancelable: true })
    sendBtn.dispatchEvent(ev)
    return ev.defaultPrevented
  }
  const clickNoticeButton = label => {
    const box = doc.getElementById('pix-send-failure')
    const btn = box && Array.from(box.querySelectorAll('button')).find(b => b.textContent === label)
    if (!btn) return false
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }

  return { win, doc, composer, editor, trace, translateCalls, received, loadError,
    type, pressEnter, clickSendButton, clickNoticeButton, close: () => { try { win.close() } catch (e) {} } }
}

// ---------------------------------------------------------------------------

const rows = []
function scenario (name, pass, detail) {
  rows.push({ name, pass: !!pass, detail: detail || {} })
  console.log('\n' + (pass ? '✓' : '✖') + ' ' + name)
  for (const [k, v] of Object.entries(detail || {})) console.log('   ' + k.padEnd(18) + ' = ' + JSON.stringify(v))
}

/**
 * 核心断言：一次发送动作的 trace 顺序 + "成功之前不得有真实发送"。
 * @returns {object} { ok, problems[] }
 */
function auditAction (h, actionIndex) {
  const id = h.trace.filter(t => t.payload && t.payload.sendActionId &&
    t.payload.sendActionId !== '-').map(t => t.payload.sendActionId)[actionIndex]
  const problems = []
  if (!id) return { ok: false, problems: ['没有找到 sendActionId'], id: null }

  const events = h.trace.filter(t => t.payload && t.payload.sendActionId === id)
  const names = events.map(e => e.event)

  // 1) 顺序
  let cursor = -1
  for (const want of REQUIRED_ORDER) {
    const at = names.indexOf(want, cursor + 1)
    if (at === -1) { problems.push('缺少 ' + want + '（实际: ' + names.join('→') + '）'); break }
    cursor = at
  }

  // 2) 同一个 sendActionId
  const distinct = new Set(events.map(e => (e.payload && e.payload.sendActionId) || '-'))
  if (distinct.size !== 1) problems.push('sendActionId 不唯一: ' + Array.from(distinct).join(','))

  // 3) 硬判定：TRANSLATE_SUCCEEDED 之前不得有真实发送
  const succ = events.find(e => e.event === 'TRANSLATE_SUCCEEDED')
  if (succ) {
    const early = h.received.filter(r => r.at < succ.at)
    if (early.length) {
      problems.push('❌ FAIL：TRANSLATE_SUCCEEDED 之前已经发生了真实发送 → ' +
        JSON.stringify(early.map(e => e.text)))
    }
  } else {
    problems.push('从未上到 TRANSLATE_SUCCEEDED')
  }

  // 4) 输入框里不得出现任何 loading/busy 文案
  for (const w of h.editor.writes) {
    for (const bad of FORBIDDEN_IN_INPUT) {
      if (w.indexOf(bad) !== -1) {
        problems.push('❌ 输入框被写入 loading 文案（' + bad + '）: ' + JSON.stringify(w))
      }
    }
  }

  return { ok: problems.length === 0, problems, id, names, actionId: id }
}

function auditReceived (label, h, expectCount, expectTexts) {
  const bad = []
  for (const r of h.received) {
    for (const f of FORBIDDEN_IN_INPUT) {
      if (r.text.indexOf(f) !== -1) bad.push('收到 loading 文案: ' + JSON.stringify(r.text))
    }
  }
  if (h.received.length !== expectCount) {
    bad.push('对方收到 ' + h.received.length + ' 条，期望 ' + expectCount + ' 条：' +
      JSON.stringify(h.received.map(r => r.text)))
  }
  if (expectTexts) {
    const got = h.received.map(r => r.text).sort()
    const want = expectTexts.slice().sort()
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      bad.push('收到内容不符：' + JSON.stringify(h.received.map(r => r.text)))
    }
  }
  return bad
}

async function main () {
  const SRC = 'lol，我认为我们可以相信我们的分析师团队'
  const EN = 'We can trust our analyst team'

  // 1 · 中文 → 英文（Enter）
  {
    const h = await mount({ translation: EN })
    try {
      h.type(SRC); const prev = h.pressEnter(); await sleep(350)
      const a = auditAction(h, 0)
      const bad = auditReceived('', h, 1, [EN])
      scenario('1 · 中文→英文 · Enter', prev && a.ok && !bad.length,
        { 'Enter 被拦截': prev, 'trace 顺序': a.names && a.names.join('→'),
          问题: a.problems.concat(bad), '对方收到': h.received.map(r => r.text) })
    } finally { h.close() }
  }

  // 2 · 英文 → 中文
  {
    const h = await mount({ translation: '我们相信我们的分析师团队', prefs: { sendTo: 'zh' } })
    try {
      h.type('We trust our analyst team'); h.pressEnter(); await sleep(350)
      const a = auditAction(h, 0)
      const bad = auditReceived('', h, 1, ['我们相信我们的分析师团队'])
      scenario('2 · 英文→中文', a.ok && !bad.length,
        { 问题: a.problems.concat(bad), '对方收到': h.received.map(r => r.text) })
    } finally { h.close() }
  }

  // 3+4 · 点击发送按钮 与 Enter 结果一致
  {
    const results = []
    for (const how of ['enter', 'button']) {
      const h = await mount({ translation: EN })
      try {
        h.type(SRC)
        if (how === 'enter') h.pressEnter(); else h.clickSendButton()
        await sleep(350)
        results.push({ how, a: auditAction(h, 0), received: h.received.map(r => r.text) })
      } finally { h.close() }
    }
    const a0 = results[0], a1 = results[1]
    scenario('3+4 · Enter 与点击发送按钮结果一致',
      a0.a.ok && a1.a.ok && JSON.stringify(a0.received) === JSON.stringify(a1.received),
      { Enter: a0, 按钮: a1 })
  }

  // 5 · 中文输入法 composition 状态
  {
    const h = await mount({ translation: EN })
    try {
      h.type(SRC)
      // composition 中的 Enter（isComposing=true）不得被拦、不得发送
      const composingEv = h.pressEnter({ isComposing: true })
      await sleep(200)
      const midReceived = h.received.length
      // 提交 composition 后再正常发送
      const prev = h.pressEnter()
      await sleep(350)
      scenario('5 · 中文输入法 composition（打字中不拦截，提交后正常翻译）',
        composingEv === false && midReceived === 0 && h.received.length === 1 &&
        h.received[0].text === EN,
        { 'composition 中未拦截': composingEv === false,
          'composition 中未发送': midReceived,
          '最终对方收到': h.received.map(r => r.text) })
    } finally { h.close() }
  }

  // 6 · API 人工延迟 5 秒
  {
    const h = await mount({ slowMs: 5000, translation: EN })
    try {
      h.type(SRC)
      const t0 = Date.now()
      h.pressEnter()
      await sleep(3000)
      const duringWindow = { received: h.received.length, elapsed: Date.now() - t0 }
      await sleep(2600)
      const a = auditAction(h, 0)
      scenario('6 · API 延迟 5 秒：3 秒时对方仍收不到任何东西，最终只收到译文',
        duringWindow.received === 0 && a.ok && h.received.length === 1 && h.received[0].text === EN,
        { '3 秒时已收条数': duringWindow.received, 问题: a.problems,
          '最终对方收到': h.received.map(r => r.text) })
    } finally { h.close() }
  }

  // 7 · API 失败 / 断线
  {
    for (const [label, opts] of [['500/服务端失败', { fail: 'INTERNAL_ERROR' }], ['断线 reject', { fail: 'reject' }]]) {
      const h = await mount(opts)
      try {
        h.type(SRC); h.pressEnter(); await sleep(400)
        const notice = h.doc.getElementById('pix-send-failure')
        scenario('7 · API ' + label + ' → 一个字节都不发 + 明确提示',
          h.received.length === 0 && !!notice,
          { '对方收到': h.received, 有提示: !!notice,
            提示: notice ? notice.textContent.slice(0, 30) : null })
      } finally { h.close() }
    }
  }

  // 8 · 余额不足
  {
    const h = await mount({ fail: 'INSUFFICIENT_CHARS' })
    try {
      h.type(SRC); h.pressEnter(); await sleep(400)
      const notice = h.doc.getElementById('pix-send-failure')
      const btns = notice ? Array.from(notice.querySelectorAll('button')).map(b => b.textContent) : []
      scenario('8 · 余额不足 → 什么都不发 + 提示 + 两个明确出口（重试翻译 / 发送原文）',
        h.received.length === 0 && !!notice && btns.includes('重试翻译') && btns.includes('发送原文'),
        { '对方收到': h.received, 出口按钮: btns })
    } finally { h.close() }
  }

  // 9 · 连续快速发送 5 条
  {
    const h = await mount()
    try {
      for (let i = 1; i <= 5; i++) { h.type(SRC + i); h.pressEnter(); await sleep(230) }
      await sleep(400)
      const bad = auditReceived('', h, 5)
      const uniq = new Set(h.received.map(r => r.text)).size
      const audits = [0, 1, 2, 3, 4].map(i => auditAction(h, i))
      const allOk = audits.every(a => a.ok)
      scenario('9 · 连续快速发送 5 条：每条只发一次、都是译文、都不带占位符',
        !bad.length && uniq === 5 && allOk,
        { '对方收到条数': h.received.length, 去重后: uniq, 问题: bad.concat(audits.flatMap(a => a.problems)),
          '对方收到': h.received.map(r => r.text) })
    } finally { h.close() }
  }

  // 10+11 · 群聊 与 私聊 一致
  {
    const out = []
    for (const [label, html] of [['私聊', DIRECT], ['群聊', GROUP]]) {
      const h = await mount({ html, translation: EN })
      try {
        h.type(SRC); h.pressEnter(); await sleep(350)
        out.push({ label, a: auditAction(h, 0), received: h.received.map(r => r.text) })
      } finally { h.close() }
    }
    scenario('10+11 · 群聊与私聊结果一致（都只收到一条译文）',
      out.every(o => o.a.ok) && JSON.stringify(out[0].received) === JSON.stringify(out[1].received) &&
      out[0].received[0] === EN,
      { 私聊: out[0], 群聊: out[1] })
  }

  // 12 · fail-closed：最终写入被编辑器拒绝
  {
    const h = await mount({ editorHonorsWrite: () => false, translation: EN })
    try {
      h.type(SRC); h.pressEnter(); await sleep(400)
      const notice = h.doc.getElementById('pix-send-failure')
      const t = notice && notice.querySelector('div')
      scenario('12 · 写回被编辑器拒绝 → fail-closed 不发 + 「翻译状态异常，消息未发送」',
        h.received.length === 0 && !!notice && /状态异常|尚未发送/.test(t ? t.textContent : ''),
        { '对方收到': h.received, 提示标题: t ? t.textContent : null })
    } finally { h.close() }
  }

  const failed = rows.filter(r => !r.pass)
  console.log('\n' + '='.repeat(62))
  console.log(' 状态机验证：' + (rows.length - failed.length) + ' / ' + rows.length + ' 项通过')
  if (failed.length) {
    console.log(' ✖ FAIL：' + failed.map(r => r.name).join(' | '))
  } else {
    console.log(' ✔ 全部通过：成功之前没有任何真实发送，输入框只出现「原文 / 译文」')
  }
  console.log('='.repeat(62))
  process.exit(failed.length ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(2) })
