const path = require('node:path')
const { app, BrowserWindow, protocol } = require('electron')
const LOG = '/tmp/proto2.log'
const w = s => require('node:fs').appendFileSync(LOG, s + '\n')
protocol.registerSchemesAsPrivileged([
  { scheme: 'pix', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }
])
app.whenReady().then(async () => {
  protocol.handle('pix', () => { w('HANDLER HIT'); return new Response('window.__A=1', { headers: { 'Content-Type': 'application/javascript' } }) })
  for (const variant of ['session', 'global']) {
    const win = new BrowserWindow({ show: false })
    win.webContents.on('console-message', (...a) => {
      const m = typeof a[1] === 'object' ? a[1].message : a[2]
      w('[' + variant + '] CONSOLE ' + String(m).slice(0, 160))
    })
    await win.loadURL('data:text/html,<html><body>x</body></html>')
    const r1 = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>r.text()).catch(e=>'ERR '+e.message)`, true)
    w('[' + variant + '] fetch: ' + JSON.stringify(r1))
    await new Promise(r => setTimeout(r, 500))
    win.destroy()
    break
  }
  app.exit(0)
})
setTimeout(() => app.exit(2), 20000)
