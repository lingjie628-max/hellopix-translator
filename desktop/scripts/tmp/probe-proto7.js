const { app, BrowserWindow, protocol } = require('electron')
const fs = require('node:fs')
const LOG = '/tmp/proto7.log'
const w = s => fs.appendFileSync(LOG, s + '\n')
const V = process.env.V
const PL = {
  full: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true, allowServiceWorkers: true, stream: true },
  noStandard: { secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true },
  minimal: {},
  schemeOnly: { standard: true, secure: true, supportFetchAPI: true }
}[V]
protocol.registerSchemesAsPrivileged([{ scheme: 'pix', privileges: PL }])
app.whenReady().then(async () => {
  protocol.handle('pix', () => { w('hit'); return new Response('window.__x=1', { headers: { 'Content-Type': 'application/javascript' } }) })
  const win = new BrowserWindow({ show: false })
  win.webContents.on('console-message', (...a) => {
    const m = typeof a[1] === 'object' ? a[1].message : a[2]
    w('CONSOLE ' + String(m).slice(0, 250))
  })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  const r1 = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>r.text()).catch(e=>'ERR '+e.message)`, true)
  w(V + ' fetch: ' + JSON.stringify(r1))
  const r2 = await win.webContents.executeJavaScript(`(async () => { const s = document.createElement('script'); s.src='pix://pix/patch.js'; return await new Promise(res => { s.onload = () => res('onload x=' + window.__x); s.onerror = () => res('onerror'); document.documentElement.appendChild(s); setTimeout(()=>res('timeout'), 2000) }) })()`, true)
  w(V + ' script: ' + JSON.stringify(r2))
  app.exit(0)
})
setTimeout(() => app.exit(2), 20000)
