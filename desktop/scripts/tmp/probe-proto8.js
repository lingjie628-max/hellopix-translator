const { app, BrowserWindow, protocol } = require('electron')
const fs = require('node:fs')
const LOG = '/tmp/proto8.log'
const w = s => fs.appendFileSync(LOG, s + '\n')
const V = process.env.V
let PL
if (V === 'nobypass') PL = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
else if (V === 'bypassnoCors') PL = { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true }
else PL = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true }
protocol.registerSchemesAsPrivileged([{ scheme: 'pix', privileges: PL }])
app.whenReady().then(async () => {
  protocol.handle('pix', () => { w('hit'); return new Response('window.__x=1', { headers: { 'Content-Type': 'application/javascript' } }) })
  const win = new BrowserWindow({ show: false })
  win.webContents.session.webRequest.onHeadersReceived((d, cb) => {
    const h = Object.assign({}, d.responseHeaders)
    h['Access-Control-Allow-Origin'] = ['*']
    cb({ responseHeaders: h, statusLine: d.statusLine })
  })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  const r1 = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>r.text()).catch(e=>'ERR '+e.message)`, true)
  w(V + ' fetch: ' + JSON.stringify(r1))
  const r2 = await win.webContents.executeJavaScript(`(async () => { const s = document.createElement('script'); s.src='pix://pix/patch.js'; return await new Promise(res => { s.onload = () => res('onload x=' + window.__x); s.onerror = () => res('onerror'); document.documentElement.appendChild(s); setTimeout(()=>res('timeout'), 2000) }) })()`, true)
  w(V + ' script: ' + JSON.stringify(r2))
  app.exit(0)
})
setTimeout(() => app.exit(2), 20000)
