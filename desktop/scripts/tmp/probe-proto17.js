const { app, BrowserWindow, protocol } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const LOG = '/tmp/proto14.log'
const w = s => fs.appendFileSync(LOG, s + '\n')
protocol.registerSchemesAsPrivileged([{ scheme: 'pix', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }])
const DIR = path.join(require('node:os').tmpdir(), 'pix-imgtrans-probe-scripts')
const V = process.env.V
const STYLE = process.env.S
app.whenReady().then(async () => {
  const handler = (request) => {
    w(V + ' handler called ' + request.url)
    const body = fs.readFileSync(path.join(DIR, 'patch.js'), 'utf8')
    w('body len ' + body.length)
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' } })
  }
  const win = new BrowserWindow({ show: false })
  const ses = win.webContents.session
  if (V === 'sesProto') ses.protocol.handle('pix', handler)
  else if (V === 'sesProtoPromise') await ses.protocol.handle('pix', handler)
  else if (V === 'globNoAwait') protocol.handle('pix', handler)
  else if (V === 'globAwait') await protocol.handle('pix', handler)
  if (STYLE === 'prod') {
    const proto = require('../../src/translate/pix-protocol')
    const ok = proto.attachHandler(require('electron'), V.startsWith('glob') ? null : ses, DIR)
    w('attachHandler=' + ok)
    if (V.startsWith('glob')) protocol.handle('pix', handler)
  }
  if (V.startsWith('glob')) await new Promise(r => setTimeout(r, 100))
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  const r1 = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>r.text()).then(t=>'LEN '+t.length).catch(e=>'ERR '+e.message)`, true)
  w(V + ' => ' + JSON.stringify(r1))
  app.exit(0)
})
setTimeout(() => app.exit(2), 20000)
