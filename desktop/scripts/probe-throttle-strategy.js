'use strict'

/**
 * 怎么让「隐藏」的窗口真正被节流，同时不牺牲可见窗口的响应？
 *
 * ## 问题
 *
 * backgroundThrottling 只能在 WebContentsView **创建时**设定；
 * 事后再调 setBackgroundThrottling(true) 实测无效（定时器仍跑满）。
 *
 * 所以需要一个不重建进程、又能切换节流状态的方案。
 *
 * ## 候选
 *
 *   A. 隐藏时 reload 一次（重新建渲染进程）—— 必然掉号，否决
 *   B. 创建时就用 true，靠 Chromium 自己的可见性判断 —— 需验证可见窗口是否被误伤
 *   C. 创建 true + 只对可见标签显式提升优先级 —— 看有没有对应 API
 *
 * 本脚本验证 B：**同一份页面，创建时 backgroundThrottling=true**，
 * 分别测「挂上视图（可见）」与「摘下视图（隐藏）」时的定时器频率。
 * 如果可见时仍接近满速，那 B 就是答案 —— 一行改动，零结构变更。
 *
 * 用法：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-throttle-strategy.js
 */

const { app, BrowserWindow, WebContentsView } = require('electron')

const sleep = ms => new Promise(r => setTimeout(r, ms))

const PAGE = encodeURIComponent(`<!doctype html><body style="background:#081628">
<script>
  window.__ticks = 0
  setInterval(() => window.__ticks++, 100)
</script></body>`)

async function sample (view, ms) {
  const a = await view.webContents.executeJavaScript('window.__ticks')
  await sleep(ms)
  const b = await view.webContents.executeJavaScript('window.__ticks')
  return b - a
}

app.whenReady().then(async () => {
  console.log('\n=== 节流策略验证 ===\n')
  console.log('  同一页面，创建时 backgroundThrottling = true')
  console.log('  测「可见」时是否被误伤（2 秒，理论满速 20 次）\n')

  const win = new BrowserWindow({ show: true, width: 900, height: 650 })

  const view = new WebContentsView({ webPreferences: { backgroundThrottling: true } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 60, width: 900, height: 560 })
  await view.webContents.loadURL('data:text/html;charset=utf-8,' + PAGE)
  await sleep(1500)

  const visibleTicks = await sample(view, 2000)
  console.log('    挂上视图（可见，窗口在前台）: ' + visibleTicks + ' 次')

  // 把窗口藏到后面（用户切到别的 App）—— 模拟真实的"不在前台"
  win.blur()
  await sleep(800)
  const blurredTicks = await sample(view, 2000)
  console.log('    窗口失焦（App 在后台）     : ' + blurredTicks + ' 次')

  // 聚焦回来，再测可见
  win.focus()
  await sleep(800)
  const refocusTicks = await sample(view, 2000)
  console.log('    重新聚焦                    : ' + refocusTicks + ' 次')

  // 摘下视图 = 隐藏
  win.contentView.removeChildView(view)
  await sleep(1000)
  const hiddenTicks = await sample(view, 2000)
  console.log('    摘下视图（隐藏）            : ' + hiddenTicks + ' 次')

  // 再挂回去，确认节流不会"粘住"
  win.contentView.addChildView(view)
  await sleep(1000)
  const reshownTicks = await sample(view, 2000)
  console.log('    重新挂上（恢复展示）        : ' + reshownTicks + ' 次')

  console.log('\n' + '─'.repeat(62))
  const ok = refocusTicks >= 18 && hiddenTicks <= 5
  console.log('  可见时满速      : ' + (refocusTicks >= 18 ? '✔ ' + refocusTicks + '/20' : '✖ ' + refocusTicks + '/20'))
  console.log('  隐藏时被节流    : ' + (hiddenTicks <= 5 ? '✔ ' + hiddenTicks + '/20' : '✖ ' + hiddenTicks + '/20'))
  console.log('  恢复后不粘住    : ' + (reshownTicks >= 18 ? '✔ ' + reshownTicks + '/20' : '✖ ' + reshownTicks + '/20'))
  console.log('  方案 ' + (ok && reshownTicks >= 18 ? '可用：创建时用 true 即可' : '不可用，需要别的办法'))
  console.log('─'.repeat(62) + '\n')

  try { view.webContents.close() } catch (e) {}
  app.exit(0)
}).catch(err => { console.error(err); app.exit(2) })
