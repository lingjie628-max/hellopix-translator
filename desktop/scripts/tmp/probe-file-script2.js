const path = require('node:path')
const { app, BrowserWindow, protocol, net } = require('electron')
const ROOT = __dirname
protocol.registerSchemesAsPrivileged([
  { scheme: 'pix', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }
])
app.whenReady().then(async () => {
  protocol.handle('pix', (req) => {
    const u = new URL(req.url)
    const name = u.pathname.replace(/^\/+/, '')
    return net.fetch('file://' + path.join(ROOT, name))
  })
  for (const url of [
    'data:text/html,<html><body><h1>x</h1></body></html>',
    'https://web.whatsapp.com'
  ]) {
    const win = new BrowserWindow({ show: false, webPreferences: {} })
    win.webContents.on('console-message', (...a) => {
      const m = typeof a[1] === 'object' ? a[1].message : a[2]
      console.log('[' + url.slice(0, 30) + '] CONSOLE', String(m).slice(0, 100))
    })
    try { await win.loadURL(url) } catch (e) { console.log('load fail', e.message) }
    await new Promise(r => setTimeout(r, 2000))
    const r = await win.webContents.executeJavaScript(`(() => {
      const el = document.createElement('script')
      el.src = 'pix://pix/pix-test-probe.js'
      el.onerror = () => { window.__err = 'onerror' }
      document.documentElement.appendChild(el)
      return 'inserted'
    })()`, true).catch(e => 'exec fail ' + e.message)
    await new Promise(r => setTimeout(r, 1000))
    const after = await win.webContents.executeJavaScript('({ loaded: !!window.__probeLoaded, err: window.__err || null })', true).catch(e => 'x')
    console.log('[' + url.slice(0, 30) + '] AFTER', JSON.stringify(after), r)
    win.destroy()
  }
  app.exit(0)
})
setTimeout(() => app.exit(2), 40000)
