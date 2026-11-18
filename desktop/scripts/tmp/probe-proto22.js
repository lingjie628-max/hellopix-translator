const { app, BrowserWindow, protocol, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const LOG = '/tmp/proto22.log'
const w = s => fs.appendFileSync(LOG, s + '\n')
protocol.registerSchemesAsPrivileged([{ scheme: 'pix', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }])
const DIR = path.join(require('node:os').tmpdir(), 'pix-imgtrans-probe-scripts')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  win.webContents.on('console-message', (...a) => {
    const m = typeof a[1] === 'object' ? a[1].message : a[2]
    w('CONSOLE ' + String(m).slice(0, 300))
  })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  const ses = win.webContents.session
  w('same as defaultSession: ' + (ses === session.defaultSession))
  w('partition: ' + ses.getPartition())
  w('ses.protocol === protocol: ' + (ses.protocol === protocol))
  w('ses.protocol keys: ' + Object.keys(Object.getPrototypeOf(ses.protocol)).join(','))
  const handler = () => { w('HANDLER RUN'); return new Response('window.__ok=1', { headers: { 'Content-Type': 'application/javascript' } }) }
  try { ses.protocol.handle('pix', handler); w('ses.handle ok') } catch (e) { w('ses.handle threw ' + e.message) }
  const r1 = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>r.text()).catch(e=>'ERR '+e.message)`, true)
  w('fetch: ' + JSON.stringify(r1))
  w('isHandled: ' + (ses.protocol.isProtocolHandled ? await ses.protocol.isProtocolHandled('pix') : 'n/a'))
  app.exit(0)
})
setTimeout(() => app.exit(2), 15000)
