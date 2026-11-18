const { app, BrowserWindow, protocol } = require('electron')
const fs = require('node:fs')
const LOG = '/tmp/proto10.log'
const w = s => fs.appendFileSync(LOG, s + '\n')
const V = process.env.V
const P = {
  ses: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true },
  globA: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true },
  globB: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true, allowServiceWorkers: true, stream: true }
}[V]
protocol.registerSchemesAsPrivileged([{ scheme: 'pix', privileges: P }])
app.whenReady().then(async () => {
  const mk = () => new Response('window.__x=1', { headers: { 'Content-Type': 'application/javascript' } })
  const win = new BrowserWindow({ show: false })
  if (V === 'ses') win.webContents.session.protocol.handle('pix', () => { w('ses hit'); return mk() })
  else protocol.handle('pix', () => { w(V + ' hit'); return mk() })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  const r1 = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>r.text()).catch(e=>'ERR '+e.message)`, true)
  w(V + ' fetch: ' + JSON.stringify(r1))
  app.exit(0)
})
setTimeout(() => app.exit(2), 20000)
