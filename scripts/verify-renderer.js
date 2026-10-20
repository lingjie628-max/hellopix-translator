'use strict'

/**
 * 渲染层冒烟验收。
 *
 * ## 为什么需要它
 *
 * 渲染层是三段传统 <script>，共享全局作用域，靠**标签顺序**保证依赖。
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
 *   cd desktop && ./node_modules/.bin/electron ../scripts/verify-renderer.js
 *
 * 退出码 0 = 渲染层正常；非 0 = 白屏或关键符号缺失。
 *
 * 注意：这里没有 preload，所以 window.pix 不存在，app.js 里调用
 * window.pix.xxx 的地方会报错 —— 那是**预期内**的，只看白屏和符号。
 */

const { app, BrowserWindow } = require('electron')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'desktop')

const EXPECTED_SCRIPTS = ['theme.js', 'dom.js', 'pure.js', 'app.js']

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
    await win.loadFile(path.join(ROOT, 'renderer', 'index.html'))
    // 给 app.js 顶层的异步初始化留一拍
    await new Promise(r => setTimeout(r, 900))
    report = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({
      scripts: [...document.scripts].map(s => s.src.split('/').pop()),
      langs: typeof LANGS !== 'undefined' ? LANGS.length : -1,
      hasLogin: typeof loginScreen !== 'undefined' && !!loginScreen,
      friendlyError: typeof friendlyError,
      cmpVer: typeof cmpVer,
      parseProxyLine: typeof parseProxyLine,
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
  if (report.friendlyError !== 'function') problems.push('pure.js 的 friendlyError 不可用')
  if (report.cmpVer !== 'function') problems.push('pure.js 的 cmpVer 不可用')
  if (report.parseProxyLine !== 'function') problems.push('pure.js 的 parseProxyLine 不可用')
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
