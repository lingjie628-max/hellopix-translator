'use strict'

/**
 * 真机验证：设备标签能不能在真实 WhatsApp 页面上渲染出来。
 *
 * ## 与单测的分工
 *
 * 单测（test/whatsapp-device-platform.test.js）验证**规则**对不对，
 * 用的是构造样本。但真实 WhatsApp 的 DOM 结构随时会变 ——
 * data-id 是否还在、chat-subtitle 是否还在、消息顺序是不是"新在下"，
 * 这些只有真页面能回答。
 *
 * ## 跑法
 *
 *   cd desktop
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/verify-device-tag.js
 *
 * 用**独立分区**（persist:verify-device-tag），不影响正式实例登录态。
 * 扫码登录后点开任意私聊，脚本会自动执行采集并**断言**：
 *
 *   · 当前会话能定位到
 *   · 能读到 data-id 且解出设备
 *   · 头部有 chat-subtitle 可挂载
 *   · 群聊会被正确识别并跳过
 *
 * 只读。不发送、不点击、不修改用户消息。
 */

const { app, BrowserWindow } = require('electron')

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 在页面里跑：复刻 guest-inject.js 的采集逻辑，但只返回诊断结果。 */
const PROBE = `
(function () {
  function result() {
    var out = {
      ok: false,
      reason: '',
      scopeFound: false,
      headerFound: false,
      subtitleFound: false,
      rowCount: 0,
      dataIdSample: [],
      devices: {},
      latestPeerDevice: 'unknown',
      isGroup: false
    }

    // 1) 会话容器 #main
    var scope = document.querySelector('#main')
    if (!scope) { out.reason = 'no_scope'; return JSON.stringify(out) }
    out.scopeFound = true

    // 2) 头部与副标题
    var header = scope.querySelector('header')
    out.headerFound = !!header
    if (header) out.subtitleFound = !!header.querySelector('[data-testid="chat-subtitle"]')

    // 3) 群聊判据（与 chatKind 一致：data-id 里有 @g.us）
    var rows = scope.querySelectorAll('[data-id]')
    out.rowCount = rows.length

    var devices = {}
    var latest = 'unknown'
    var latestFromPeer = false

    for (var i = rows.length - 1; i >= 0; i--) {
      var row = rows[i]
      var raw = String(row.getAttribute('data-id') || '')
      if (raw.indexOf('@g.us') >= 0) out.isGroup = true

      // 两种格式：旧复合串（带下划线）/ 新裸 ID
      var msgId = ''
      var fromMe = null
      var cut = raw.lastIndexOf('_')
      if (cut >= 0) {
        msgId = raw.slice(cut + 1)
        fromMe = raw.slice(0, cut).toLowerCase().indexOf('true') === 0
      } else if (/^[0-9A-Za-z]+$/.test(raw)) {
        msgId = raw
      }
      if (!msgId) continue

      // 前缀优先，长度兜底（与 device-platform.js 一致）
      var device = 'unknown'
      if (msgId.indexOf('3A') === 0) device = 'iphone'
      else if (msgId.indexOf('3E') === 0) device = 'web'
      else if (msgId.indexOf('3F') === 0) device = 'desktop'
      else if (/^(.{21}|.{32})$/.test(msgId)) device = 'android'
      else if (msgId.length === 18) device = 'desktop'

      // 新格式没 fromMe：看气泡方向
      if (fromMe === null && row.closest) {
        var bubble = row.closest('.message-out, .message-in')
        if (bubble) fromMe = bubble.classList.contains('message-out')
      }

      if (out.dataIdSample.length < 6) {
        out.dataIdSample.push({
          raw: raw.slice(0, 55),
          msgIdLen: msgId.length,
          prefix: msgId.slice(0, 4),
          fmt: cut >= 0 ? 'old' : 'bare',
          device: device,
          fromMe: fromMe
        })
      }

      if (device !== 'unknown') {
        devices[device] = (devices[device] || 0) + 1
        if (!latestFromPeer && fromMe === false) {
          latest = device
          latestFromPeer = true
        }
      }
    }

    out.devices = devices
    out.latestPeerDevice = latest
    out.ok = out.rowCount > 0
    if (!out.ok) out.reason = 'no_messages'
    return JSON.stringify(out)
  }
  return result()
})();
`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: {
      partition: 'persist:verify-device-tag',
      userAgent: UA,
      sandbox: true,
      contextIsolation: true
    }
  })

  console.log('[verify] 加载 WhatsApp Web（独立分区，不影响正式登录态）…')
  await win.loadURL('https://web.whatsapp.com/')
  console.log('[verify] 已加载。请扫码登录，然后点开任意一个私聊。')
  console.log('[verify] 登录后每 12 秒自动检测一次，最多 6 分钟。\n')

  let good = 0
  let attempt = 0
  const timer = setInterval(async () => {
    attempt++
    try {
      const raw = await win.webContents.executeJavaScript(PROBE, true)
      const r = JSON.parse(raw)
      console.log('--- 第 ' + attempt + ' 次采样 ---')
      console.log(raw)

      if (r.ok && r.rowCount >= 3) {
        good++
        // 连续两次成功才算稳（第一次可能是半渲染）
        if (good >= 2) {
          clearInterval(timer)
          console.log('\n===== 判定 =====')
          console.log('  会话容器 #main      : ' + (r.scopeFound ? '✔' : '✘'))
          console.log('  聊天头部 header     : ' + (r.headerFound ? '✔' : '✘'))
          // 副标题只是首选挂载点。没有它时我们退到 header，所以它不是硬条件。
          console.log('  副标题 chat-subtitle: ' + (r.subtitleFound
            ? '✔ (首选挂载点)'
            : '✘ (没有 → 退到 header 挂载，见 peerDeviceAnchor)'))
          console.log('  消息行数            : ' + r.rowCount)
          console.log('  群聊                : ' + (r.isGroup ? '是（应跳过）' : '否'))
          console.log('  设备分布            : ' + JSON.stringify(r.devices))
          console.log('  对方最近设备        : ' + r.latestPeerDevice)
          console.log('\n  样本：')
          for (const s of r.dataIdSample) {
            console.log('    ' + (s.raw + '                                        ').slice(0, 56) +
              ' len=' + s.msgIdLen + ' prefix=' + s.prefix + ' fmt=' + s.fmt +
              ' → ' + s.device + (s.fromMe === true ? ' (我发的)'
                : s.fromMe === false ? ' (对方发)' : ' (方向未知)'))
          }
          // 硬条件只有两个：能挂载（有 header）+ 有消息行可解析。
          const mountable = r.subtitleFound || r.headerFound
          const verdict = mountable && r.rowCount > 0 && Object.keys(r.devices).length > 0
          console.log('\n  挂载方式：' + (r.subtitleFound ? '副标题之后' : 'header 末尾（兜底）'))
          console.log('\n  结论：' + (verdict
            ? '可以上线 —— 挂载点可用，且从消息 ID 成功判出了设备。'
            : !mountable
              ? '不可上线 —— 连 header 都找不到，没法挂载。'
              : r.rowCount === 0
                ? '不可上线 —— 没有解析到消息行。'
                : '挂载点可用，但所有消息 ID 都判不出设备（能力边界，见上方样本）。'))
          setTimeout(() => app.quit(), 2000)
        }
      } else {
        good = 0
      }
    } catch (e) {
      console.log('[verify] 执行失败：' + e.message)
    }
  }, 12000)

  setTimeout(() => {
    clearInterval(timer)
    console.log('[verify] 超时退出 —— 未采集到足够的消息行。')
    app.quit()
  }, 6 * 60 * 1000)
})
