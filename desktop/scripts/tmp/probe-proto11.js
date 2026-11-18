const { app, BrowserWindow, protocol } = require('electron')
const fs = require('node:fs')
const LOG = '/tmp/proto11.log'
const w = s => fs.appendFileSync(LOG, s + '\n')
protocol.registerSchemesAsPrivileged([
  { scheme: 'pix', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }
])
app.whenReady().then(async () => {
  const mk = () => new Response('window.__x=1', { headers: { 'Content-Type': 'application/javascript' } })
  const win = new BrowserWindow({ show: false })
  const which = process.env.W
  if (which === 'before') protocol.handle('pix', () => { w('before hit'); return mk() })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  if (which === 'after') protocol.handle('pix', () => { w('after hit'); return mk() })
  const r1 = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>r.text()).catch(e=>'ERR '+e.message)`, true)
  w(which + ' fetch: ' + JSON.stringify(r1))
  app.exit(0)
})
setTimeout(() => app.exit(2), 20000)
