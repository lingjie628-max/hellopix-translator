'use strict'

/**
 * 找出"隐藏后还能怎么降载"，并量化每一种的实际效果。
 *
 * ## 背景
 *
 * bench-hidden-memory.js 实测：摘掉视图树只省了 16MB（4 个窗口），
 * 而每窗口本身占约 63MB。说明**摘视图只省绘制，不省内存**。
 * 要真的缓解"卡顿/内存压力"，必须让隐藏进程自己降下来。
 *
 * 这里逐个试手段，测每一项对 RSS 与 CPU 的实际影响：
 *
 *   1. 调低渲染帧率（setFrameRate）—— 动画/视频不再跑满 60fps
 *   2. 派发 visibilitychange（页面自己会停掉轮询/动画）
 *   3. 内存压力通知（Chromium 会主动回收缓存）
 *   4. 渲染进程降优先级
 *
 * 用法：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-hidden-throttle.js
 */

const { app, BrowserWindow, WebContentsView } = require('electron')
const path = require('path')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const mb = n => Math.round(n / 1048576) + ' MB'

const PAGE = encodeURIComponent(`<!doctype html><html><body style="margin:0;background:#081628">
<canvas id="c" width="900" height="600"></canvas>
<script>
  const c = document.getElementById('c'), x = c.getContext('2d')
  let t = 0, frames = 0
  window.__frames = () => frames
  function frame() {
    frames++; t += 0.05
    x.fillStyle = 'hsl(' + (t * 20 % 360) + ',60%,20%)'
    x.fillRect(0, 0, 900, 600)
    for (let i = 0; i < 60; i++) { x.fillStyle = 'rgba(255,255,255,0.5)'; x.fillRect((i*37+t*50)%900, (i*53)%600, 20, 20) }
    requestAnimationFrame(frame)
  }
  frame()
  window.__blob = new Array(2000).fill('x'.repeat(1000))
  window.__vis = []
  document.addEventListener('visibilitychange', () => window.__vis.push(document.visibilityState))
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

/** 采样 1 秒内页面跑了多少帧 —— 这是 CPU 占用最直接的代理指标。 */
async function fps (view) {
  const a = await view.webContents.executeJavaScript('window.__frames()')
  await sleep(1000)
  const b = await view.webContents.executeJavaScript('window.__frames()')
  return b - a
}

app.whenReady().then(async () => {
  console.log('\n=== 隐藏降载手段探测 ===\n')
  const proto = Object.getPrototypeOf(new WebContentsView({}).webContents)
  for (const n of ['setFrameRate', 'setBackgroundThrottling', 'setAudioMuted', 'isCurrentlyAudible']) {
    console.log('  API ' + n.padEnd(28) + typeof proto[n])
  }
  console.log('  setPageVisibility (host)' + ' '.repeat(12) + typeof app.setPageVisibility)

  const win = new BrowserWindow({ show: true, width: 1000, height: 720 })
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 60, width: 1000, height: 620 })
  await view.webContents.loadURL('data:text/html;charset=utf-8,' + PAGE)
  await sleep(2000)

  const base = appRss()
  const baseFps = await fps(view)
  console.log('\n  可见：' + mb(base) + '   ' + baseFps + ' fps')

  // 1. 摘视图
  win.contentView.removeChildView(view)
  await sleep(1500)
  console.log('  摘视图：' + mb(appRss()) + '   ' + (await fps(view)) + ' fps')

  // 2. 调帧率
  if (typeof view.webContents.setFrameRate === 'function') {
    view.webContents.setFrameRate(1)
    await sleep(1500)
    console.log('  +帧率降到1：' + mb(appRss()) + '   ' + (await fps(view)) + ' fps')
  }

  // 3. 派发 visibilitychange
  try {
    await view.webContents.executeJavaScript(
      "document.dispatchEvent(new Event('visibilitychange'))", true)
    await sleep(800)
    const vis = await view.webContents.executeJavaScript('JSON.stringify(window.__vis)')
    console.log('  派发 visibilitychange 后页面记录：' + vis)
  } catch (e) { console.log('  visibilitychange 失败：' + e.message) }

  // 4. 内存压力通知：Chromium 会回收缓存
  // app.getAppMetrics 拿每个渲染进程的内存
  const metrics = app.getAppMetrics()
  const renderer = metrics.filter(m => m.type === 'Tab').slice(0, 1)
  console.log('  渲染进程内存（getAppMetrics）：' + JSON.stringify(renderer.map(r => r.memory)))

  // 5. 试试能不能让渲染进程降优先级（需要通过 pid）
  if (renderer[0] && renderer[0].pid) {
    const { execSync } = require('child_process')
    try {
      execSync(`renice 10 -p ${renderer[0].pid} 2>/dev/null || true`)
      console.log('  renice 已施加于渲染进程 pid=' + renderer[0].pid)
    } catch (e) {}
  }

  await sleep(1500)
  const final = appRss()
  const finalFps = await fps(view)
  console.log('\n  最终：' + mb(final) + '   ' + finalFps + ' fps')
  console.log('  相比可见：内存 ' + (final < base ? '省 ' + mb(base - final) : '多 ' + mb(final - base)) +
    '，帧率 ' + baseFps + ' → ' + finalFps)

  app.exit(0)
}).catch(err => { console.error(err); app.exit(2) })
