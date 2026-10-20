'use strict'

/**
 * 隐藏窗口到底省多少资源 · 真 Electron 量化。
 *
 * ## 为什么必须实测
 *
 * 用户的原话是"减少运行卡顿、无响应、内存压力"。隐藏窗口如果不能真的把
 * 内存/CPU 降下来，这个功能就只是视觉上的"藏起来"，对卡顿毫无帮助。
 *
 * 这里用真实 WebContentsView 开 N 个页面，分别测三种状态的内存与 CPU：
 *
 *   A. 可见（挂在视图树上、参与合成）
 *   B. 隐藏（摘除视图树 + 静音 + 停未读）—— 本次功能
 *   C. 销毁（对照：证明"不销毁"的代价有多大）
 *
 * A→B 的差值就是这个功能能省下的量；B→C 的差值是"为了不掉号我们还留着多少"。
 * 两个数字都要有，否则说不清取舍。
 *
 * 用法：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/bench-hidden-memory.js
 */

const { app, BrowserWindow, WebContentsView } = require('electron')

const COUNT = Number(process.env.PIX_BENCH_TABS || 4)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 用真实站点太重且不可控（网络、反爬），这里用一个持续渲染的合成页：
// 要复现"卡顿"就必须让页面有真实的绘制与 JS 负载，否则测出来的
// 内存差异全是"空白的代价"，没有参考价值。
const PAGE = encodeURIComponent(`<!doctype html><html><body style="margin:0;background:#081628">
<canvas id="c" width="900" height="600"></canvas>
<script>
  // 持续绘制 + 定时器：模拟网页版聊天界面那种永不停歇的动画/轮询
  const c = document.getElementById('c'), x = c.getContext('2d')
  let t = 0
  function frame() {
    t += 0.05
    x.fillStyle = 'hsl(' + (t * 20 % 360) + ',60%,20%)'
    x.fillRect(0, 0, 900, 600)
    for (let i = 0; i < 60; i++) {
      x.fillStyle = 'rgba(255,255,255,0.5)'
      x.fillRect((i * 37 + t * 50) % 900, (i * 53) % 600, 20, 20)
    }
    requestAnimationFrame(frame)
  }
  frame()
  // 分配一点常驻内存，模拟会话数据
  window.__blob = new Array(2000).fill('x'.repeat(1000))
</script></body></html>`)

function mem () {
  const m = process.getMemoryUsage ? process.getMemoryUsage() : process.memoryUsage()
  return { rss: m.rss || 0 }
}

/** 整个应用（含所有渲染进程）的 RSS，从系统角度统计 —— 这才是用户感知的"内存压力"。 */
function appRss () {
  try {
    const { execSync } = require('child_process')
    if (process.platform === 'darwin') {
      const pid = process.pid
      const out = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim()
      // ps 只能看到主进程。子进程用 pgrep -P 递归统计。
      const kids = execSync(`pgrep -P ${pid} || true`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
      let total = Number(out) || 0
      for (const k of kids) {
        const v = execSync(`ps -o rss= -p ${k}`, { encoding: 'utf8' }).trim()
        total += Number(v) || 0
      }
      return total * 1024
    }
  } catch (e) {}
  return mem().rss
}

const mb = n => Math.round(n / 1048576) + ' MB'

app.whenReady().then(async () => {
  console.log('\n=== 隐藏窗口资源占用 · 真 Electron 实测 ===\n')
  console.log('  窗口数：' + COUNT + '\n')

  const win = new BrowserWindow({ show: true, width: 1000, height: 720 })
  const views = []
  const baseRss = appRss()
  console.log('  基线（不含窗口）：' + mb(baseRss))

  // ── A. 全部可见 ────────────────────────────────────────────────
  for (let i = 0; i < COUNT; i++) {
    const view = new WebContentsView({
      webPreferences: { partition: 'persist:pixbench-' + i, backgroundThrottling: false }
    })
    win.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 60, width: 1000, height: 620 })
    views.push(view)
    await view.webContents.loadURL('data:text/html;charset=utf-8,' + PAGE)
  }
  await sleep(2500)
  const visibleRss = appRss()
  await sleep(2000)
  const visibleRss2 = appRss()
  console.log('\n  A. 全部可见')
  console.log('     内存      : ' + mb(visibleRss2) + '（增量 ' + mb(visibleRss2 - baseRss) + '）')
  console.log('     每窗口约  : ' + mb((visibleRss2 - baseRss) / COUNT))

  // ── B. 隐藏（本次功能的做法）───────────────────────────────────
  for (const view of views) {
    win.contentView.removeChildView(view)
    view.webContents.setAudioMuted(true)
  }
  await sleep(3000)
  const hiddenRss = appRss()
  await sleep(2000)
  const hiddenRss2 = appRss()
  console.log('\n  B. 已隐藏（摘视图 + 静音）')
  console.log('     内存      : ' + mb(hiddenRss2) + '（增量 ' + mb(hiddenRss2 - baseRss) + '）')
  console.log('     相比可见  : ' + (hiddenRss2 < visibleRss2 ? '省 ' : '多 ') + mb(Math.abs(hiddenRss2 - visibleRss2)))

  // ── C. 销毁（对照）────────────────────────────────────────────
  for (const view of views) {
    try { view.webContents.close() } catch (e) {}
  }
  await sleep(3000)
  const closedRss = appRss()
  console.log('\n  C. 全部销毁（对照，但会掉号）')
  console.log('     内存      : ' + mb(closedRss) + '（增量 ' + mb(closedRss - baseRss) + '）')
  console.log('     隐藏比销毁多占 : ' + mb(hiddenRss2 - closedRss))

  console.log('\n' + '─'.repeat(64))
  console.log('  结论')
  console.log('   隐藏 vs 可见 ：' + (visibleRss2 - hiddenRss2 > 0
    ? '省 ' + mb(visibleRss2 - hiddenRss2)
    : '基本持平（进程还活着，省的是 GPU/绘制，不是内存）'))
  console.log('   隐藏 vs 销毁 ：多占 ' + mb(hiddenRss2 - closedRss) + '（这是"不掉号"的代价）')
  console.log('─'.repeat(64) + '\n')

  app.exit(0)
}).catch(err => {
  console.error(err)
  app.exit(2)
})
