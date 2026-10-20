/**
 * 布局验收截图（临时工具）。
 *
 * ## 为什么不用真实登录
 *
 * 客户端连的是**业务后端**（`/client/login`），而本仓库的 `server/` 是
 * 管理后台/官网那套（路由挂在 `/apis` 下）—— 两者不是同一个服务。
 * 本地起 `server/` 解决不了登录，硬造一个假的后端只会测到假的东西。
 *
 * ## 所以这里只验 UI
 *
 * 直接加载真实的 `renderer/index.html`，用最小 stub 顶掉 `window.pix`
 * 的 IPC 面，然后**手工调用真实的渲染函数**（applyTabLayout / renderTabs）
 * 把顶部 / 侧面两种布局各截一张。
 *
 * 它验证的是这次改动的真实风险：
 *   · 侧面布局的 DOM/CSS 是否真的生效（.stage-side-main 是否切成列）；
 *   · 标签栏是否落在左侧、宽度是否等于 168；
 *   · 切换后有没有把标签渲染丢掉（白屏）。
 *
 * 不验证：登录、多开、翻译桥 —— 那些与本次改动无关。
 *
 * 用法：./node_modules/.bin/electron scripts/capture-layout.js
 * 产出：/tmp/pix-layout-{top,side}.png
 */
'use strict'

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const OUT = '/tmp'
const ROOT = path.join(__dirname, '..')

// 与真实 preload 形状一致的 stub：只提供渲染层启动时会调到的那些，
// 全部返回"空成功"。任何没覆盖到的调用都会在控制台留下蛛丝马迹。
const STUB = `
window.pix = new Proxy({
  getConfig: () => Promise.resolve({ theme: 'light', tabLayout: 'top', lines: [] }),
  version: () => Promise.resolve('0.0.0-stub'),
  proxyPresets: () => Promise.resolve({ rows: [] }),
  getAuth: () => Promise.resolve({}),
  listLines: () => Promise.resolve({ rows: [] }),
  bridgeStatus: () => Promise.resolve({ ok: true }),
  translateEngines: () => Promise.resolve({ engines: [] }),
  platforms: () => Promise.resolve({ rows: [] }),
  customerReminders: () => Promise.resolve({ rows: [] }),
  onTabs: () => {}, onPlatforms: () => {}, onSession: () => {}, onKicked: () => {},
  onBridgeDown: () => {}, onContextCommand: () => {}, onProxySettings: () => {},
  onBackgroundRunning: () => {}, onTranslateOpen: () => {},
  reportChromeHeight: () => {}, reportBarHeight: () => {},
  setTabLayout: () => Promise.resolve({ success: true }),
  switchTab: () => {}, home: () => {}, close: () => {}
}, { get: (t, k) => (k in t ? t[k] : () => Promise.resolve({ success: true })) })
`

// 两条假标签：足够看出侧栏里"图标 + 名字 + 关闭"的排布对不对。
const FAKE_TABS = JSON.stringify({
  success: true,
  home: false,
  activeId: 't1',
  rows: [
    { id: 't1', platform: 'whatsapp-green', name: '阿强 客服号', title: 'WhatsApp', unread: 3, alignRight: false },
    { id: 't2', platform: 'whatsapp-pro', name: '小李 售后', title: 'WhatsApp', unread: 0, alignRight: false },
    { id: 't3', platform: 'telegram', name: 'Тимур', title: 'Telegram', unread: 12, alignRight: false }
  ]
})

function shoot (win, tag) {
  return win.webContents.capturePage().then(img => {
    const file = path.join(OUT, 'pix-layout-' + tag + '.png')
    fs.writeFileSync(file, img.toPNG())
    console.log('[capture] ' + file + ' ' + JSON.stringify(img.getSize()))
  })
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    show: true,
    backgroundColor: '#070b14',
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false }
  })
  win.webContents.on('console-message', (...a) => {
    const msg = typeof a[0] === 'object' ? a[0].message : a[2]
    if (/error|Error|Uncaught/.test(String(msg))) console.log('[renderer] ' + msg)
  })

  // ★ stub 必须在页面脚本执行前注入 ★
  //
  // 真实应用里 window.pix 由 preload 提供，加载 index.html 之前就在了。
  // 这里用 executeJavaScript 在 loadFile 之后再注入就晚了 —— app.js 启动时
  // 已经在调 getConfig/onTabs，拿不到 window.pix 会直接抛。
  // 用 `executeJavaScript` 在导航后、DOMContentLoaded 前的窗口极小，
  // 所以改用 preload 一样的时机：注册到 session 的 on-demand 不可行，
  // 简单可靠的做法是让 webContents 在 did-start-loading 时注入。
  win.webContents.on('did-start-loading', () => {
    win.webContents.executeJavaScript(STUB).catch(() => {})
  })

  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'))
  // loadFile 完成后补一次：did-start-loading 那次可能被后续导航覆盖
  await win.webContents.executeJavaScript(STUB + '; true').catch(() => {})

  await new Promise(r => setTimeout(r, 1200))

  // 用真实的渲染入口画标签，而不是伪造 DOM —— 否则测的是截图脚本不是代码
  const rendered = await win.webContents.executeJavaScript(`(() => {
    if (typeof renderTabs !== 'function') return 'no renderTabs'
    // 登录页盖在主界面之上：不摘掉它，截出来的永远是深色登录页。
    const login = document.getElementById('loginScreen') || document.getElementById('login')
    if (login) login.classList.add('hidden')
    const shell = document.getElementById('shell')
    if (shell) shell.classList.remove('hidden')
    renderTabs(${FAKE_TABS})
    // 立即回读：渲染是否真的落到 DOM 上。不查这一步，截图里一片空也看不出原因。
    return 'ok n=' + document.querySelectorAll('#tabs .tab').length
  })()`)
  console.log('[capture] renderTabs -> ' + rendered)
  await new Promise(r => setTimeout(r, 800))
  await shoot(win, 'top')

  await win.webContents.executeJavaScript('applyTabLayout("side"); "ok"')
  await new Promise(r => setTimeout(r, 900))
  await shoot(win, 'side')

  // 量一下侧栏几何：宽度必须是 168，且 x 必须贴左
  const probe = await win.webContents.executeJavaScript(`(() => {
    const wrap = document.getElementById('tabsWrap')
    const side = document.querySelector('.stage-side-main')
    const tabs = document.getElementById('tabs')
    const r = wrap.getBoundingClientRect()
    const first = tabs.querySelector('.tab')
    const fr = first ? first.getBoundingClientRect() : null
    return {
      attr: document.documentElement.getAttribute('data-tabs-layout'),
      stageCls: document.getElementById('stage').className,
      wrap: { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) },
      sideDisplay: side ? getComputedStyle(side).display : '',
      tabsDir: tabs ? getComputedStyle(tabs).flexDirection : '',
      firstTab: fr ? { w: Math.round(fr.width), h: Math.round(fr.height) } : null,
      btnText: (document.getElementById('tabLayoutText') || {}).textContent || ''
    }
  })()`)
  console.log('[probe] ' + JSON.stringify(probe))

  app.quit()
}).catch(e => { console.log('[capture] fatal ' + e.stack); app.quit() })
