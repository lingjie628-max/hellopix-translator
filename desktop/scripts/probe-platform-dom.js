'use strict'
/**
 * 多平台 DOM 结构采集器（开发用，不进安装包）。
 *
 * 用途：给每个平台写「收消息 / 群聊判定 / 输入框 / 发送按钮」适配前，
 * 先拿到真实登录态下的页面结构。用户自己登录、自己打开会话，然后点「采集」。
 *
 * 隔离：
 *   · userData 独立在「Hello Pix Probe」，分区是 persist:pixprobe-<平台>，
 *     与正在运行的 Hello Pix 的登录态互不相干。
 *
 * ★只读★：采集脚本只读 DOM —— 不点击、不输入、不发送、不改页面。
 * ★脱敏★：
 *   · 文本节点只留「长度 / 是否中文 / 词数」，不留原文。
 *   · title / aria-label / placeholder / alt 只留指纹 + 命中的功能关键词（send / group …）。
 *   · id / data-* / href 里的数字串一律打码；疑似人名、号码的值整体打码。
 *   · class / role / data-testid 是站点自己的结构标识，原样保留（长数字串打码）。
 *
 * 用法（在 desktop/ 下）：npm run probe:dom
 * 输出：desktop/scripts/probe-out/<平台>/<会话类型>-<时间>.json（已在 .gitignore）
 */
const { app, BrowserWindow, ipcMain, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const OUT_DIR = path.join(__dirname, 'probe-out')
const SKIP = new Set(['custom-web', 'tickets', 'pm-office', 'signal'])
const MAX_FRAMES = 12

app.setPath('userData', path.join(app.getPath('appData'), 'Hello Pix Probe'))

const PLATFORMS = require('../platforms.js').filter((p) => !SKIP.has(p.id))

/** 在页面（每个 frame）里执行。必须自包含 —— 会被 toString() 注入。 */
function probeSource () {
  const MAX_NODES = 6000
  const KW = ['send', 'reply', 'message', 'compose', 'type', 'write', 'input', 'group', 'member', 'participant',
    'unread', 'chat', 'conversation', 'thread', 'inbox', 'search', 'attach', 'emoji', 'voice', 'sticker',
    '发送', '消息', '群', '成员', '输入', '回复', '未读']
  const ENUM = /^[a-z][a-z0-9_:.-]{0,30}$/i

  const maskTok = (v) => String(v == null ? '' : v)
    .replace(/[0-9]/g, '#').replace(/[A-Za-z]/g, 'x').replace(/[\u4e00-\u9fff]/g, '字')
  const maskDigits = (v) => String(v == null ? '' : v).replace(/\d+/g, '#')
  const kwOf = (v) => {
    const s = String(v == null ? '' : v).toLowerCase()
    return KW.filter((k) => s.indexOf(k) >= 0)
  }
  /** 人类可读文案：只留形状与功能关键词。 */
  const fp = (v) => {
    const s = String(v == null ? '' : v).trim()
    if (!s) return ''
    return 'len=' + s.length + ',words=' + s.split(/\s+/).length +
      (/[\u4e00-\u9fff]/.test(s) ? ',cn' : '') + (/\d/.test(s) ? ',digits' : '') +
      (kwOf(s).length ? ',kw=' + kwOf(s).join('/') : '')
  }
  /** 结构类属性值：枚举样式（disabled / incoming / msg-out）原样，其余打码。 */
  const attrVal = (v) => {
    const s = String(v == null ? '' : v)
    if (ENUM.test(s) && !/\d{3,}/.test(s)) return s
    return maskTok(s).slice(0, 40)
  }
  const maskPath = (u) => {
    try {
      const x = new URL(u, location.href)
      return x.origin + x.pathname.split('/').map((seg) =>
        /^[a-z][a-z-]{0,13}$/.test(seg) ? seg : maskTok(seg).slice(0, 16)).join('/') +
        (x.hash ? '#' + maskTok(x.hash.slice(1)).slice(0, 24) : '')
    } catch (e) { return '' }
  }
  const classes = (el) => String((el.getAttribute && el.getAttribute('class')) || '')
    .split(/\s+/).filter(Boolean).map((t) => t.replace(/\d{5,}/g, '#n').slice(0, 48))

  const HUMAN_ATTRS = new Set(['title', 'aria-label', 'placeholder', 'alt', 'aria-description', 'aria-placeholder', 'data-placeholder'])
  const RAW_ATTRS = new Set(['role', 'data-testid', 'contenteditable', 'dir', 'type', 'aria-live', 'aria-multiline',
    'aria-selected', 'aria-expanded', 'aria-hidden', 'tabindex', 'data-icon', 'data-tab', 'lang', 'disabled'])

  const attrString = (el) => {
    let a = ''
    for (const at of Array.from(el.attributes || [])) {
      const n = at.name
      if (n === 'class') { a += ' class="' + classes(el).join(' ') + '"'; continue }
      if (n === 'style' || n === 'srcset' || n === 'd' || n === 'viewBox') continue
      if (HUMAN_ATTRS.has(n)) { a += ' ' + n + '="«' + fp(at.value) + '»"'; continue }
      if (n === 'href' || n === 'src') { a += ' ' + n + '="' + maskPath(at.value) + '"'; continue }
      if (n === 'id') { a += ' id="' + maskDigits(at.value).slice(0, 48) + '"'; continue }
      if (n === 'data-testid') { a += ' data-testid="' + maskDigits(at.value).slice(0, 60) + '"'; continue }
      if (RAW_ATTRS.has(n)) { a += ' ' + n + '="' + attrVal(at.value) + '"'; continue }
      if (n.indexOf('data-') === 0 || n.indexOf('aria-') === 0) { a += ' ' + n + '="' + attrVal(at.value) + '"' }
    }
    return a
  }

  /** 结构序列化：标签 + 脱敏属性 + 文本形状。 */
  const ser = (el, depth, budget) => {
    const b = budget || { n: 0 }
    if (!el || b.n > 600) return '…'
    b.n++
    if (el.nodeType === 3) {
      const t = String(el.textContent || '').trim()
      return t ? '«t:' + fp(t).replace(/,kw=.*$/, '') + '»' : ''
    }
    if (el.nodeType !== 1) return ''
    const tag = String(el.tagName || '').toLowerCase()
    if (tag === 'svg') return '<svg/>'
    if (tag === 'script' || tag === 'style') return ''
    const kids = depth > 0
      ? Array.from(el.childNodes || []).slice(0, 30).map((c) => ser(c, depth - 1, b)).join('')
      : (el.childNodes && el.childNodes.length ? '…' : '')
    return '<' + tag + attrString(el) + '>' + kids + '</' + tag + '>'
  }

  const sig = (el) => String(el.tagName || '').toLowerCase() +
    (el.id ? '#' + maskDigits(el.id).slice(0, 30) : '') +
    (classes(el).length ? '.' + classes(el).slice(0, 4).join('.') : '') +
    (el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : '') +
    (el.getAttribute('data-testid') ? '[testid=' + maskDigits(el.getAttribute('data-testid')).slice(0, 40) + ']' : '')

  const chain = (el, stopAt) => {
    const out = []
    let p = el
    for (let i = 0; i < 14 && p && p.nodeType === 1 && p !== stopAt; i++) {
      out.push(sig(p))
      p = p.parentElement
    }
    return out
  }

  const visible = (el) => {
    try {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    } catch (e) { return false }
  }
  const rectOf = (el) => {
    try {
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    } catch (e) { return null }
  }

  const all = Array.from(document.querySelectorAll('*')).slice(0, MAX_NODES * 4)
  const out = {
    origin: location.origin,
    path: maskPath(location.href),
    titleShape: maskTok(document.title).replace(/x{2,}/g, 'x+').slice(0, 80),
    titleDigitsShape: String(document.title || '').replace(/[^\d()[\]•·+\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30),
    nodeCount: all.length,
    viewport: { w: innerWidth, h: innerHeight }
  }

  // ---------- 1) 普查：属性名 / role / testid / 功能类 class ----------
  const census = (pick) => {
    const m = {}
    for (const el of all) for (const k of pick(el)) m[k] = (m[k] || 0) + 1
    return Object.keys(m).sort((a, b) => m[b] - m[a]).slice(0, 120).map((k) => k + ' x' + m[k])
  }
  out.attrNames = census((el) => Array.from(el.attributes || []).map((a) => a.name)
    .filter((n) => n !== 'class' && n !== 'style'))
  out.roles = census((el) => el.getAttribute('role') ? [el.getAttribute('role')] : [])
  out.testids = census((el) => el.getAttribute('data-testid') ? [maskDigits(el.getAttribute('data-testid'))] : [])
  out.dataIcons = census((el) => el.getAttribute('data-icon') ? [el.getAttribute('data-icon')] : [])
  const FUNC = /(msg|message|bubble|chat|conver|thread|incoming|outgoing|inbound|outbound|own|self|mine|sent|recei|composer|editor|input|textbox|send|reply|group|member|particip|author|sender|header|title|unread|badge|row|item|list|text|body|content|avatar|direction|^in$|^out$|^is-|left|right)/i
  out.funcClasses = census((el) => classes(el).filter((t) => FUNC.test(t)))

  // ---------- 2) 输入框候选 ----------
  const editables = all.filter((el) => {
    const tag = String(el.tagName).toLowerCase()
    if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === 'plaintext-only') return true
    if (tag === 'textarea') return true
    if (tag === 'input') return /^(text|search|)$/i.test(el.getAttribute('type') || '')
    return el.getAttribute('role') === 'textbox'
  })
  out.editables = editables.slice(0, 12).map((el) => ({
    visible: visible(el),
    rect: rectOf(el),
    ser: ser(el, 2).slice(0, 700),
    chain: chain(el)
  }))

  // ---------- 3) 发送按钮候选 ----------
  const SEND = /send|发送|submit|enviar|envoyer|senden|invia|отправ/i
  const btns = all.filter((el) => {
    const tag = String(el.tagName).toLowerCase()
    if (tag !== 'button' && el.getAttribute('role') !== 'button' && tag !== 'div' && tag !== 'span') return false
    const lab = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'),
      el.getAttribute('data-icon'), el.getAttribute('name'), classes(el).join(' ')].join(' ')
    if (SEND.test(lab)) return true
    return (tag === 'button' || el.getAttribute('role') === 'button') && SEND.test(String(el.textContent || '').slice(0, 20))
  })
  out.sendCandidates = btns.slice(0, 10).map((el) => ({
    visible: visible(el),
    rect: rectOf(el),
    ser: ser(el, 3).slice(0, 600),
    chain: chain(el).slice(0, 8)
  }))

  // ---------- 4) 重复结构（消息列表 / 会话列表）候选 ----------
  // 条目签名只取 tag + role + 首个 class：来/去消息往往只差一个修饰 class，必须归为同一类。
  const itemSig = (el) => String(el.tagName || '').toLowerCase() +
    (el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : '') +
    (classes(el).length ? '.' + classes(el)[0] : '')
  const lists = []
  for (const el of all) {
    const kids = Array.from(el.children || [])
    if (kids.length < 4) continue
    const counts = {}
    for (const k of kids) { const s = itemSig(k); counts[s] = (counts[s] || 0) + 1 }
    const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]
    const same = kids.filter((k) => itemSig(k) === top && String(k.textContent || '').trim().length > 0)
    if (same.length < 4) continue
    lists.push({ el, top, same, score: same.length })
  }
  lists.sort((a, b) => b.score - a.score)
  const chosen = []
  for (const l of lists) {
    if (chosen.length >= 6) break
    if (chosen.some((c) => c.el.contains(l.el) && c.score >= l.score)) continue
    chosen.push(l)
  }
  out.repeatingLists = chosen.map((l) => {
    // 区分符：只出现在部分条目子树里的 class / data-* 值（incoming vs outgoing、群里的发送者名…）
    const tokCount = {}
    for (const item of l.same) {
      const seen = new Set()
      const walk = (n, d) => {
        if (!n || n.nodeType !== 1 || d > 5) return
        for (const t of classes(n)) seen.add('class:' + t)
        for (const at of Array.from(n.attributes || [])) {
          if (at.name.indexOf('data-') === 0 && ENUM.test(at.value) && !/\d{3,}/.test(at.value)) seen.add(at.name + '=' + at.value)
          if (at.name === 'role' || at.name === 'data-testid' || at.name === 'data-icon') seen.add(at.name + '=' + maskDigits(at.value))
        }
        for (const c of Array.from(n.children || [])) walk(c, d + 1)
      }
      walk(item, 0)
      for (const t of seen) tokCount[t] = (tokCount[t] || 0) + 1
    }
    const n = l.same.length
    const discriminators = Object.keys(tokCount)
      .filter((t) => tokCount[t] > 0 && tokCount[t] < n)
      .sort((a, b) => tokCount[b] - tokCount[a])
      .slice(0, 60)
      .map((t) => t + ' ' + tokCount[t] + '/' + n)
    const pick = l.same.length > 5 ? l.same.slice(0, 2).concat(l.same.slice(-3)) : l.same
    return {
      container: sig(l.el),
      containerChain: chain(l.el).slice(0, 10),
      containerRect: rectOf(l.el),
      childCount: l.el.children.length,
      itemSig: l.top,
      itemCount: n,
      discriminators,
      samples: pick.map((it) => ({ rect: rectOf(it), ser: ser(it, 9).slice(0, 2600) }))
    }
  })

  // ---------- 5) 头部（会话标题 / 成员数 / 在线状态）----------
  const heads = all.filter((el) => {
    const tag = String(el.tagName).toLowerCase()
    return (tag === 'header' || tag === 'h1' || tag === 'h2' || tag === 'h3' || el.getAttribute('role') === 'banner' ||
      el.getAttribute('role') === 'heading') && visible(el)
  })
  out.headers = heads.slice(0, 10).map((el) => ({ rect: rectOf(el), ser: ser(el, 6).slice(0, 1400), chain: chain(el).slice(0, 6) }))

  // ---------- 6) 群聊信号：任何属性 / 短文本里出现 group / members / 群 ----------
  const GROUP = /group|member|participant|群|成员|channel|频道/i
  const gm = []
  for (const el of all) {
    for (const at of Array.from(el.attributes || [])) {
      if (at.name === 'class' || at.name === 'style') continue
      if (!GROUP.test(at.value)) continue
      gm.push({ sig: sig(el).slice(0, 120), attr: at.name, val: HUMAN_ATTRS.has(at.name) ? '«' + fp(at.value) + '»' : attrVal(at.value) })
    }
    if (gm.length >= 40) break
  }
  out.groupSignals = gm
  out.groupClassTokens = census((el) => classes(el).filter((t) => GROUP.test(t)))

  // ---------- 7) 其他结构线索 ----------
  out.iframes = Array.from(document.querySelectorAll('iframe')).slice(0, 12).map((f) => ({
    src: maskPath(f.getAttribute('src') || ''), rect: rectOf(f), visible: visible(f)
  }))
  out.shadowHosts = all.filter((el) => el.shadowRoot).length
  out.ariaLive = all.filter((el) => el.getAttribute('aria-live')).slice(0, 8).map((el) => ({ sig: sig(el), live: el.getAttribute('aria-live') }))
  return out
}

const wins = new Map()
let panel = null
let current = null

function stamp () {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

function openPlatform (id) {
  const p = PLATFORMS.find((x) => x.id === id)
  if (!p) return { ok: false, error: 'unknown platform ' + id }
  current = id
  const existing = wins.get(id)
  if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return { ok: true } }
  const partition = 'persist:pixprobe-' + id
  session.fromPartition(partition).setUserAgent(CHROME_UA)
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Probe · ' + p.name,
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  })
  win.webContents.setUserAgent(CHROME_UA)
  win.loadURL(p.url, { userAgent: CHROME_UA }).catch(() => {})
  win.on('closed', () => { if (wins.get(id) === win) wins.delete(id) })
  wins.set(id, win)
  return { ok: true }
}

async function collect (label) {
  const win = current && wins.get(current)
  if (!win || win.isDestroyed()) return { ok: false, error: '先打开一个平台' }
  const frames = [win.webContents.mainFrame].concat(
    win.webContents.mainFrame.framesInSubtree.filter((f) => f !== win.webContents.mainFrame)
  ).slice(0, MAX_FRAMES)
  const code = '(' + probeSource.toString() + ')()'
  const results = []
  for (const f of frames) {
    try {
      results.push(await f.executeJavaScript(code))
    } catch (e) {
      results.push({ origin: (() => { try { return new URL(f.url).origin } catch (_) { return '' } })(), error: String((e && e.message) || e).slice(0, 200) })
    }
  }
  const report = {
    platform: current,
    label,
    collectedAt: new Date().toISOString(),
    electron: process.versions.electron,
    frames: results
  }
  const dir = path.join(OUT_DIR, current)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, label + '-' + stamp() + '.json')
  fs.writeFileSync(file, JSON.stringify(report, null, 2))
  const top = results[0] || {}
  return {
    ok: true,
    file: path.relative(path.join(__dirname, '..'), file),
    summary: '帧 ' + results.length + ' · 重复列表 ' + ((top.repeatingLists || []).length) +
      ' · 输入框 ' + ((top.editables || []).length) + ' · 发送候选 ' + ((top.sendCandidates || []).length)
  }
}

function panelHtml () {
  const opts = PLATFORMS.map((p) => '<option value="' + p.id + '">' + p.name + '</option>').join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>结构采集</title><style>
body{font:13px -apple-system,system-ui,sans-serif;margin:14px;background:#0b1a2e;color:#e5edf7}
select,button{font:inherit;width:100%;margin:4px 0 10px;padding:7px;border-radius:7px;border:1px solid #2a3b55;background:#13253f;color:#e5edf7}
button{background:#2563eb;border:none;cursor:pointer}button.alt{background:#334155}
.hint{color:#93a4bd;line-height:1.55;margin-bottom:10px}#log{white-space:pre-wrap;color:#a7f3d0;font-size:12px;max-height:220px;overflow:auto}
</style></head><body>
<div class="hint">1. 选平台 → 打开 → 在弹出的窗口里登录<br>2. 打开一个<b>私聊</b>，点「采集·私聊」<br>3. 打开一个<b>群聊</b>，点「采集·群聊」<br>只读：不会点击、输入或发送任何内容；文字内容不会被记录。</div>
<select id="p">${opts}</select>
<button id="open">打开 / 切到这个平台</button>
<button id="c-private">采集 · 私聊</button>
<button id="c-group">采集 · 群聊</button>
<button id="c-list" class="alt">采集 · 会话列表页（未打开会话）</button>
<button id="quit" class="alt">全部完成，退出</button>
<div id="log"></div>
<script>
const { ipcRenderer } = require('electron')
const log = (s) => { const el = document.getElementById('log'); el.textContent = s + '\\n' + el.textContent }
document.getElementById('open').onclick = async () => {
  const id = document.getElementById('p').value
  const r = await ipcRenderer.invoke('probe:open', id)
  log(r.ok ? '已打开 ' + id : '失败：' + r.error)
}
for (const k of ['private', 'group', 'list']) {
  document.getElementById('c-' + k).onclick = async () => {
    log('采集中…')
    const r = await ipcRenderer.invoke('probe:collect', k)
    log(r.ok ? '✔ ' + r.file + '\\n  ' + r.summary : '✖ ' + r.error)
  }
}
document.getElementById('quit').onclick = () => ipcRenderer.invoke('probe:quit')
</script></body></html>`
}

/** PIX_PROBE_SELFTEST=<平台id>：不开面板，打开该平台 → 等页面 → 采一次「list」→ 打印结果并退出。 */
async function selfTest (id) {
  const r = openPlatform(id)
  if (!r.ok) { console.log('[probe] ' + r.error); app.exit(2); return }
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.PIX_PROBE_WAIT_MS || 9000)))
  const c = await collect('list')
  console.log('[probe] ' + JSON.stringify(c))
  app.exit(c.ok ? 0 : 1)
}

app.whenReady().then(() => {
  if (process.env.PIX_PROBE_SELFTEST) { selfTest(process.env.PIX_PROBE_SELFTEST); return }
  ipcMain.handle('probe:open', (_e, id) => openPlatform(id))
  ipcMain.handle('probe:collect', (_e, label) => collect(['private', 'group', 'list'].includes(label) ? label : 'other'))
  ipcMain.handle('probe:quit', () => app.quit())
  panel = new BrowserWindow({
    width: 340,
    height: 520,
    x: 20,
    y: 60,
    alwaysOnTop: true,
    title: '结构采集',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  panel.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(panelHtml()))
  panel.on('closed', () => app.quit())
})

app.on('window-all-closed', () => {})
