const { app, BrowserWindow, protocol } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const LOG = '/tmp/proto15.log'
const w = s => fs.appendFileSync(LOG, s + '\n')
require('../../src/translate/pix-protocol').registerPrivilegedScheme(require('electron'))
const proto = require('../../src/translate/pix-protocol')
const DIR = path.join(require('node:os').tmpdir(), 'pix-imgtrans-probe-scripts')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  const ses = win.webContents.session
  w('ses.protocol.handle type: ' + typeof (ses.protocol && ses.protocol.handle))
  w('attachHandler: ' + proto.attachHandler(require('electron'), ses, DIR))
  // 直接调一次 handler 逻辑，看它到底走到哪一步
  const raw = await proto.invokeForTest ? proto.invokeForTest('pix://pix/patch.js') : null
  w('direct: ' + JSON.stringify(raw))
  app.exit(0)
})
setTimeout(() => app.exit(2), 15000)
