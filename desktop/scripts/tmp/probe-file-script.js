const { app, BrowserWindow } = require('electron')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: {} })
  win.webContents.on('console-message', (...a) => {
    console.log('CONSOLE', typeof a[1] === 'object' ? JSON.stringify(a[1]) : a.slice(1,4).join(' | '))
  })
  await win.loadURL('data:text/html,<html><body><h1>x</h1></body></html>')
  const r = await win.webContents.executeJavaScript(`(() => {
    const el = document.createElement('script')
    el.src = 'file:///tmp/pix-test-probe.js'
    el.onerror = () => { window.__err = 'onerror' }
    document.documentElement.appendChild(el)
    return 'inserted'
  })()`, true)
  await new Promise(r => setTimeout(r, 800))
  const after = await win.webContents.executeJavaScript('({ tag: !!window.__probeLoaded, err: window.__err || null, url: location.href })', true)
  console.log('AFTER', JSON.stringify(after))
  app.exit(0)
})
setTimeout(() => app.exit(2), 15000)
