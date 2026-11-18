const { app, BrowserWindow, protocol } = require('electron')
const fs = require('node:fs')
const LOG = '/tmp/proto20.log'
const w = s => fs.appendFileSync(LOG, s + '\n')
protocol.registerSchemesAsPrivileged([{ scheme: 'pix', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }])
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  const ses = win.webContents.session
  ses.protocol.handle('pix', (req) => {
    w('handler called')
    try {
      const u = new URL(req.url)
      w('  hostname=' + u.hostname + ' pathname=' + u.pathname)
      const name = u.pathname.replace(/^\/+/, '')
      w('  name=' + name + ' allowed=' + new Set(['patch.js','main.js','guard.js']).has(name))
      const body = require('node:fs').readFileSync(require('node:path').join(require('node:os').tmpdir(), 'pix-imgtrans-probe-scripts', name), 'utf8')
      w('  read ' + body.length)
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' } })
    } catch (e) { w('  THREW ' + e.message); return new Response('err', { status: 500 }) }
  })
  const r1 = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>r.text()).then(t=>'LEN '+t.length).catch(e=>'ERR '+e.message)`, true)
  w('fetch: ' + JSON.stringify(r1))
  app.exit(0)
})
setTimeout(() => app.exit(2), 15000)
