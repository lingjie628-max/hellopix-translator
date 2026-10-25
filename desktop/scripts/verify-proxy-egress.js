'use strict'

/**
 * 真机验证：设了代理之后，页面里能不能拿到真实 IP。
 *
 * 单元测试只能证明"那行开关还在代码里"，证明不了 Chromium 真的听了。
 * 这个脚本起一个真实 Electron，用和客户端一样的方式：
 *   1. 一个分区 + setProxy 指向一个**不存在的**代理端口
 *   2. 在里面加载一个会打印 ICE candidate 的页面
 *
 * 判据：
 *   · 代理连不上 → 页面根本加载不出来（说明没有退回直连）✔
 *   · WebRTC 策略生效 → 即使加载出来，ICE candidate 里也不该出现真实公网 IP
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/verify-proxy-egress.js
 */

const { app, session, BrowserWindow } = require('electron')

/**
 * WebRTC 防泄漏 —— 挂在 webContents 上，不在 session 上。
 *
 * 两个坑都实测踩过：
 *   1. 命令行开关 `--force-webrtc-ip-handling-policy` 在 Electron 33 里**不存在**
 *      （二进制里只有 force-webrtc-ip-permission-check；`disable_non_proxied_udp`
 *      只是策略的**取值**，不是开关名）。
 *   2. `session.setWebRTCIPHandlingPolicy` 也**不存在**（直接 TypeError）——
 *      它挂在 webContents 上。
 */
const WEBRTC_POLICY = process.env.PIX_WEBRTC_OFF === '1'
  ? 'default'
  : 'disable_non_proxied_udp'

function guardContents (wc) {
  if (typeof wc.setWebRTCIPHandlingPolicy === 'function') {
    wc.setWebRTCIPHandlingPolicy(WEBRTC_POLICY)
  }
  return wc
}

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><body><pre id="out">running…</pre><script>
const out = document.getElementById('out')
const lines = []
function log(s) { lines.push(s); out.textContent = lines.join('\\n') }

const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
pc.createDataChannel('probe')
pc.onicecandidate = e => {
  if (!e.candidate) { log('ICE_DONE'); window.__iceDone = lines.slice(); return }
  log('CANDIDATE ' + e.candidate.candidate)
}
pc.createOffer().then(o => pc.setLocalDescription(o))

// 同时测一次普通 HTTP 请求能不能出去（走代理时应当失败）
fetch('https://api.ipify.org?format=json', { cache: 'no-store' })
  .then(r => r.text())
  .then(t => log('HTTP_IP ' + t))
  .catch(e => log('HTTP_FAIL ' + e.message))

setTimeout(() => { window.__final = lines.slice(); log('TIMEOUT') }, 8000)
</script></body></html>`)}`

function collect (wc, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ lines: [], note: '超时，页面没能执行脚本' }), ms)
    wc.once('did-finish-load', () => {
      setTimeout(async () => {
        clearTimeout(timer)
        try {
          const lines = await wc.executeJavaScript('(window.__final || window.__iceDone || [])')
          resolve({ lines: Array.isArray(lines) ? lines : [], note: '' })
        } catch (e) {
          resolve({ lines: [], note: '取值失败：' + e.message })
        }
      }, 600)
    })
  })
}

/**
 * 在页面里跑一次 ICE 收集，返回全部 candidate 字符串。
 *
 * 用 file:// 加载一个真实的 HTML 文件 —— data: URL 上 WebRTC 受限，
 * 一个 candidate 都不出（对照组证实过），那样的"没泄漏"什么都没证明。
 */
async function probeIce (wc) {
  const file = require('path').join(require('os').tmpdir(), 'pix-ice-probe.html')
  require('fs').writeFileSync(file, `<!doctype html><html><body><script>
    window.__cands = []
    window.__done = false
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
      pc.createDataChannel('probe')
      pc.onicecandidate = e => {
        if (!e.candidate) { window.__done = true; return }
        window.__cands.push(e.candidate.candidate)
      }
      pc.createOffer().then(o => pc.setLocalDescription(o))
      setTimeout(() => { window.__done = true }, 6000)
    } catch (err) { window.__err = String(err); window.__done = true }
  </script></body></html>`)
  await wc.loadURL('file://' + file)
  for (let i = 0; i < 40; i++) {
    const done = await wc.executeJavaScript('window.__done === true || (window.__cands || []).length > 0')
    if (done) {
      const st = await wc.executeJavaScript('window.__done === true')
      if (st) break
    }
    await new Promise(r => setTimeout(r, 200))
  }
  const err = await wc.executeJavaScript('window.__err || ""')
  if (err) console.log('[B] 页面报错：' + err)
  // 0 条 candidate 有两种解释，必须分清：
  //   · 有 RTCPeerConnection 且 readyState 正常 → 策略把候选全挡了（我们要的）
  //   · 根本没建起来 → 等于把通话功能砍了（不可接受）
  const diag = await wc.executeJavaScript('({ hasPc: typeof RTCPeerConnection === "function", done: window.__done === true, n: (window.__cands||[]).length })')
  console.log('[B] 诊断：RTCPeerConnection=' + diag.hasPc + ' 收集结束=' + diag.done + ' 候选数=' + diag.n)
  return await wc.executeJavaScript('window.__cands || []')
}

app.whenReady().then(async () => {
  // 关窗口不能顺手把进程带走 —— 这里要连续跑两个场景
  app.on('window-all-closed', () => {})
  let bad = 0

  /* ---- 场景 A：代理指向一个不存在的端口，页面必须加载失败 ---- */
  {
    const ses = session.fromPartition('verify:dead-proxy')
    await ses.setProxy({ proxyRules: 'socks5://127.0.0.1:1', proxyBypassRules: '<local>' })
    const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { partition: 'verify:dead-proxy' } })
    let failed = null
    win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (isMain) failed = { code, desc }
    })
    const job = win.webContents.loadURL('https://api.ipify.org?format=json').catch(e => ({ err: e }))
    await Promise.race([job, new Promise(r => setTimeout(r, 15000))])
    const verdict = failed ? '✔ 代理不通 → 加载失败（没有退回直连）' : '✘ 代理不通却仍然加载成功 —— 疑似退回直连'
    if (!failed) bad++
    console.log('[A] ' + verdict + (failed ? '  code=' + failed.code + ' ' + failed.desc : ''))
    win.destroy()
  }

  /* ---- 场景 B：WebRTC 在无代理时不得泄漏真实公网 IP ---- */
  {
    const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { partition: 'verify:webrtc' } })
    // 策略挂在 webContents 上：必须在窗口建好之后、加载页面之前设
    guardContents(win.webContents)
    const actual = typeof win.webContents.getWebRTCIPHandlingPolicy === 'function'
      ? win.webContents.getWebRTCIPHandlingPolicy() : '(无此 API)'
    console.log('[B] 该 webContents 策略 = ' + actual)
    // 用真实 origin 的页面跑 ICE（data: URL 上 WebRTC 受限，出不来 candidate）
    const candidates = await probeIce(win.webContents)
    // 只关心 IPv4 字面量；mDNS（*.local）是 Chromium 的隐藏手段，属于"没泄漏"
    const leaky = candidates.filter(l => {
      const m = l.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)
      if (!m) return false
      return m[1] !== '0.0.0.0'
    })
    console.log('[B] ICE candidate 共 ' + candidates.length + ' 条')
    for (const c of candidates) console.log('     ' + c)
    if (leaky.length) {
      console.log('[B] ✘ 发现裸露 IP 的 candidate：' + leaky.length + ' 条 —— 真实 IP 会泄漏')
      bad++
    } else {
      console.log('[B] ✔ 没有任何裸露 IPv4 的 candidate（mDNS 化 / 被策略挡掉）')
    }
    win.destroy()
  }

  console.log(bad ? '\n结果：' + bad + ' 项不合格' : '\n结果：两项全部合格')
  app.exit(bad ? 1 : 0)
})
