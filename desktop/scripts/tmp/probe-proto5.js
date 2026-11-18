const { app, BrowserWindow, protocol } = require('electron')
const LOG = '/tmp/proto5.log'
const w = s => require('node:fs').appendFileSync(LOG, s + '\n')
protocol.registerSchemesAsPrivileged([
  { scheme: 'pix', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }
])
app.whenReady().then(async () => {
  protocol.handle('pix', (req) => {
    w('hit ' + req.url)
    return new Response('window.__x=9', { headers: { 'Content-Type': 'application/javascript' } })
  })
  const win = new BrowserWindow({ show: false })
  win.webContents.session.protocol.handle('pix', (req) => {
    w('ses hit ' + req.url)
    return new Response('window.__y=9', { headers: { 'Content-Type': 'application/javascript' } })
  })
  win.webContents.on('console-message', (...a) => {
    const m = typeof a[1] === 'object' ? a[1].message : a[2]
    w('CONSOLE ' + String(m).slice(0, 250))
  })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  const r1 = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>r.text()).catch(e=>'ERR '+e.message)`, true)
  w('fetch: ' + JSON.stringify(r1))
  const r2 = await win.webContents.executeJavaScript(`(async () => { const s = document.createElement('script'); s.src='pix://pix/patch.js'; return await new Promise(res => { s.onload = () => res('onload y=' + window.__y + ' x=' + window.__x); s.onerror = (e) => res('onerror'); document.documentElement.appendChild(s); setTimeout(()=>res('timeout'), 3000) }) })()`, true)
  w('script tag: ' + JSON.stringify(r2))
  const r3 = await win.webContents.executeJavaScript(`location.href`, true)
  w('origin: ' + r3)
  app.exit(0)
})
setTimeout(() => app.exit(2), 25000)
