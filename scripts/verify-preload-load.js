#!/usr/bin/env node
'use strict'

/**
 * 打包产物**执行级**校验 —— 直接从 asar 里取出 preload，塞进真 DOM 跑一遍。
 *
 * ## 为什么必须"执行"，而不是"grep 字符串"
 *
 * 0.1.12 上线时做过"asar 内含全部修复"的核对，方式是**在 asar 字节里搜关键字**。
 * 全部关键字都在，于是判定通过。但那一版 `guest-inject.js` 在装载阶段就抛错：
 *
 *     const historyGate = MessageParser.createHistoryGate()   // 第 63 行
 *     var MessageParser = (function () { ... })()             // 第 248 行
 *
 * `var` 提升后是 undefined，第 63 行直接 TypeError → **整份 preload 停摆**：
 * keydown / click / scan 监听器全都没挂上。界面上表现为
 *   · 发送翻译完全失效，中文原文被直接发出去
 *   · 群聊自动翻译（auto_receive）一条都不触发
 *   · 没有任何报错提示（错误只进 webContents 控制台）
 *
 * 字符串搜索永远发现不了这种缺陷 —— 只有真的把它跑起来才知道。所以本脚本
 * **执行**从包里取出的源码，并验证拦截器真的挂上了、失败时真的不发。
 *
 * ## 用法
 *
 *     node scripts/verify-preload-load.js [app.asar 路径]
 *
 * 不给路径时自动在 desktop/release/*∕ 下找一个 app.asar。
 * 退出码 0 = 通过；1 = 有阻断问题（不要把这样的包发出去）。
 */

const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const root = path.join(__dirname, '..')

/**
 * 源码模式：不依赖 ant 构建产物，直接校验 desktop/ 下的 preload。
 * 用 `--source` 打开。CI 里跑这个，可以在打包之前就拦住 D1 那类装载错误。
 */
const SOURCE_MODE = process.argv.indexOf('--source') >= 0

function sourceReader () {
  const dir = path.join(root, 'desktop')
  return {
    // 列出 desktop/ 顶层的真实文件，让"模块齐全性"检查在源码模式下也成立
    // （否则这个闸门只能在打完之后才拦得住缺文件，太晚）。
    list: () => {
      if (!fs.existsSync(dir)) return []
      const out = []
      for (const name of fs.readdirSync(dir)) {
        try {
          if (fs.statSync(path.join(dir, name)).isFile()) out.push('/' + name)
        } catch (e) {}
      }
      return out
    },
    read: (name) => {
      const p = path.join(dir, name.replace(/^\//, ''))
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
    }
  }
}

// ---------------------------------------------------------------------------
// asar 读取（不依赖 @electron/asar，避免发布环境少装依赖）
// ---------------------------------------------------------------------------

function readAsar (asarPath) {
  const buf = fs.readFileSync(asarPath)
  const jsonStart = buf.indexOf(Buffer.from('{"files":'))
  if (jsonStart < 0) throw new Error('不是合法的 asar（找不到头）')
  let depth = 0; let end = -1; let inStr = false; let esc = false
  for (let i = jsonStart; i < buf.length; i++) {
    const c = buf[i]
    if (inStr) { if (esc) esc = false; else if (c === 0x5c) esc = true; else if (c === 0x22) inStr = false; continue }
    if (c === 0x22) { inStr = true; continue }
    if (c === 0x7b) depth++
    else if (c === 0x7d) { depth--; if (depth === 0) { end = i + 1; break } }
  }
  if (end < 0) throw new Error('asar 头解析失败')
  const header = JSON.parse(buf.subarray(jsonStart, end).toString('utf8'))
  const dataStart = jsonStart + (((end - jsonStart) + 3) & ~3)

  const index = new Map()
  const walk = (node, prefix) => {
    for (const key of Object.keys(node.files || {})) {
      const entry = node.files[key]
      const full = prefix + '/' + key
      if (entry.files) walk(entry, full)
      else index.set(full, entry)
    }
  }
  walk(header, '')
  return {
    list: () => Array.from(index.keys()),
    read: (name) => {
      const entry = index.get('/' + name.replace(/^\//, ''))
      if (!entry) return null
      const off = dataStart + Number(entry.offset)
      return buf.subarray(off, off + Number(entry.size)).toString('utf8')
    }
  }
}

function findAsar (given) {
  if (given) {
    if (!fs.existsSync(given)) throw new Error('找不到文件：' + given)
    if (given.endsWith('.asar')) return given
    // 传的是 .app 或解包目录
    const asar = path.join(given, 'Contents', 'Resources', 'app.asar')
    if (fs.existsSync(asar)) return asar
    throw new Error('目录里找不到 app.asar：' + given)
  }
  const release = path.join(root, 'desktop', 'release')
  const hits = []
  const scan = (dir, depth) => {
    if (depth > 4 || !fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      let st = null
      try { st = fs.statSync(full) } catch (e) { continue }
      if (st.isDirectory()) scan(full, depth + 1)
      else if (name === 'app.asar') hits.push(full)
    }
  }
  scan(release, 0)
  if (!hits.length) throw new Error('desktop/release 下没有 app.asar，请先构建，或显式传入路径')
  hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return hits[0]
}

// ---------------------------------------------------------------------------
// 真 DOM 执行
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 等条件成立（有上限），而不是"睡够固定的一段时间"。
 *
 * 发送链里有**真实的定时器**（原生写入 + 编辑器沉降轮询，下限 0 / 上限 400ms），
 * 在 CPU 争抢场景下（CI、并行跑测试）固定窗口会让**发版闸门**偶发假红：
 * 实测原始源码在 12 路 CPU 压力下 25 次里红 7 次。
 *
 * 假红比不检查更糟 —— 它会让红灯失去意义，最后被人绕过。所以这里等"结论成立"，
 * 并且超时后**照常执行原来的断言**（真坏了还是会红，只是多等一会儿）。
 */
async function until (cond, timeoutMs) {
  const deadline = Date.now() + (timeoutMs == null ? 5000 : timeoutMs)
  while (Date.now() < deadline) {
    try { if (cond()) return true } catch (e) {}
    await sleep(10)
  }
  return false
}

const HTML = '<!doctype html><html><body><div id="main"><div id="msg-list"></div><footer>' +
  '<div id="editable-message-text" contenteditable="true" role="textbox" aria-label="Type a message"></div>' +
  '<button id="send-btn" aria-label="Send" data-icon="wds-ic-send-filled"><span></span></button>' +
  '</footer></div></body></html>'

async function runPreload (src, opts) {
  const o = opts || {}
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://web.whatsapp.com/' })
  const win = dom.window
  const doc = win.document
  win.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0 })
  // ---------------------------------------------------------------------
  // 托管编辑器模型（0.1.19）
  //
  // 真机证据：页面内 `execCommand` / `textContent` 的写入**进不了** WhatsApp 编辑器
  // 的输入管线（`sawBeforeInput:false`，actual 就是原文）。所以这里：
  //   · `doc.execCommand` 恒返回 true 但**不生效**（与真机一致）；
  //   · composer 的 `textContent` 只读写编辑器 model —— 页面内写 DOM 不会有任何效果；
  //   · 唯一能改变 model 的通道是主进程的**原生输入 IPC**（下面 invoke 里实现）。
  // ---------------------------------------------------------------------
  const composerEl = doc.getElementById('editable-message-text')
  const editor = { model: '' }
  const nodeTextDesc = Object.getOwnPropertyDescriptor(win.Node.prototype, 'textContent')
  Object.defineProperty(composerEl, 'textContent', {
    configurable: true,
    enumerable: true,
    get () { return editor.model },
    set (v) { editor.model = String(v == null ? '' : v); nodeTextDesc.set.call(composerEl, editor.model) }
  })
  doc.execCommand = () => true
  const calls = []
  win.require = () => ({    ipcRenderer: {
      invoke: (channel, payload) => {
        if (channel === 'translate:guestPrefs') {
          return Promise.resolve({ transRecv: true, transSend: true, transGroup: false, langMine: 'auto', langOther: 'auto', sendTo: 'en', includeZh: false, antiRevoke: false, sendSettleMs: 0 })
        }
        // 原生输入通道（生产链唯一的写入方式）。
        if (channel === 'translate:composerSelectAllDelete') {
          editor.model = ''
          return Promise.resolve({ ok: true, focused: true })
        }
        if (channel === 'translate:composerInsertText') {
          editor.model = String((payload && payload.text) || '')
          return Promise.resolve({ ok: true, chars: editor.model.length })
        }
        if (channel === 'translate:run') {
          calls.push(payload)
          if (o.fail) return Promise.resolve({ success: false, code: o.fail, msg: '服务端原文' })
          return Promise.resolve({ success: true, translation: 'Hello there' })
        }
        return Promise.resolve({ success: true })
      },
      on: () => {},
      removeAllListeners: () => {}
    }
  })

  let loadError = null
  try { win.eval(src) } catch (e) { loadError = e }
  await new Promise(resolve => {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', resolve, { once: true })
    else resolve()
  })
  await sleep(30)

  const composer = doc.getElementById('editable-message-text')
  const sendBtn = doc.getElementById('send-btn')
  // 故障注入：验证"拦截流程中途抛错也必须拦下，且一个字节都不发"。
  // 这条不变量在 0.1.12 上是彻底缺的 —— 那时连拦截器都没挂上。
  if (o.crash) {
    win.__helloPixFaultInject = () => { throw new Error('模拟 preload 内部异常：' + o.crash) }
    // 兜底路径会 console.error 留痕（这是对的）。校验时把这条预期噪音吞掉，
    // 否则报告里全是堆栈，真正的结论看不见。
    try { win.console.error = () => {} } catch (e) {}
  }
  const sent = []
  const nativeSend = () => {
    const text = String(composer.textContent || '')
    if (!text.trim()) return
    sent.push(text)
    composer.textContent = ''
  }
  composer.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) nativeSend() })
  sendBtn.addEventListener('click', nativeSend)

  const pressEnter = () => {
    composer.textContent = '你好，今天下午三点开会'
    const ev = new win.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })
    composer.dispatchEvent(ev)
    return ev.defaultPrevented
  }

  return { win, doc, composer, calls, sent, loadError, pressEnter, close: () => { try { win.close() } catch (e) {} } }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

const results = []
function check (name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' })
}

async function main () {
  const asarPath = SOURCE_MODE ? '(源码模式：desktop/)' : findAsar(process.argv[2])
  console.log('校验对象：' + asarPath)
  const asar = SOURCE_MODE ? sourceReader() : readAsar(asarPath)

  const guest = asar.read('guest-inject.js')
  check('产物内含 guest-inject.js', !!guest, guest ? (guest.split('\n').length + ' 行') : '缺失')

  if (guest) {
    // 1. 装载必须不抛错
    let h = await runPreload(guest, {})
    check('guest-inject.js 装载不抛错', !h.loadError, h.loadError ? h.loadError.message : '')
    let prevented = h.pressEnter()
    check('装载后 Enter 被拦截（监听器真的挂上）', prevented === true, prevented ? '' : '未拦截 = 原文会直通 WhatsApp')
    // 等"真的发出去了"，不是等"睡够 120ms"：这条就是发版闸门最容易假红的地方。
    await until(() => h.sent.length >= 1, 8000)
    // 再多给一点时间：闸门要抓的另一半是"重复发送"，光等第一条出来抓不到。
    await sleep(150)
    check('成功路径：调 1 次翻译接口', h.calls.length === 1, '实际 ' + h.calls.length + ' 次')
    check('成功路径：trigger=manual_send', h.calls[0] && h.calls[0].trigger === 'manual_send', h.calls[0] ? String(h.calls[0].trigger) : '无调用')
    check('成功路径：只发出 1 条译文', h.sent.length === 1 && h.sent[0] === 'Hello there', JSON.stringify(h.sent))
    h.close()

    // 2. 失败必须一个字节都不发
    for (const code of ['INSUFFICIENT_CHARS', 'ENGINE_NOT_ALLOWED']) {
      h = await runPreload(guest, { fail: code })
      prevented = h.pressEnter()
      // 等提示真的画出来 = 这条链真的走完了（再断言"一个字节都没发"才有意义）。
      await until(() => !!h.doc.getElementById('pix-send-failure'), 8000)
      check('失败(' + code + ')：Enter 仍被拦截', prevented === true, '')
      check('失败(' + code + ')：对方什么都收不到', h.sent.length === 0, JSON.stringify(h.sent))
      check('失败(' + code + ')：给出可见提示', !!h.doc.getElementById('pix-send-failure'), '')
      h.close()
    }

    // 3. 拦截流程中途抛错：也必须拦下，且一个字节都不发（否则就是 0.1.12 重演）
    h = await runPreload(guest, { crash: 'parse-error' })
    prevented = h.pressEnter()
    await until(() => !!h.doc.getElementById('pix-send-failure'), 8000)
    check('崩溃兜底：拦截流程抛错时 Enter 仍被拦截', prevented === true,
      prevented ? '' : '未拦截 = 原文会直通 WhatsApp（这正是 0.1.12 的表现）')
    check('崩溃兜底：抛错时对方什么都收不到', h.sent.length === 0, JSON.stringify(h.sent))
    check('崩溃兜底：抛错也要给出可见提示', !!h.doc.getElementById('pix-send-failure'), '')
    h.close()
  }

  const preload = asar.read('preload.js')
  check('产物内含 preload.js', !!preload, '')
  if (preload) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' })
    let err = null
    const exposed = {}
    dom.window.require = () => ({
      contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v } },
      ipcRenderer: { invoke: () => Promise.resolve(null), send: () => {} }
    })
    try { dom.window.eval(preload) } catch (e) { err = e }
    check('preload.js 装载不抛错', !err, err ? err.message : '')
    try { dom.window.close() } catch (e) {}
  }

  // 模块齐全性：主进程 require 的本地模块少一个，app 启动就崩（比装不上更糟：
  // 装上了但打不开窗口，用户只能看到闪退）。这些文件都是相对 require，
  // asar 里没有同名文件就直接抛 MODULE_NOT_FOUND。
  const REQUIRED_MODULES = [
    'main.js', 'preload.js', 'guest-inject.js', 'bridge-warning.js', 'log-file.js',
    'instance-slot.js', 'proxy-isolation.js', 'probe-page.js', 'socks-relay.js',
    'proxy-settings.js', 'platforms.js', 'lines.js', 'security-policy.js',
    'background-mode.js', 'api-default.js', 'proxy-presets.js'
  ]
  const all = asar.list()
  const missing = REQUIRED_MODULES.filter(f => all.indexOf('/' + f) < 0)
  check('产物内含全部本地模块', missing.length === 0, missing.length ? '缺失：' + missing.join('、') : REQUIRED_MODULES.length + ' 个')

  const pkgText = asar.read('package.json')
  let version = ''
  try { version = String(JSON.parse(pkgText).version || '') } catch (e) {}
  check('产物内含 package.json 且版本号非空', !!version, version)

  // 版本号必须与源码一致：否则会出现"验收过的是 A 版、发出去的是 B 版"。
  if (!SOURCE_MODE) {
    const srcPkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'))
    check('产物版本号与源码一致', version === String(srcPkg.version), version + ' vs ' + srcPkg.version)
  }

  const failed = results.filter(r => !r.ok)
  console.log('')
  for (const r of results) console.log('  ' + (r.ok ? '✔' : '✖') + ' ' + r.name + (r.detail ? '  → ' + r.detail : ''))
  console.log('')
  if (failed.length) {
    console.log('✖ 有 ' + failed.length + ' 项阻断问题 —— 这个包不要发出去。')
    process.exit(1)
  }
  console.log('✔ 全部 ' + results.length + ' 项通过，可以发。')
}

main().catch(err => {
  console.error('校验失败：' + (err && err.stack || err))
  process.exit(1)
})
