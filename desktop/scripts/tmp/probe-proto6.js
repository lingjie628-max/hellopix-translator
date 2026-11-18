const { app, BrowserWindow, protocol } = require('electron')
const fs = require('node:fs')
const LOG = '/tmp/proto6.log'
const w = s => fs.appendFileSync(LOG, s + '\n')
protocol.registerSchemesAsPrivileged([
  { scheme: 'pix', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }
])
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  const ses = win.webContents.session
  win.webContents.on('console-message', (...a) => {
    const m = typeof a[1] === 'object' ? a[1].message : a[2]
    w('CONSOLE ' + String(m).slice(0, 250))
  })
  await win.loadURL('data:text/html,<html><body>x</body></html>')

  const mode = process.env.MODE
  if (mode === 'global') {
    protocol.handle('pix', () => { w('global hit'); return new Response('window.__x=1', { headers: { 'Content-Type': 'application/javascript' } }) })
  } else if (mode === 'session') {
    await new Promise((res, rej) => { try { ses.protocol.handle('pix', () => { w('ses hit'); return new Response('window.__y=1', { headers: { 'Content-Type': 'application/javascript' } }) }); res() } catch (e) { rej(e) } })
  } else if (mode === 'globalBeforeWindow') {
    protocol.handle('pix', () => { w('gbw hit'); return new Response('window.__x=1', { headers: { 'Content-Type': 'application/javascript' } }) })
  }
  const r1 = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>r.text()).catch(e=>'ERR '+e.message)`, true)
  w(mode + ' fetch: ' + JSON.stringify(r1))
  app.exit(0)
})
setTimeout(() => app.exit(2), 20000)
