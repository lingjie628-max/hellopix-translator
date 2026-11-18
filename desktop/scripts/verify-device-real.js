'use strict'

/**
 * 用**真实登录态**验证设备标签（只读）。
 *
 * ## 和 verify-device-tag.js 的区别
 *
 * verify-device-tag.js 用独立分区 `persist:verify-device-tag`，每次要重新扫码。
 * 这个脚本直接打开你已登录的某个 WhatsApp 分区 —— **不用扫码**。
 *
 * ## 安全边界（必须守住）
 *
 *   · 只 `loadURL` + 注入**只读**脚本，不点击、不输入、不发送、不滚动页面内容
 *   · 不调用任何写入类 IPC
 *   · 退出时**不落盘**会话变更（Electron 自己会维护 cookie，但脚本不改任何东西）
 *   · 不删除、不清理任何分区文件
 *
 * 用法：
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/verify-device-real.js [分区名]
 *
 * 分区名不带 `pix-` / `persist:` 前缀，例如 `pix-whatsapp-1`。
 * 不传则自动挑第一个能进 #main 的。
 */

const electron = require('electron')
const { app, BrowserWindow, session } = electron

// ★ 必须在任何 app.getPath() 之前 ★ —— userData 与 Keychain 条目都由 app name 推导
app.setName('Hello Pix')

const PARTITION_ARG = process.argv.find((a) => /^pix-/.test(a)) || ''

// 候选分区：优先用户指定的，其次按「最近修改」排的 WhatsApp 分区
const fs = require('fs')
const path = require('path')
const PART_DIR = path.join(app.getPath('userData'), 'Partitions')

function listWhatsappPartitions () {
  let names = []
  try { names = fs.readdirSync(PART_DIR) } catch (e) { return [] }
  return names
    .filter((n) => n.indexOf('pix-') === 0 && n.indexOf('whatsapp') >= 0)
    .map((n) => {
      let mtime = 0
      try { mtime = fs.statSync(path.join(PART_DIR, n)).mtimeMs } catch (e) {}
      return { name: n, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.name)
}

/** 在页面里执行：只读采集 + 渲染标签，返回观察结果。必须自包含。 */
const PROBE = `(function () {
  var out = {
    ok: false, scopeFound: false, headerFound: false, subtitleFound: false,
    mountMode: '', tagMounted: false, tagText: '', tagDevice: '',
    tagRect: null, headerRect: null, rowCount: 0, devices: {},
    latestPeerDevice: 'unknown', dataIdSample: [], isGroup: false
  }
  try {
    var main = document.querySelector('#main')
    out.scopeFound = !!main
    if (!main) return JSON.stringify(out)

    var header = main.querySelector('header')
    out.headerFound = !!header
    if (header) {
      var r = header.getBoundingClientRect()
      out.headerRect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    }

    // 采集（与 guest-inject.js 同规则：前缀优先，长度兜底）
    var rows = main.querySelectorAll('[data-id]')
    out.rowCount = rows.length
    var latest = 'unknown'
    var latestFromPeer = false
    for (var i = rows.length - 1; i >= 0; i--) {
      var row = rows[i]
      var raw = String(row.getAttribute('data-id') || '')
      if (raw.indexOf('@g.us') >= 0) out.isGroup = true
      var msgId = ''
      var fromMe = null
      var cut = raw.lastIndexOf('_')
      if (cut >= 0) { msgId = raw.slice(cut + 1); fromMe = raw.slice(0, cut).toLowerCase().indexOf('true') === 0 }
      else if (/^[0-9A-Za-z]+$/.test(raw)) msgId = raw
      if (!msgId) continue

      var device = 'unknown'
      if (msgId.indexOf('3A') === 0) device = 'iphone'
      else if (msgId.indexOf('3E') === 0) device = 'web'
      else if (msgId.indexOf('3F') === 0) device = 'desktop'
      else if (/^(.{21}|.{32})$/.test(msgId)) device = 'android'
      else if (msgId.length === 18) device = 'desktop'

      if (fromMe === null && row.closest) {
        var bubble = row.closest('.message-out, .message-in')
        if (bubble) fromMe = bubble.classList.contains('message-out')
      }

      if (out.dataIdSample.length < 6) {
        out.dataIdSample.push({ raw: raw.slice(0, 50), len: msgId.length, device: device, fromMe: fromMe })
      }
      if (device !== 'unknown') {
        out.devices[device] = (out.devices[device] || 0) + 1
        if (!latestFromPeer && fromMe === false) { latest = device; latestFromPeer = true }
      }
    }
    out.latestPeerDevice = latest

    // ---- 按 guest-inject.js 的新逻辑渲染（副标题优先，header 兜底）----
    // 只在这里造一个演示标签，验证位置，不改任何 WhatsApp 状态。
    var old = document.querySelector('.pix-peer-device')
    if (old && old.parentNode) old.parentNode.removeChild(old)

    var subtitle = header ? header.querySelector('[data-testid="chat-subtitle"]') : null
    out.subtitleFound = !!subtitle

    var LABELS = { android: '安卓', iphone: 'iPhone', desktop: '电脑版', web: '网页版', unknown: '未知设备' }
    if (header) {
      var tag = document.createElement('span')
      tag.className = 'pix-peer-device'
      tag.setAttribute('data-pix-ui', 'peer-device')
      tag.setAttribute('data-device', latest)
      tag.textContent = LABELS[latest] || '未知设备'
      tag.style.cssText = 'display:inline-flex;align-items:center;gap:3px;margin-left:6px;' +
        'padding:1px 6px;border-radius:8px;font-size:11px;line-height:16px;font-weight:500;' +
        'vertical-align:middle;white-space:nowrap;background:rgba(128,128,128,.18);color:inherit;opacity:.85'

      if (subtitle && subtitle.parentNode) {
        out.mountMode = 'after-subtitle'
        if (subtitle.nextSibling) subtitle.parentNode.insertBefore(tag, subtitle.nextSibling)
        else subtitle.parentNode.appendChild(tag)
      } else {
        out.mountMode = 'header-append'
        header.appendChild(tag)
      }
      var tr = tag.getBoundingClientRect()
      out.tagRect = { x: Math.round(tr.x), y: Math.round(tr.y), w: Math.round(tr.width), h: Math.round(tr.height) }
      out.tagMounted = tr.width > 0 && tr.height > 0
      out.tagText = tag.textContent
      out.tagDevice = latest
    }
    out.ok = true
  } catch (e) {
    out.error = String(e && e.message || e)
  }
  return JSON.stringify(out)
})()`

const SAMPLES = [] // 每次采样的结果，最后统一输出

async function probeOnce (win) {
  const raw = await win.webContents.executeJavaScript(PROBE, true)
  return JSON.parse(raw)
}

function findWhatsappView (win) {
  // WhatsApp 页面可能在主窗口的 webview 里，也可能就是主窗口本身 —— 都试一遍
  const contents = []
  try {
    const all = require('electron').webContents.getAllWebContents()
    for (const wc of all) {
      const url = String(wc.getURL() || '')
      if (/web\.whatsapp\.com/.test(url)) contents.push(wc)
    }
  } catch (e) {}
  return contents
}

function pickPartition () {
  const list = listWhatsappPartitions()
  if (!list.length) return ''
  if (PARTITION_ARG && list.indexOf(PARTITION_ARG) >= 0) return PARTITION_ARG
  return list[0]
}

app.whenReady().then(async () => {
  const partition = pickPartition()
  console.log('[real] userData = ' + app.getPath('userData'))
  console.log('[real] 候选 WhatsApp 分区：' + (listWhatsappPartitions().join(', ') || '(无)'))
  if (!partition) {
    console.log('[real] 没有找到 WhatsApp 分区，退出。')
    app.quit(); return
  }
  console.log('[real] 使用分区：persist:' + partition + '（只读验证，不改登录态）')

  const ses = session.fromPartition('persist:' + partition)
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    title: '设备标签只读验证（不会改你的登录态）',
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.webContents.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  )

  await win.loadURL('https://web.whatsapp.com/')
  console.log('[real] 已用你的登录态加载 WhatsApp Web。')
  console.log('[real] 请点开一个私聊（对方最好发过消息），每 10 秒采样一次。')

  let attempt = 0
  let good = 0

  const timer = setInterval(async () => {
    attempt++
    try {
      const r = await probeOnce(win)
      console.log('--- 第 ' + attempt + ' 次 --- ' + JSON.stringify({
        scope: r.scopeFound, header: r.headerFound, subtitle: r.subtitleFound,
        rows: r.rowCount, mount: r.mountMode, tag: r.tagText, tagMounted: r.tagMounted,
        devices: r.devices, latest: r.latestPeerDevice
      }))

      // 没拿到 #main 时，补一句页面到底停在哪儿，方便判断是「没登录」还是「没点会话」
      if (!r.scopeFound) {
        try {
          const where = await win.webContents.executeJavaScript(
            'JSON.stringify({' +
            '  qr: !!document.querySelector("[data-ref], canvas[aria-label*=QR i], [data-testid*=qrcode i]"),' +
            '  chatList: !!document.querySelector("#pane-side"),' +
            '  title: String(document.title || "").slice(0, 40),' +
            '  bodyLen: (document.body ? document.body.innerText.length : 0)' +
            '})', true)
          console.log('      页面状态：' + where)
        } catch (e) {}
      }

      if (r.ok && r.rowCount > 0) {
        SAMPLES.push(r)
        good++
        if (good >= 2) {
          clearInterval(timer)
          printReport(SAMPLES[SAMPLES.length - 1])
          setTimeout(() => app.quit(), 1500)
        }
      } else {
        good = 0
      }
    } catch (e) {
      console.log('[real] 采样失败：' + e.message)
    }
  }, 10000)

  setTimeout(() => {
    clearInterval(timer)
    if (SAMPLES.length) {
      printReport(SAMPLES[SAMPLES.length - 1])
    } else {
      console.log('\n[real] 超时 —— 一直没拿到 #main（可能还没点开任何会话）。')
    }
    app.quit()
  }, 9 * 60 * 1000)
})

function printReport (r) {
  console.log('\n===== 真实登录态验证结果 =====')
  console.log('  会话容器 #main       : ' + (r.scopeFound ? '✔' : '✘'))
  console.log('  聊天头部 header      : ' + (r.headerFound ? '✔' : '✘'))
  console.log('  副标题 chat-subtitle : ' + (r.subtitleFound ? '✔ 存在' : '✘ 不存在（走 header 兜底）'))
  console.log('  挂载方式             : ' + r.mountMode)
  console.log('  标签是否真的渲染出来 : ' + (r.tagMounted ? '✔ 是' : '✘ 否（尺寸为 0，用户看不到）'))
  console.log('  标签文字             : ' + JSON.stringify(r.tagText))
  console.log('  标签位置(px)         : ' + JSON.stringify(r.tagRect))
  console.log('  header 位置(px)      : ' + JSON.stringify(r.headerRect))
  if (r.tagRect && r.headerRect) {
    const inside = r.tagRect.x >= r.headerRect.x &&
      r.tagRect.y >= r.headerRect.y &&
      r.tagRect.x + r.tagRect.w <= r.headerRect.x + r.headerRect.w + 1 &&
      r.tagRect.y + r.tagRect.h <= r.headerRect.y + r.headerRect.h + 1
    console.log('  标签在 header 内     : ' + (inside ? '✔ 没跑出去' : '✘ 超出 header 范围'))
  }
  console.log('  消息行数             : ' + r.rowCount)
  console.log('  设备分布             : ' + JSON.stringify(r.devices))
  console.log('  对方最近设备         : ' + r.latestPeerDevice)
  console.log('\n  样本：')
  for (const s of r.dataIdSample) {
    console.log('    ' + (s.raw + '                              ').slice(0, 46) +
      ' len=' + s.len + ' → ' + s.device +
      ' (' + (s.fromMe === true ? '我发的' : s.fromMe === false ? '对方发' : '方向未知') + ')')
  }
  const pass = r.headerFound && r.tagMounted && Object.keys(r.devices).length > 0
  console.log('\n  结论：' + (pass
    ? '✔ 通过 —— 标签挂载成功，且能从真实消息判出设备。'
    : !r.headerFound
      ? '✘ 失败 —— 找不到 header。'
      : !r.tagMounted
        ? '✘ 失败 —— 标签尺寸为 0，用户看不见。'
        : '△ 挂载成功，但这批消息的设备都判不出来（能力边界）。'))
}

app.on('window-all-closed', () => app.quit())
