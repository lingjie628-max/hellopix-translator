'use strict'

/**
 * backgroundThrottling 对隐藏窗口的真实影响。
 *
 * ## 为什么要单独测
 *
 * createWebView 里写死了 `backgroundThrottling: false`。这个开关的语义是
 * "即使窗口在后台，也别节流我的定时器/渲染"。
 *
 * 对**可见**的标签它是必要的（否则用户切走后当前标签会掉帧、收消息变慢）。
 * 但对**已被隐藏**的窗口，它正好是反的：我们希望它被压到最低。
 *
 * 本脚本对比：隐藏后，throttling 开 vs 关 时定时器的实际触发频率。
 * 这直接决定隐藏窗口会不会在后台偷偷烧 CPU。
 *
 * 用法：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-hidden-throttling.js
 */

const { app, BrowserWindow, WebContentsView } = require('electron')

const sleep = ms => new Promise(r => setTimeout(r, ms))

const PAGE = encodeURIComponent(`<!doctype html><body style="background:#081628">
<script>
  window.__ticks = 0
  setInterval(() => window.__ticks++, 100)
</script></body>`)

app.whenReady().then(async () => {
  console.log('\n=== backgroundThrottling 对隐藏窗口的影响 ===\n')

  const win = new BrowserWindow({ show: true, width: 900, height: 650 })

  async function measure (throttling) {
    const view = new WebContentsView({ webPreferences: { backgroundThrottling: throttling } })
    win.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 60, width: 900, height: 560 })
    await view.webContents.loadURL('data:text/html;charset=utf-8,' + PAGE)
    await sleep(1200)

    // 摘掉视图 = 隐藏
    win.contentView.removeChildView(view)
    await sleep(1200)

    const a = await view.webContents.executeJavaScript('window.__ticks')
    await sleep(2000)
    const b = await view.webContents.executeJavaScript('window.__ticks')
    const ticks = b - a

    // 隐藏后再显式把 throttling 关掉（模拟"运行时补救"）
    let afterToggle = null
    if (typeof view.webContents.setBackgroundThrottling === 'function') {
      view.webContents.setBackgroundThrottling(true)
      await sleep(800)
      const c = await view.webContents.executeJavaScript('window.__ticks')
      await sleep(2000)
      const d = await view.webContents.executeJavaScript('window.__ticks')
      afterToggle = d - c
    }

    try { view.webContents.close() } catch (e) {}
    await sleep(500)
    return { ticks, afterToggle, throttling }
  }

  const off = await measure(false)
  const on = await measure(true)

  console.log('  隐藏后 2 秒内定时器触发次数（理论值 20）\n')
  console.log('    backgroundThrottling=false（当前代码）: ' + off.ticks + ' 次')
  console.log('    backgroundThrottling=true            : ' + on.ticks + ' 次')
  if (off.afterToggle !== null) {
    console.log('    false 起步 → 隐藏后改成 true         : ' + off.afterToggle + ' 次')
  }

  console.log('\n' + '─'.repeat(60))
  const saved = off.ticks - on.ticks
  if (saved > 0) {
    console.log('  结论：隐藏后把 throttling 打开，可再降低 ' +
      Math.round(saved / Math.max(1, off.ticks) * 100) + '% 的后台活动')
  } else {
    console.log('  结论：throttling 对已隐藏的窗口没区别（Chromium 已自行节流）')
  }
  console.log('─'.repeat(60) + '\n')

  app.exit(0)
}).catch(err => { console.error(err); app.exit(2) })
