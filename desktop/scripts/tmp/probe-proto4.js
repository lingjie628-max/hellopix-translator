const path = require('node:path')
const { app, BrowserWindow, protocol } = require('electron')
const LOG = '/tmp/proto4.log'
const w = s => require('node:fs').appendFileSync(LOG, s + '\n')
protocol.registerSchemesAsPrivileged([
  { scheme: 'pix', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }
])
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  win.webContents.on('console-message', (...a) => {
    const m = typeof a[1] === 'object' ? a[1].message : a[2]
    w('CONSOLE ' + String(m).slice(0, 200))
  })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  const variants = {
    asyncString: async (req) => { w('hit async'); return new Response('window.__x=1', { headers: { 'Content-Type': 'application/javascript' } }) },
    asyncFile: async (req) => {
      w('hit file')
      const fsp = require('node:fs/promises')
      const body = await fsp.readFile('/tmp/patch.js', 'utf8')
      w('read ok len=' + body.length)
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' } })
    },
    syncString: (req) => new Response('window.__x=2', { headers: { 'Content-Type': 'application/javascript' } })
  }
  for (const [name, fn] of Object.entries(variants)) {
    try { win.webContents.session.protocol.unhandle('pix') } catch (e) {}
    win.webContents.session.protocol.handle('pix', fn)
    const r = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>r.text()).catch(e=>'ERR '+e.message)`, true)
    w(name + ' => ' + JSON.stringify(String(r).slice(0, 80)))
  }
  app.exit(0)
})
setTimeout(() => app.exit(2), 25000)
