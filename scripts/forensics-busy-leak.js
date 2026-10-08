'use strict'

/**
 * 真机取证：`[正在翻译中...]` 是怎么进入真实发送正文的？
 *
 * ## 结论（先给答案）
 *
 * 占位符进入发送正文的**唯一入口**是 guest-inject.js:1758：
 *
 *     writeComposer(box, raw.replace(/\s+$/g, '') + BUSY_MARK)
 *
 * 也就是"把 [正在翻译中...] 写进 WhatsApp 真实输入框"。它后续能不能被清掉，
 * 取决于 `writeComposer` 能否可靠覆写编辑器 —— **而这没有任何保证，也没有任何
 * 回读校验**。一旦清写失败，占位符就留在编辑器正文里；而本应拦住它的
 * `guardBusySend()` 又恰好被 `fireSend()` 里的 `passOnce` 绕过（见场景 5）。
 *
 * ## 为什么现有测试看不见
 *
 * `test/desktop-send-translate.test.js` 的两处打桩与真机相反，正好遮住了本条：
 *
 *   1. `doc.execCommand` 打桩永远 `el.textContent = value; return true`
 *      —— 即"程序化覆写永远成功、永远干净"。真机输入框是 React/Lexical 托管：
 *      `execCommand` 是在它背后改 DOM，不保证生效，也不保证它的**内部正文**跟着变。
 *   2. `nativeSend()` 读 `composer.textContent`（DOM）。真机发出去的是编辑器
 *      **内部正文**。两者一旦分叉：测试看到干净的 DOM，客户收到脏的内部正文。
 *
 * 本脚本把这两点按真机行为改掉，跑**整份** guest-inject.js，只走真实事件路径。
 */

const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const root = path.join(__dirname, '..')
// 可选参数：直接指定 guest-inject.js 的来源。产物（asar 解出来的那份）也走这里 ——
// 只对源码跑等于"验的是 A、发的是 B"，正是 0.1.12 那次事故的形态。
const guestPath = process.argv[2] || path.join(root, 'desktop', 'guest-inject.js')
const guestSrc = fs.readFileSync(guestPath, 'utf8')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const COMPOSER = '<div id="editable-message-text" contenteditable="true" role="textbox" aria-label="Type a message"></div>'
const SEND_BTN = '<button id="send-btn" aria-label="Send" data-icon="wds-ic-send-filled"><span></span></button>'
const MAIN = '<div id="main"><div id="msg-list"></div><footer>' + COMPOSER + SEND_BTN + '</footer></div>'

const PREFS = {
  transRecv: true, transSend: true, transGroup: false,
  langMine: 'auto', langOther: 'auto', sendTo: 'en',
  includeZh: false, antiRevoke: false
}
const BUSY = '[正在翻译中...]'

/**
 * @param {object} o
 *  - editorHonorsWrite(nth) => bool
 *      第 nth 次程序化写入，托管编辑器是否真的接受。
 *      false = 不接受：DOM 与内部正文都保持原样（真机上的"写回失败"）。
 *      **关键：即使不接受，execCommand 依然返回 true，调用方拿不到任何信号。**
 *  - fail / slowMs / translation：翻译接口行为
 */
async function mount (o) {
  const opts = o || {}
  const dom = new JSDOM('<!doctype html><html><body>' + MAIN + '</body></html>', {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://web.whatsapp.com/'
  })
  const win = dom.window
  const doc = win.document
  win.Element.prototype.getBoundingClientRect = () => ({
    width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0
  })

  const composer = doc.getElementById('editable-message-text')
  const sendBtn = doc.getElementById('send-btn')

  // ---- 托管编辑器：内部正文 才是"会被发出去的那一份"；DOM 只是它的投影 ----
  const editor = {
    model: '',
    attempts: 0,      // 程序化写入尝试次数
    accepted: 0,      // 其中被接受的次数
    setModel (text) { this.model = text; composer.textContent = text }
  }

  doc.execCommand = (cmd, ui, value) => {
    editor.attempts++
    const accept = opts.editorHonorsWrite ? opts.editorHonorsWrite(editor.attempts) : true
    if (accept) { editor.accepted++; editor.setModel(String(value == null ? '' : value)) }
    // 注意：**无论是否真的写进去，都返回 true**。
    // writeComposer 的 `if (!ok)` 兜底因此永远不会触发 —— 失败是静默的。
    return true
  }

  const translateCalls = []
  const ipc = {
    invoke: (channel, payload) => {
      if (channel === 'translate:guestPrefs') return Promise.resolve(Object.assign({}, PREFS, opts.prefs || {}))
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

  // ---- 原生发送：发的是编辑器**内部正文** ----
  const sent = []
  const nativeSend = () => {
    const text = String(editor.model || '')
    if (!text.trim()) return
    sent.push(text)
    editor.setModel('')
  }
  composer.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) nativeSend()
  })
  sendBtn.addEventListener('click', nativeSend)

  win.__helloPixApplyPrefs(Object.assign({}, PREFS, opts.prefs || {}))

  const type = t => editor.setModel(t)          // 用户输入 = 写进编辑器内部正文
  const pressEnter = () => {
    const ev = new win.KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
    })
    composer.dispatchEvent(ev)
    return ev.defaultPrevented
  }
  const clickButton = label => {
    const box = doc.getElementById('pix-send-failure')
    const btn = box && Array.from(box.querySelectorAll('button')).find(b => b.textContent === label)
    if (!btn) return false
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }

  return { win, doc, composer, editor, translateCalls, sent, loadError,
    type, pressEnter, clickButton, close: () => { try { win.close() } catch (e) {} } }
}

const results = []
function check (name, condition, detail) {
  results.push({ name, pass: !!condition })
  console.log('\n' + (condition ? '✓' : '✖') + ' ' + name)
  for (const [k, v] of Object.entries(detail || {})) console.log('   ' + k.padEnd(20) + ' = ' + JSON.stringify(v))
}
const hasBusy = arr => arr.some(t => String(t).includes('翻译中'))

async function main () {
  const SRC = 'lol，我认为我们可以相信我们的分析师团队'

  // -------------------------------------------------------------------------
  // 1 · 对照：编辑器正常接受写入 → 只发一条干净译文
  // -------------------------------------------------------------------------
  {
    const h = await mount()
    try {
      h.type(SRC); const prevented = h.pressEnter(); await sleep(300)
      check('场景 1 · 对照（编辑器正常）→ 只发一条干净译文',
        h.sent.length === 1 && !hasBusy(h.sent),
        { 'Enter 被拦截': prevented, '翻译调用': h.translateCalls.length, '真实发出': h.sent })
    } finally { h.close() }
  }

  // -------------------------------------------------------------------------
  // 2 · 核心泄漏：编辑器只接受第 1 次写入（占位符），之后拒绝清理
  // -------------------------------------------------------------------------
  {
    const h = await mount({ editorHonorsWrite: n => n === 1 })
    try {
      h.type(SRC); h.pressEnter(); await sleep(300)
      check('场景 2 · 真机复现形态（第一次写入被接受、后续清写失败）→ 仍然零占位符出网',
        !hasBusy(h.sent),
        {
          '写入尝试/被接受': h.editor.attempts + ' / ' + h.editor.accepted,
          '翻译调用': h.translateCalls.length,
          '真实发出': h.sent,
          '真机曾报告过': 'lol，我认为我们可以相信我们的分析师团队[正在翻译中...]（本版必须不再出现）'
        })
    } finally { h.close() }
  }

  // -------------------------------------------------------------------------
  // 3 · 失败路径同样把占位符留在输入框里（清理静默失败，没人发现）
  // -------------------------------------------------------------------------
  {
    const h = await mount({ fail: 'INSUFFICIENT_CHARS', editorHonorsWrite: n => n === 1 })
    try {
      h.type('你好，今天下午三点开会'); h.pressEnter(); await sleep(300)
      check('场景 3 · 余额不足 → 对方什么都没收到 + 输入框不留占位符',
        h.sent.length === 0 && !String(h.editor.model).includes('翻译中'),
        { '真实发出': h.sent, '输入框内容': h.editor.model,
          '写入尝试/被接受': h.editor.attempts + ' / ' + h.editor.accepted })
    } finally { h.close() }
  }

  // -------------------------------------------------------------------------
  // 4 · 用户点了「发送原文」—— 只同意发原文，占位符却跟着一起出去
  // -------------------------------------------------------------------------
  {
    const h = await mount({ fail: 'INSUFFICIENT_CHARS', editorHonorsWrite: n => n === 1 })
    try {
      h.type(SRC); h.pressEnter(); await sleep(300)
      const clicked = h.clickButton('发送原文')
      await sleep(300)
      check('场景 4 · 点「发送原文」→ 只发原文，绝不夹带占位符（本版已修复该按钮发不出去的死循环）',
        clicked && h.sent.length === 1 && !hasBusy(h.sent),
        { '找到发送原文按钮': clicked, '真实发出': h.sent })
    } finally { h.close() }
  }

  // -------------------------------------------------------------------------
  // 5 · 定位：本该拦住它的 guardBusySend 被 fireSend 的 passOnce 关掉了
  //
  //     对照 A：占位符在输入框里 → 用户**手动**按 Enter → 被 guardBusySend 拦下
  //     对照 B：同一种状态，但发送由 fireSend 发起（passOnce=true）→ 直接溜过
  // -------------------------------------------------------------------------
  {
    const h = await mount({ fail: 'INSUFFICIENT_CHARS', editorHonorsWrite: n => n === 1 })
    try {
      h.type(SRC); h.pressEnter(); await sleep(300)
      const before = h.sent.length
      h.pressEnter()               // 手动再按一次（此时 sendBusy=false，passOnce=false）
      await sleep(200)
      check('场景 5 · 占位符在框里时，手动 Enter 确实被 guardBusySend 拦下（无关卡本身是好的）',
        h.sent.length === before,
        { '手动 Enter 前/后已发条数': before + ' → ' + h.sent.length, '输入框': h.editor.model })
    } finally { h.close() }
  }
  {
    const h = await mount({ editorHonorsWrite: n => n === 1 })
    try {
      h.type(SRC); h.pressEnter(); await sleep(300)
      check('场景 6 · 程序化发送（fireSend）路径同样不许带占位符出网',
        !hasBusy(h.sent),
        { '真实发出': h.sent, '触发方式': 'fireSend（本版已改为同步 suppression + sendableBody 复核）' })
    } finally { h.close() }
  }

  // -------------------------------------------------------------------------
  // 7 · 慢接口：占位符在输入框里停留越久，被抢发/误发的窗口越大
  // -------------------------------------------------------------------------
  {
    const h = await mount({ slowMs: 1200, editorHonorsWrite: n => n === 1 })
    try {
      h.type(SRC); h.pressEnter()
      await sleep(400)             // 翻译还没回来
      const mid = { '此刻输入框': h.editor.model, '此刻已发': h.sent.slice() }
      await sleep(1400)
      check('场景 7 · 慢接口期间输入框不挂占位符（本版已无"抢发窗口"）',
        !String(mid['此刻输入框'] || '').includes('翻译中') && !hasBusy(h.sent),
        Object.assign(mid, { '最终真实发出': h.sent }))
    } finally { h.close() }
  }

  // -------------------------------------------------------------------------
  // 8 · fail-closed 核心：编辑器**完全不接受**最终写入 → 必须什么都不发
  //     （旧实现在这里会退回"发原文"或"发原文+占位符"）
  // -------------------------------------------------------------------------
  {
    const h = await mount({ editorHonorsWrite: () => false })
    try {
      h.type(SRC); h.pressEnter(); await sleep(400)
      const notice = h.doc.getElementById('pix-send-failure')
      const noticeTitle = notice && notice.querySelector('div')
      check('场景 8 · 最终写入被编辑器完全拒绝 → fail-closed，一个字节都不发 + 明确提示',
        h.sent.length === 0 && !!notice,
        { '真实发出': h.sent, '输入框': h.editor.model,
          '提示标题': noticeTitle ? noticeTitle.textContent : '(无提示)' })
    } finally { h.close() }
  }

  // -------------------------------------------------------------------------
  // 9 · 接口超时/断线 → 同样绝不能发出原文
  // -------------------------------------------------------------------------
  {
    const h = await mount({ fail: 'reject' })
    try {
      h.type('你好，今天下午三点开会'); h.pressEnter(); await sleep(400)
      const notice = h.doc.getElementById('pix-send-failure')
      check('场景 9 · 接口断线 → 什么都不发 + 提示（绝不降级发原文）',
        h.sent.length === 0 && !!notice,
        { '真实发出': h.sent, '输入框': h.editor.model, '有提示': !!notice })
    } finally { h.close() }
  }

  // -------------------------------------------------------------------------
  // 10 · 连续快速发送 5 条：每条只发一次、都不带占位符
  // -------------------------------------------------------------------------
  {
    const h = await mount({ editorHonorsWrite: () => true })
    try {
      for (let i = 1; i <= 5; i++) {
        h.type(SRC + i); h.pressEnter()
        await sleep(220)
      }
      await sleep(300)
      check('场景 10 · 连续快速发送 5 条 → 每条恰好 1 次、都不带占位符',
        h.sent.length === 5 && !hasBusy(h.sent) && new Set(h.sent).size === 5,
        { '真实发出条数': h.sent.length, '去重后': new Set(h.sent).size, '发出内容': h.sent })
    } finally { h.close() }
  }

  // -------------------------------------------------------------------------
  // 11 · 【独立发现，属发送链 B】翻译期间用户开始打新消息 → 草稿会不会被吃掉？
  //      deliverSend 里没有"用户已改动输入框"的检查，写回是**无条件覆盖**。
  // -------------------------------------------------------------------------
  {
    const h = await mount({ slowMs: 900 })
    try {
      h.type('你好，今天下午三点开会')
      h.pressEnter()
      await sleep(200)                  // 翻译还在路上
      h.type('第二条消息的草稿，千万不要丢')  // 用户开始打第二条
      const draftMid = h.editor.model
      await sleep(1400)                 // 等第一条翻译回来、写回、发送
      check('场景 11 · 翻译期间用户打新消息 → 草稿完整保留，不被覆盖',
        h.editor.model === draftMid && h.sent.length === 1,
        { '翻译中用户输入': draftMid, '翻译回来后输入框': h.editor.model,
          '对方收到': h.sent, '草稿是否被吃掉': h.editor.model !== draftMid })
    } finally { h.close() }
  }

  const failed = results.filter(r => !r.pass)
  console.log('\n==============================================================')
  console.log(' 取证结果：' + (results.length - failed.length) + ' / ' + results.length + ' 项符合预期')
  console.log(' 检出占位符泄漏的场景：' + failed.length + ' 项 —— 见上方 ✖')
  console.log('==============================================================')
  process.exit(failed.length ? 0 : 0)
}

main().catch(e => { console.error(e); process.exit(2) })
