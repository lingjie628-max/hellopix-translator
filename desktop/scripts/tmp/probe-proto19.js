const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const LOG = '/tmp/proto19.log'
const w = s => fs.appendFileSync(LOG, s + '\n')
require('../../src/translate/pix-protocol').registerPrivilegedScheme(require('electron'))
const proto = require('../../src/translate/pix-protocol')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  win.webContents.on('console-message', (...a) => {
    const m = typeof a[1] === 'object' ? a[1].message : a[2]
    w('CONSOLE ' + String(m).slice(0, 300))
  })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  const ses = win.webContents.session
  // 1) 产品 handler 挂一个不存在的目录 → 应该是 500，能看到具体错误
  w('attach(missing dir): ' + proto.attachHandler(require('electron'), ses, '/definitely/not/here'))
  const r1 = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>'status '+r.status).catch(e=>'ERR '+e.message)`, true)
  w('missingDir fetch: ' + JSON.stringify(r1))
  app.exit(0)
})
setTimeout(() => app.exit(2), 15000)
