'use strict'
/**
 * LINE 内置扩展真机验证（Electron）：扩展能装进持久分区、登录页能出来、未读数能同步到标题。
 *
 * 用法（desktop/ 下，先 npm run fetch:line-ext）：npm run verify:line-ext
 *   PIX_LINE_EXT=<扩展目录>     默认 vendor/line-ext；验安装包时指向 resources/line-ext
 *   PIX_SPIKE_SHOW=1 PIX_SPIKE_KEEP=1   显示窗口并保持打开（可手动扫码登录）
 * 截图与日志输出到 PIX_SPIKE_OUT（默认系统临时目录 / pix-line-verify）。
 */
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const EXT_DIR = process.env.PIX_LINE_EXT || path.join(__dirname, '..', 'vendor', 'line-ext')
const OUT = process.env.PIX_SPIKE_OUT || path.join(os.tmpdir(), 'pix-line-verify')
const WAIT = Number(process.env.PIX_SPIKE_WAIT_MS || 12000)
const LINE_ID = 'ophjlpahpchlmihnnnihgmmeilfjmjjc'
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

app.setPath('userData', path.join(app.getPath('appData'), 'Hello Pix Line Verify'))
fs.mkdirSync(OUT, { recursive: true })

const logs = []
const log = (...a) => { const s = a.join(' '); logs.push(s); console.log(s) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
const check = (name, ok, detail) => { checks.push(ok); log((ok ? '✔ ' : '✖ ') + name + (detail ? '  ' + detail : '')) }

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:verify-line-1')
  ses.setUserAgent(CHROME_UA)
  let ext
  try {
    ext = await (ses.extensions ? ses.extensions.loadExtension(EXT_DIR) : ses.loadExtension(EXT_DIR))
  } catch (e) {
    check('扩展装载', false, e && e.message)
    app.exit(1)
    return
  }
  check('扩展装载且 ID 为官方 ID', ext.id === LINE_ID, 'id=' + ext.id + ' v' + ext.version)

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: process.env.PIX_SPIKE_SHOW === '1',
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  })
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) log('[page:' + level + '] ' + String(message).slice(0, 300) + ' @' + String(source || '').split('/').pop() + ':' + line)
  })
  await win.loadURL('chrome-extension://' + ext.id + '/index.html').catch((e) => log('loadURL 异常 ' + (e && e.message)))
  await sleep(WAIT)

  const info = await win.webContents.executeJavaScript(`(() => ({
    inputs: Array.from(document.querySelectorAll('input')).map(i => i.type),
    canvas: document.querySelectorAll('canvas').length,
    textLen: (document.body && document.body.innerText || '').length
  }))()`).catch((e) => ({ error: String(e && e.message) }))
  const loginShown = Array.isArray(info.inputs) && info.inputs.includes('password') && info.canvas > 0
  const loggedIn = !loginShown && info.textLen > 0
  check('登录页（邮箱密码 + 二维码）或已登录界面出现', loginShown || loggedIn, JSON.stringify(info))

  await win.webContents.executeJavaScript('chrome.action.setBadgeText({ text: "3" })').catch(() => {})
  await sleep(200)
  await win.webContents.executeJavaScript('document.title = "LINE"').catch(() => {})
  await sleep(300)
  const withUnread = win.webContents.getTitle()
  await win.webContents.executeJavaScript('chrome.action.setBadgeText({ text: "" })').catch(() => {})
  await sleep(300)
  check('未读数写进标题（页面改标题后补回）', withUnread === '(3) LINE', JSON.stringify(withUnread))
  check('未读清零后去掉前缀', win.webContents.getTitle() === 'LINE', JSON.stringify(win.webContents.getTitle()))

  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(OUT, 'line.png'), img.toPNG())
  fs.writeFileSync(path.join(OUT, 'log.txt'), logs.join('\n'))
  const ok = checks.every(Boolean)
  log((ok ? '全部通过' : '有失败项') + '（截图 ' + path.join(OUT, 'line.png') + '）')
  if (process.env.PIX_SPIKE_KEEP === '1') return
  app.exit(ok ? 0 : 1)
})

app.on('window-all-closed', () => {})
