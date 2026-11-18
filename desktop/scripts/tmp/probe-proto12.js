const { app, BrowserWindow, protocol } = require('electron')
const fs = require('node:fs')
const LOG = '/tmp/proto12.log'
const w = s => fs.appendFileSync(LOG, s + '\n')
protocol.registerSchemesAsPrivileged([
  { scheme: 'pix', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }
])
app.whenReady().then(async () => {
  const body = fs.readFileSync(process.env.TGT, 'utf8')
  protocol.handle('pix', async () => {
    w('hit')
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' } })
  })
  const win = new BrowserWindow({ show: false })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  const r1 = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>r.text()).catch(e=>'ERR '+e.message)`, true)
  w('str body: ' + JSON.stringify(String(r1).slice(0, 60)))
  const r2 = await win.webContents.executeJavaScript(`fetch('pix://pix/nope.js').then(r=>r.text()).catch(e=>'ERR '+e.message)`, true)
  w('404 path: ' + JSON.stringify(String(r2).slice(0, 60)))
  const r3 = await win.webContents.executeJavaScript(`(async () => { const s = document.createElement('script'); s.src='pix://pix/patch.js'; return await new Promise(res => { s.onload = () => res('onload'); s.onerror = () => res('onerror'); document.documentElement.appendChild(s); setTimeout(()=>res('timeout'), 2000) }) })()`, true)
  w('script: ' + JSON.stringify(r3))
  app.exit(0)
})
setTimeout(() => app.exit(2), 20000)
