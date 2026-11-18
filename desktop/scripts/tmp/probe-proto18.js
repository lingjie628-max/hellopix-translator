const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const LOG = '/tmp/proto18.log'
const w = s => fs.appendFileSync(LOG, s + '\n')
require('../../src/translate/pix-protocol').registerPrivilegedScheme(require('electron'))
const proto = require('../../src/translate/pix-protocol')
const DIR = path.join(require('node:os').tmpdir(), 'pix-imgtrans-probe-scripts')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  const ses = win.webContents.session
  w('attach: ' + proto.attachHandler(require('electron'), ses, DIR))
  const res = await ses.protocol.isProtocolHandled ? await ses.protocol.isProtocolHandled('pix') : 'n/a'
  w('isHandled: ' + res)
  // 用 ses.protocol.handle 再挂一次会抛"already registered"，说明第一次真挂上了
  try { ses.protocol.handle('pix', () => new Response('x')) ; w('re-handle: ok (first did NOT register)') } catch (e) { w('re-handle threw: ' + e.message) }
  app.exit(0)
})
setTimeout(() => app.exit(2), 15000)
