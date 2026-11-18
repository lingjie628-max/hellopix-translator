const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, protocol, net } = require('electron')
const DIR = __dirname
protocol.registerSchemesAsPrivileged([
  { scheme: 'pix', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }
])
app.whenReady().then(async () => {
  // A: 全局注册
  protocol.handle('pix', () => new Response('console.log("A GLOBAL OK")', { headers: { 'Content-Type': 'application/javascript' } }))
  const win = new BrowserWindow({ show: false })
  win.webContents.on('console-message', (...a) => {
    const m = typeof a[1] === 'object' ? a[1].message : a[2]
    require('node:fs').appendFileSync('/tmp/proto.log', 'CONSOLE '+String(m).slice(0,200)+'\n')
  })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  const r1 = await win.webContents.executeJavaScript(`fetch('pix://pix/patch.js').then(r=>r.text()).catch(e=>'ERR '+e.message)`, true)
  require('node:fs').appendFileSync('/tmp/proto.log', 'A fetch: '+JSON.stringify(r1)+'\n')
  const r2 = await win.webContents.executeJavaScript(`(async () => { const s=document.createElement('script'); s.textContent='window.__x=1'; document.documentElement.appendChild(s); return window.__x || 'inline blocked' })()`, true)
  require('node:fs').appendFileSync('/tmp/proto.log', 'inline: '+JSON.stringify(r2)+'\n')
  app.exit(0)
})
setTimeout(() => app.exit(2), 20000)
