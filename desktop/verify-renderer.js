'use strict'

/**
 * 渲染层冒烟验收。
 *
 * ## 为什么需要它
 *
 * 渲染层是几段传统 <script>，共享全局作用域，靠**标签顺序**保证依赖。
 * 这类问题单测抓不住：
 *
 *   - 顺序错了 / 重复声明 → 顶层 SyntaxError 或 ReferenceError → 整页白屏
 *   - 某个元素 id 拼错 → 变量变成 null，只有点到那个功能才炸
 *
 * renderer-assets.test.js 做静态检查，这个脚本做**真实渲染**检查：
 * 用 Electron 加载真实的 index.html，把渲染层的实际状态打出来。
 *
 * ## 用法
 *
 *   cd desktop && node verify-renderer.js
 *
 * 退出码 0 = 渲染层正常；非 0 = 白屏或关键符号缺失。
 *
 * ## 为什么是个双层脚本
 *
 * 本文件被 node 执行时，会把自己重新拉进 Electron 子进程（带
 * ELECTRON_RUN_AS_NODE 清除）。直接 `electron verify-renderer.js`
 * 在有些环境里会退化成普通 node，require('electron') 只拿到一个路径字符串。
 *
 * 注意：这里没有 preload，所以 window.pix 不存在，app.js 里调用
 * window.pix.xxx 的地方会报错 —— 那是**预期内**的，只看白屏和符号。
 */

const path = require('path')
const { spawnSync } = require('child_process')

const DESKTOP = process.env.PIX_VERIFY_DESKTOP || __dirname
const ELECTRON_BIN = path.join(DESKTOP, 'node_modules', 'electron', 'dist',
  'Electron.app', 'Contents', 'MacOS', 'Electron')

// ---------------------------------------------------------------- 外层：node
if (!process.versions.electron) {
  const fs = require('fs')
  if (!fs.existsSync(ELECTRON_BIN)) {
    console.error('找不到 Electron 二进制：' + ELECTRON_BIN)
    process.exit(2)
  }
  // 用独立的 app root 跑，避免被 desktop/package.json 的 main 抢走
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pix-verify-'))
  fs.copyFileSync(__filename, path.join(root, 'verify-renderer.js'))
  fs.writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ name: 'pix-verify', main: 'verify-renderer.js' }))
  fs.symlinkSync(path.join(DESKTOP, 'node_modules'), path.join(root, 'node_modules'))

  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  // 内层在临时目录里，得知道真实的产品目录在哪
  env.PIX_VERIFY_DESKTOP = DESKTOP
  const r = spawnSync(ELECTRON_BIN, [root], { encoding: 'utf8', env })
  const out = (r.stdout || '') + (r.stderr || '')
  process.stdout.write(out)
  try { fs.rmSync(root, { recursive: true, force: true }) } catch (e) {}
  process.exit(String(out).includes('VERIFY_OK=') ? 0 : 1)
}

// ------------------------------------------------------------ 内层：Electron
const { app, BrowserWindow } = require('electron')

const EXPECTED_SCRIPTS = ['theme.js', 'dom.js', 'pure.js', 'proxy-panel.js', 'tabs.js', 'add-app.js', 'trans-bar.js', 'app.js']

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })

  // 渲染层的 SyntaxError / ReferenceError 只会在这里出现
  const fatal = []
  win.webContents.on('console-message', (event, level, message) => {
    const text = String(message == null ? '' : message)
    if (level === 3 || level === 'error' || /SyntaxError|ReferenceError/.test(text)) {
      fatal.push(text)
    }
  })

  let report
  try {
    await win.loadFile(path.join(DESKTOP, 'renderer', 'index.html'))
    // 给 app.js 顶层的异步初始化留一拍
    await new Promise(r => setTimeout(r, 900))
    report = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({
      scripts: [...document.scripts].map(s => s.src.split('/').pop()),
      langs: typeof LANGS !== 'undefined' ? LANGS.length : -1,
      hasLogin: typeof loginScreen !== 'undefined' && !!loginScreen,
      friendlyError: typeof friendlyError,
      cmpVer: typeof cmpVer,
      parseProxyLine: typeof parseProxyLine,
      syncProxyFields: typeof syncProxyFields,
      openProxySettings: typeof openProxySettings,
      renderTabs: typeof renderTabs,
      attachTabsWheel: typeof attachTabsWheel,
      paintTransBar: typeof paintTransBar,
      fillAddForm: typeof fillAddForm,
      bodyLen: document.body.innerText.length,
      text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 80)
    })`))
  } catch (e) {
    console.log('VERIFY_FAIL=' + ((e && e.message) || e))
    app.exit(1)
    return
  }

  const problems = []
  if (JSON.stringify(report.scripts) !== JSON.stringify(EXPECTED_SCRIPTS)) {
    problems.push('脚本顺序不对：' + report.scripts.join(' → '))
  }
  if (report.langs < 100) problems.push('语种表没加载出来：' + report.langs)
  if (!report.hasLogin) problems.push('登录界面元素没取到（dom.js 可能没跑）')
  for (const name of ['friendlyError', 'cmpVer', 'parseProxyLine']) {
    if (report[name] !== 'function') problems.push('pure.js 的 ' + name + ' 不可用')
  }
  for (const name of ['syncProxyFields', 'openProxySettings']) {
    if (report[name] !== 'function') problems.push('proxy-panel.js 的 ' + name + ' 不可用')
  }
  for (const name of ['renderTabs', 'attachTabsWheel']) {
    if (report[name] !== 'function') problems.push('tabs.js 的 ' + name + ' 不可用')
  }
  if (report.fillAddForm !== 'function') problems.push('add-app.js 的 fillAddForm 不可用')
  if (report.paintTransBar !== 'function') problems.push('trans-bar.js 的 paintTransBar 不可用')
  if (report.bodyLen < 50) problems.push('页面是白的（bodyLen=' + report.bodyLen + '）')

  // 顶层语法错误一律算失败 —— 白屏就是从这来的
  const syntax = fatal.filter(t => /SyntaxError|ReferenceError: Cannot access|is not defined/.test(t))
  for (const t of syntax) problems.push('顶层语法错误：' + t.slice(0, 120))

  if (problems.length) {
    console.log('VERIFY_FAIL=' + JSON.stringify(problems, null, 2))
    app.exit(1)
    return
  }
  console.log('VERIFY_OK=' + JSON.stringify(report))
  app.exit(0)
})
