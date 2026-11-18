const { app, BrowserWindow, protocol } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const LOG = '/tmp/proto13.log'
const w = s => fs.appendFileSync(LOG, s + '\n')
require('../../src/translate/pix-protocol').registerPrivilegedScheme(require('electron'))
const DIR = path.join(require('node:os').tmpdir(), 'pix-imgtrans-probe-scripts')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  win.webContents.on('console-message', (...a) => {
    const m = typeof a[1] === 'object' ? a[1].message : a[2]
    w('CONSOLE ' + String(m).slice(0, 200))
  })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  w('attach ' + require('../../src/translate/pix-protocol').attachHandler(require('electron'), win.webContents.session, DIR))
  w('files ' + fs.readdirSync(DIR).join(','))
  const r1 = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>r.text()).then(t=>'LEN '+t.length).catch(e=>'ERR '+e.message)`, true)
  w('fetch: ' + JSON.stringify(r1))
  app.exit(0)
})
setTimeout(() => app.exit(2), 20000)
