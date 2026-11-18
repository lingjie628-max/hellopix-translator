const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const LOG = '/tmp/proto24.log'
const w = s => fs.appendFileSync(LOG, s + '\n')
const proto = require('../../src/translate/pix-protocol')
proto.registerPrivilegedScheme(require('electron'))
const inject = require('../../src/translate/page-world-inject')
app.whenReady().then(async () => {
  const dir = path.join(require('node:os').tmpdir(), 'pix-probe24')
  const win = new BrowserWindow({ show: false })
  proto.attachHandler(require('electron'), win.webContents.session, dir)
  inject.writePageWorldScripts({ dir, log: m => w(m) })
  win.webContents.on('console-message', (...a) => {
    const m = typeof a[1] === 'object' ? a[1].message : a[2]
    if (!/Security Warning|Policy set|this app to|more information|electronjs|once the app/.test(String(m))) w('CONSOLE ' + String(m).slice(0, 250))
  })
  await win.loadURL('data:text/html,<html><body><div id="x">hi</div></body></html>')
  const r = await win.webContents.executeJavaScript(`(async () => {
    const el = document.createElement('script')
    el.src = 'pix://pix/patch.js'
    el.onload = () => { window.__loaded = true }
    el.onerror = () => { window.__failed = true }
    document.documentElement.appendChild(el)
    await new Promise(r => setTimeout(r, 1500))
    return { loaded: !!window.__loaded, failed: !!window.__failed, hasGuard: typeof window._pixScriptsPresent, hostInstalled: !!window.__pixPageHostInstalled, btn: !!document.getElementById('pix-imgtrans-btn') }
  })()`, true)
  w('RESULT ' + JSON.stringify(r))
  w('dir files: ' + fs.readdirSync(dir).join(','))
  w('guard size: ' + fs.statSync(path.join(dir, 'guard.js')).size)
  app.exit(0)
})
setTimeout(() => app.exit(2), 20000)
