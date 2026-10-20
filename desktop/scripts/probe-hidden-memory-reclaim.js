'use strict'

/**
 * 隐藏窗口能不能真的把内存还回去？
 *
 * ## 已知
 *
 * 摘视图树后 GPU/CPU 立刻降下来（60fps → 1fps），但内存只省 15MB ——
 * 因为渲染进程的 JS 堆与页面缓存还整个留在那里。
 *
 * ## 本脚本要回答
 *
 * 有没有办法在不销毁进程的前提下，让渲染进程把**可回收**的内存真的交还给系统？
 *
 * 试三种：
 *   A. 强制 GC（--js-flags=--expose-gc + 页面内 gc()）
 *   B. 清 HTTP 缓存（session.clearCache）—— 缓存是磁盘+内存双份
 *   C. 内存压力通知（Chromium 内部的 MemoryPressureListener）
 *
 * 同时测一个**关键对照**：隐藏到后台的进程，系统在真实内存压力下
 * 会不会自己回收它（macOS 的 memory pressure / swap）。这决定了
 * 我们是否值得为它写额外逻辑。
 *
 * 用法：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-hidden-memory-reclaim.js
 */

const { app, BrowserWindow, WebContentsView } = require('electron')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const mb = n => Math.round(n / 1048576) + ' MB'

// 让页面分配大量**可回收**内存（数组、字符串）：这正是真实聊天界面
// 长时间运行后的典型状态 —— 一堆消息在 JS 堆里。
const PAGE = encodeURIComponent(`<!doctype html><html><body style="margin:0;background:#081628">
<div id="a"></div>
<script>
  window.__junk = []
  for (let i = 0; i < 400; i++) window.__junk.push(new Array(5000).fill('message-' + i))
  window.__rss = () => performance.memory
    ? Math.round(performance.memory.usedJSHeapSize / 1048576)
    : -1
</script></body></html>`)

function appRss () {
  const { execSync } = require('child_process')
  const pid = process.pid
  let total = Number(execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim()) || 0
  for (const k of execSync(`pgrep -P ${pid} || true`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)) {
    total += Number(execSync(`ps -o rss= -p ${k}`, { encoding: 'utf8' }).trim()) || 0
  }
  return total * 1024
}

app.commandLine.appendSwitch('js-flags', '--expose-gc')

app.whenReady().then(async () => {
  console.log('\n=== 隐藏窗口内存回收探测 ===\n')

  const win = new BrowserWindow({ show: true, width: 900, height: 650 })
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 60, width: 900, height: 560 })
  await view.webContents.loadURL('data:text/html;charset=utf-8,' + PAGE)
  await sleep(2500)

  const visible = appRss()
  const heapVisible = await view.webContents.executeJavaScript('window.__rss()')
  console.log('  可见     : ' + mb(visible) + '   页面堆 ' + heapVisible + 'MB')

  win.contentView.removeChildView(view)
  view.webContents.setAudioMuted(true)
  await sleep(2000)
  const hidden = appRss()
  console.log('  隐藏后   : ' + mb(hidden) + '   页面堆 ' + (await view.webContents.executeJavaScript('window.__rss()')) + 'MB')

  // A. 强制 GC —— 先把引用扔掉，再 gc()。真实场景对应"页面自己没在用了"，
  //    但我们无法替页面扔掉它的引用，所以这里只能测**理论上限**。
  const gcResult = await view.webContents.executeJavaScript(`(async () => {
    if (typeof gc !== 'function') return 'gc 不可用'
    window.__junk = []
    gc()
    await new Promise(r => setTimeout(r, 300))
    gc()
    return 'gc 已执行'
  })()`).catch(e => 'gc 失败：' + e.message)
  await sleep(1500)
  const afterGc = appRss()
  console.log('  A 强制GC : ' + mb(afterGc) + '   ' + gcResult)

  // B. 清缓存
  await view.webContents.session.clearCache().catch(() => {})
  await sleep(1200)
  const afterCache = appRss()
  console.log('  B 清缓存 : ' + mb(afterCache))

  // C. 只读、不再渲染的真实网页：看后台进程内存会不会自然回落
  await sleep(3000)
  const settle = appRss()
  console.log('  C 静置后 : ' + mb(settle))

  console.log('\n' + '─'.repeat(60))
  console.log('  可见 → 隐藏            : ' + (hidden < visible ? '省 ' + mb(visible - hidden) : '多 ' + mb(hidden - visible)))
  console.log('  隐藏 → 强制GC 之后     : ' + (afterGc < hidden ? '再省 ' + mb(hidden - afterGc) : '没变化'))
  console.log('  每个隐藏窗口的实际占用 : ' + mb(settle) + '（含主进程基线）')
  console.log('─'.repeat(60) + '\n')

  app.exit(0)
}).catch(err => { console.error(err); app.exit(2) })
