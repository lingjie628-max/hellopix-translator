'use strict'
/**
 * 真机验证：「翻译图片」按钮能不能被**真实鼠标**点到。
 *
 * ## 这个脚本为什么必须存在
 *
 * 2026-10-29 用户报"点开图片找不到翻译图片的按钮"。光看代码是看不出来的：
 * 按钮建了、样式正确、`display:flex`、`getBoundingClientRect` 有值 ——
 * 一切"看起来都对"。
 *
 * 前一次探针发现的关键事实：按钮在**隔离世界**里创建时，真机探针给的是
 *
 *   步骤2  hasBtn:true  btnShow:"1"  btnDisplay:"flex"  btnRect:[804,98,84,30]
 *   步骤3  页面世界可见性: {pageWorldHasStyle:true, pageWorldHasBtn:true}
 *   步骤4  输入事件命中我们的按钮: ✅
 *
 * 看上去全绿 —— 但步骤 4 是在**开关闭后**的窗口里跑的，而 Electron 的
 * 隔离世界事件派发在真实（非 offscreen）窗口里并不可靠。所以有了第二版：
 * 用 `data:` 页面 + 真窗口尺寸 + **同时验证页面世界与隔离世界两条路径**，
 * 并且强制校验"点击回调真的跑过"。
 *
 * 这个脚本保留两条断言：
 *   A. 页面世界注入链路（补丁 → 主脚本 → 守护）能把按钮建出来；
 *   B. `sendInputEvent`（与真实鼠标同一层的事件派发）能命中按钮并触发回调。
 *
 * 用法：cd desktop && npm run probe:imgtrans
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const LOG = path.join(os.tmpdir(), 'pix-imgtrans-probe.txt')
const lines = []
function log (s) { lines.push(String(s)); fs.writeFileSync(LOG, lines.join('\n') + '\n'); console.log(s) }

const WORLD = 999

const { writePageWorldScripts } = require('../src/translate/page-world-inject')
const { registerPrivilegedScheme, attachHandler } = require('../src/translate/pix-protocol')

/**
 * 探针要跑真实的 preload 注入链路，所以得提供 `translate:pageScripts`
 * 这个同步通道 —— 产品里是 ipcMain；这里直接监听同一个频道。
 */
const DIR = path.join(os.tmpdir(), 'pix-imgtrans-probe-scripts')
function servePageScripts () {
  const { ipcMain } = require('electron')
  ipcMain.on('translate:pageScripts', (event) => {
    const urls = writePageWorldScripts({ dir: DIR, log: () => {} })
    event.returnValue = urls
  })
}

// pix:// 特权必须在 app ready 之前注册
registerPrivilegedScheme(require('electron'))

/** 假灯箱：整屏一张大图 + 哈希类名，尽量贴近 WhatsApp 的结构。 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:#0b141a}
  .x1lliihq{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
  .x1lliihq img{max-width:82vw;max-height:82vh}
</style></head>
<body><div class="x1lliihq"><img id="big" alt="photo"></div></body></html>`

async function main () {
  log('=== 翻译图片按钮 真机探针（页面世界链路） ' + new Date().toISOString() + ' ===')
  log('Electron ' + process.versions.electron + ' / Chrome ' + process.versions.chrome)

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      backgroundThrottling: false,
      // 和产品完全一致：sandbox + contextIsolation + 我们的 preload
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'probe-imgtrans-preload.js')
    }
  })

  // ★ 时序必须和产品一致：先落盘 + 挂协议，再导航 ★
  //
  // 2026-10-29 实测：protocol.handle() 晚于 loadURL 就彻底不生效
  // （页面里 ERR_FAILED，handler 连一次都不会被调用）。探针如果先导航
  // 再挂，测的就不是产品的真实链路。
  servePageScripts()
  writePageWorldScripts({ dir: DIR, log: m => log('  ' + m) })
  const attached = attachHandler(require('electron'), win.webContents.session, DIR)
  log('步骤0 pix:// 协议挂载: ' + attached)

  // 页面控制台的报错必须看见 —— pix:// 脚本加载失败只会走 console，
  // 光看"按钮没出现"根本分不出是协议没挂、CSP 拦了、还是脚本自己抛错。
  win.webContents.on('console-message', (...a) => {
    const m = typeof a[1] === 'object' ? a[1].message : a[2]
    const lv = typeof a[1] === 'object' ? a[1].level : a[1]
    if (lv === 'error' || lv === 3 || /pix|script|CSP|refused|denied/i.test(String(m))) {
      log('  [console] ' + String(m).slice(0, 300))
    }
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
  const wc = win.webContents
  log('页面已加载')

  // ── 0. 填一张 900x900 的图（页面里没真实图片地址，用 canvas 生成 data URL）
  await wc.executeJavaScriptInIsolatedWorld(WORLD, [{
    code: `(() => {
      const c = document.createElement('canvas'); c.width = 900; c.height = 900
      const x = c.getContext('2d'); x.fillStyle = '#0a84ff'; x.fillRect(0,0,900,900)
      x.fillStyle = '#fff'; x.font = '90px sans-serif'; x.fillText('HELLO', 180, 470)
      document.getElementById('big').src = c.toDataURL('image/png')
      return true
    })()`
  }])
  await new Promise(r => setTimeout(r, 400))
  log('步骤0 造图完成')

  // ── 1. 协议已在步骤 0 挂好（必须先于导航）
  // ── 2. 桥由 preload 通过 contextBridge 暴露（见 probe-imgtrans-preload.js），
  //       这里只确认它真的跨到了页面世界
  const bridgeProbe = await wc.executeJavaScript(`({
    fn: typeof window.__pixTranslateImage,
    lang: window.__pixEnv && window.__pixEnv.lang
  })`, true)
  log('步骤2 页面世界可见的桥: ' + JSON.stringify(bridgeProbe))

  // ── 3. 三段脚本由 preload 自己在 DOMContentLoaded 时插好了。
  //       这里**不再手动插**（会重复挂两套计时器），只等它落位。
  await new Promise(r => setTimeout(r, 1200))
  const fet = await wc.executeJavaScript(`(async () => {
    try {
      const r = await fetch('pix://pix/patch.js')
      return { ok: r.ok, status: r.status, len: (await r.text()).length }
    } catch (e) { return { err: String(e && e.message || e) } }
  })()`, true)
  log('步骤3 pix:// 可取性: ' + JSON.stringify(fet))

  // ── 4. 三脚本是否都在 + 按钮是否被建出来（**在页面世界问**，这一点很关键）
  const state = await wc.executeJavaScript(`(() => {
    const btn = document.getElementById('pix-imgtrans-btn')
    const r = btn ? btn.getBoundingClientRect() : null
    return {
      scripts: (typeof window._pixScriptsPresent === 'function') ? window._pixScriptsPresent() : null,
      hostInstalled: !!window.__pixPageHostInstalled,
      hasBtn: !!btn,
      btnShow: btn ? btn.dataset.show : null,
      btnDisplay: btn ? getComputedStyle(btn).display : null,
      btnRect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
      btnText: btn ? btn.textContent : null,
      parent: btn && btn.parentElement ? btn.parentElement.tagName : null
    }
  })()`, true)
  log('步骤4 页面世界状态: ' + JSON.stringify(state))

  if (!state.hasBtn) {
    log('❌ 按钮没建出来 —— 注入链路断了，后面的点击测试无意义')
    app.exit(1)
    return
  }

  // ── 5. 真实输入事件点击。注意监听器要挂在**页面世界**：如果按钮是
  //       页面世界创建的，页面世界的监听器必然收得到；收不到就说明
  //       sendInputEvent 没打中。
  const probe = await wc.executeJavaScript(`(() => {
    const btn = document.getElementById('pix-imgtrans-btn')
    window.__pixProbeClicked = 0
    btn.addEventListener('click', () => { window.__pixProbeClicked++ })
    const r = btn.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`, true)
  log('步骤5 按钮中心: ' + JSON.stringify(probe))

  wc.sendInputEvent({ type: 'mouseMove', x: probe.x, y: probe.y })
  wc.sendInputEvent({ type: 'mouseDown', x: probe.x, y: probe.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: probe.x, y: probe.y, button: 'left', clickCount: 1 })
  await new Promise(r => setTimeout(r, 800))

  const clicked = await wc.executeJavaScript('window.__pixProbeClicked', true)
  log('步骤5 输入事件命中（页面世界计数）: ' + clicked + (clicked > 0 ? '  ✅' : '  ❌'))

  // ── 6. 顺带验证点下去真的会去翻译（面板出现即证明桥通）
  const panel = await wc.executeJavaScript(`(() => {
    const p = document.getElementById('pix-imgtrans-panel')
    return { hasPanel: !!p, show: p ? p.dataset.show : null, text: p ? p.textContent.slice(0, 60) : null }
  })()`, true)
  log('步骤6 翻译面板: ' + JSON.stringify(panel))

  // ── 7. 手动隐藏：真实点击一次，主按钮和面板必须一起收起。
  const toggleProbe = await wc.executeJavaScript(`(() => {
    const t = document.getElementById('pix-imgtrans-toggle')
    if (!t) return null
    const r = t.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: t.textContent }
  })()`, true)
  log('步骤7 隐藏按钮: ' + JSON.stringify(toggleProbe))
  if (toggleProbe) {
    wc.sendInputEvent({ type: 'mouseMove', x: toggleProbe.x, y: toggleProbe.y })
    wc.sendInputEvent({ type: 'mouseDown', x: toggleProbe.x, y: toggleProbe.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: toggleProbe.x, y: toggleProbe.y, button: 'left', clickCount: 1 })
    await new Promise(r => setTimeout(r, 500))
  }
  const hidden = await wc.executeJavaScript(`(() => {
    const b = document.getElementById('pix-imgtrans-btn')
    const p = document.getElementById('pix-imgtrans-panel')
    const t = document.getElementById('pix-imgtrans-toggle')
    const tr = t ? t.getBoundingClientRect() : null
    const ir = document.getElementById('big').getBoundingClientRect()
    return {
      btnShow: b ? b.dataset.show : null,
      panelShow: p ? p.dataset.show : null,
      toggleText: t ? t.textContent : null,
      toggleOutsideImage: !!(tr && tr.left >= ir.right)
    }
  })()`, true)
  log('步骤7 隐藏后状态: ' + JSON.stringify(hidden))

  // ── 8. 对照实验：把同样的按钮建到**隔离世界**里，看真实输入能不能点中。
  //       这是为了让"隔离世界收不到事件"这个结论有可复现的证据，
  //       而不是只写在注释里。
  log('\n--- 对照：隔离世界里的按钮能被真实输入点中吗 ---')
  const iso = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{
    code: `(() => {
      const b = document.createElement('button')
      b.id = 'iso-probe-btn'
      b.textContent = 'ISO'
      b.style.cssText = 'position:fixed;left:40px;top:40px;width:120px;height:44px;z-index:999999'
      document.documentElement.appendChild(b)
      window.__isoClicked = 0
      b.addEventListener('click', () => { window.__isoClicked++ })
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`
  }])
  const isoPos = Array.isArray(iso) ? iso[0] : iso
  wc.sendInputEvent({ type: 'mouseMove', x: isoPos.x, y: isoPos.y })
  wc.sendInputEvent({ type: 'mouseDown', x: isoPos.x, y: isoPos.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: isoPos.x, y: isoPos.y, button: 'left', clickCount: 1 })
  await new Promise(r => setTimeout(r, 500))
  const isoClicked = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: 'window.__isoClicked' }])
  const isoVal = Array.isArray(isoClicked) ? isoClicked[0] : isoClicked
  log('对照结果: 隔离世界按钮点击计数 = ' + isoVal + (isoVal > 0
    ? '  （本机隔离世界也收得到 —— 说明真机差异取决于宿主页面，安全做法仍是页面世界）'
    : '  ❌ 隔离世界收不到真实点击 → 这就是必须注入页面世界的原因'))

  log('\n=== 结束 ===')
  const hideOk = !toggleProbe || (
    hidden.btnShow === '0' && hidden.panelShow !== '1' && hidden.toggleText === '译'
  )
  app.exit(clicked > 0 && hideOk ? 0 : 1)
}

app.whenReady().then(() => {
  main().catch(e => {
    log('❌ 探针崩溃: ' + (e && e.stack || e))
    app.exit(1)
  })
})

setTimeout(() => { log('硬超时 60s'); app.exit(1) }, 60000)
