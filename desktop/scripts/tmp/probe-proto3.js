const path = require('node:path')
const { app, BrowserWindow, protocol } = require('electron')
const LOG = '/tmp/proto3.log'
const w = s => require('node:fs').appendFileSync(LOG, s + '\n')
require('../../src/translate/pix-protocol').registerPrivilegedScheme(require('electron'))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  win.webContents.on('console-message', (...a) => {
    const m = typeof a[1] === 'object' ? a[1].message : a[2]
    w('CONSOLE ' + String(m).slice(0, 200))
  })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  const r0 = await require('../../src/translate/pix-protocol').attachHandler(require('electron'), win.webContents.session, '/tmp')
  w('attach: ' + r0)
  const r1 = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>r.text()).catch(e=>'ERR '+e.message)`, true)
  w('fetch /tmp/patch.js: ' + JSON.stringify(String(r1).slice(0,120)))
  const r2 = await win.webContents.executeJavaScript(`fetch('pix://pix/nope.js').then(r=>r.status).catch(e=>'ERR '+e.message)`, true)
  w('fetch /tmp/nope.js: ' + JSON.stringify(r2))
  app.exit(0)
})
setTimeout(() => app.exit(2), 20000)
