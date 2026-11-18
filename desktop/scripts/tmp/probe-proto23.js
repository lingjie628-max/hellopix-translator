const { app, BrowserWindow, protocol } = require('electron')
const fs = require('node:fs')
const LOG = '/tmp/proto23.log'
const w = s => fs.appendFileSync(LOG, s + '\n')
protocol.registerSchemesAsPrivileged([{ scheme: 'pix', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }])
const V = process.env.V
app.whenReady().then(async () => {
  if (V === 'before') protocol.handle('pix', () => { w('hit'); return new Response('window.__ok=1', { headers: { 'Content-Type': 'application/javascript' } }) })
  const win = new BrowserWindow({ show: false })
  const ses = win.webContents.session
  win.webContents.on('console-message', (...a) => {
    const m = typeof a[1] === 'object' ? a[1].message : a[2]
    if (!/Security Warning|Policy set|this app to|more information|electronjs|once the app/.test(String(m))) w('CONSOLE ' + String(m).slice(0, 200))
  })
  if (V === 'after') ses.protocol.handle('pix', () => { w('hit'); return new Response('window.__ok=1', { headers: { 'Content-Type': 'application/javascript' } }) })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  if (V === 'afterload') ses.protocol.handle('pix', () => { w('hit'); return new Response('window.__ok=1', { headers: { 'Content-Type': 'application/javascript' } }) })
  const r1 = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>r.text()).catch(e=>'ERR '+e.message)`, true)
  w(V + ' fetch: ' + JSON.stringify(r1))
  app.exit(0)
})
setTimeout(() => app.exit(2), 15000)
