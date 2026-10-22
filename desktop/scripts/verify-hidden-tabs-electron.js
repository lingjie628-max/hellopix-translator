'use strict'

/**
 * 隐藏窗口（后台运行）· 真 Electron 端到端验收。
 *
 * ## 为什么要真跑 Electron
 *
 * 这个功能的核心承诺是三条，**只有真跑才能证明**：
 *
 *   1. 不掉号 —— 隐藏期间 webContents 必须活着，页面里的 JS 上下文不能重建；
 *   2. 恢复即回到原画面 —— 不 reload、不重新加载，滚动位置和页面状态都在；
 *   3. 不占资源 —— 从视图树上摘下后不再上屏合成。
 *
 * 单测（test/hidden-tabs.test.js）只能证明"计划里有哪几步"，
 * 证明不了 Electron 真的按这个计划执行了。这里用真实 WebContentsView 验证。
 *
 * 另外验证渲染层两处关键行为（用真实 index.html + app.js）：
 *   - 隐藏窗口不进标签栏，出现"后台运行"入口；
 *   - 垃圾桶没勾选时只弹提示，一个窗口都不关。
 *
 * 用法：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/verify-hidden-tabs-electron.js
 */

const { app, BrowserWindow, WebContentsView } = require('electron')
const path = require('path')

const root = path.join(__dirname, '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rows = []
function check (name, pass, detail) {
  rows.push({ name, pass: !!pass, detail })
  console.log((pass ? '  ✔ ' : '  ✖ ') + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)))
}

const PAGE = 'data:text/html,<h1 id="t">page</h1><script>window.__boot=Math.random();window.__mark=0;setInterval(()=>window.__mark++,200)</script>'

app.whenReady().then(async () => {
  console.log('\n=== 隐藏窗口（后台运行）· 真 Electron 验收 ===\n')

  const win = new BrowserWindow({ show: false, width: 900, height: 700 })

  // ── 1. 隐藏 = 进程与页面上下文都活着 ──────────────────────────────
  const view = new WebContentsView({ webPreferences: { partition: 'persist:verify-hidden-' + Date.now() } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 60, width: 900, height: 600 })
  await view.webContents.loadURL(PAGE)
  await sleep(300)

  const wcIdBefore = view.webContents.id
  const bootBefore = await view.webContents.executeJavaScript('window.__boot')
  const markBefore = await view.webContents.executeJavaScript('window.__mark')

  // 按真实计划执行：摘视图 + 静音
  win.contentView.removeChildView(view)
  view.webContents.setAudioMuted(true)
  check('隐藏：从视图树摘除', win.contentView.children.indexOf(view) < 0)
  check('隐藏：已静音', view.webContents.isAudioMuted() === true)

  await sleep(700)

  check('隐藏期间 webContents 未被销毁', !view.webContents.isDestroyed(), { id: wcIdBefore })
  const aliveId = view.webContents.id
  check('隐藏期间 webContents id 不变（进程没重建）', aliveId === wcIdBefore,
    { before: wcIdBefore, after: aliveId })

  // 页面自己的定时器还在跑 = JS 上下文没被冻结/重建。
  // 注意：隐藏后定时器会被**节流**（这正是 backgroundThrottling 的作用，
  // 2 秒一次左右），所以不能指望 700ms 内跑很多次；用 3 秒窗口来确认它还活着。
  await sleep(2600)
  const markAfter = await view.webContents.executeJavaScript('window.__mark')
  check('隐藏期间页面 JS 仍在运行（上下文未重建）', markAfter > markBefore,
    { before: markBefore, after: markAfter })
  // 顺便验证节流真的生效：定时器没跑满（200ms 一次，3.3 秒理论上限约 16 次）
  check('隐藏期间定时器被节流（没有跑满）', markAfter < 16, { ticks: markAfter })

  // ── 2. 恢复 = 回到同一份页面状态，不 reload ────────────────────────
  const urlBefore = view.webContents.getURL()
  win.contentView.addChildView(view)
  view.webContents.setAudioMuted(false)
  await sleep(250)

  check('恢复：重新挂回视图树', win.contentView.children.indexOf(view) >= 0)
  check('恢复：取消静音', view.webContents.isAudioMuted() === false)
  const bootAfter = await view.webContents.executeJavaScript('window.__boot')
  check('恢复：没有重新加载（window.__boot 未变）', bootAfter === bootBefore,
    { before: bootBefore, after: bootAfter })
  check('恢复：URL 保持原页面', view.webContents.getURL() === urlBefore)

  // ── 3. 隐藏期间不产生上屏绘制 ────────────────────────────────────
  // 摘下后 view 不属于 children，Chromium 不会为它合成帧。
  const attachedWhileHidden = win.contentView.children.length
  win.contentView.removeChildView(view)
  check('摘除后不参与合成（children 里没有它）',
    win.contentView.children.length === attachedWhileHidden - 1)

  view.webContents.close()

  // ── 4. 渲染层：标签栏、恢复入口、垃圾桶 ──────────────────────────
  //
  // 用真实 index.html + app.js，但把 window.pix 换成桩，
  // 这样能直接检查真实 DOM 结构。
  const ui = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(root, 'scripts', 'verify-hidden-tabs-ui-preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false
    }
  })
  const closeCalls = []
  await ui.loadFile(path.join(root, 'renderer', 'index.html'))
  await ui.webContents.executeJavaScript(`
    window.__closeCalls = ${JSON.stringify(closeCalls)}
    window.__pixStub = { closed: [] }
  `)
  // 用真实 app.js 的 renderTabs 渲染一个"1 可见 + 2 隐藏"的状态
  const dom = await ui.webContents.executeJavaScript(`(async () => {
    const mod = document.createElement('script')
    // index.html 自带的 app.js 已经加载过，这里直接调用它暴露到全局的函数：
    // app.js 是普通脚本，函数在 window 作用域上。
    const rows = [
      { id: 'a', platform: 'whatsapp', name: '凯瑟琳', hidden: false, unread: 0, settings: {} },
      { id: 'b', platform: 'whatsapp', name: '卡罗琳', hidden: true, unread: 0, settings: {} },
      { id: 'c', platform: 'whatsapp', name: '江顺明星', hidden: true, unread: 0, settings: {} }
    ]
    if (typeof renderTabs !== 'function') return { error: 'renderTabs 不可见' }
    renderTabs({ home: false, activeId: 'a', rows })
    const tabsEl = document.getElementById('tabs')
    const visibleTabs = [...tabsEl.querySelectorAll('.tab[data-tab-id]')].map(e => e.dataset.tabId)
    const tray = tabsEl.querySelector('.tab-hidden-tray')
    const panel = document.getElementById('hiddenTrayPanel')
    const enabledMeta = document.getElementById('enabledMeta')
    const enabledRows = document.querySelectorAll('#enabledList .enabled-row').length
    return {
      visibleTabs,
      hasTray: !!tray,
      trayCount: tray ? tray.querySelector('.tab-tray-count').textContent : '',
      panelRows: panel ? panel.querySelectorAll('.hidden-tray-row').length : 0,
      panelNames: panel ? [...panel.querySelectorAll('.hidden-tray-name')].map(e => e.textContent) : [],
      enabledMeta: enabledMeta ? enabledMeta.textContent : '',
      enabledRows
    }
  })()`)

  if (dom.error) {
    check('renderTabs 可调用', false, dom.error)
  } else {
    check('标签栏只渲染可见窗口', JSON.stringify(dom.visibleTabs) === JSON.stringify(['a']), dom.visibleTabs)
    check('出现「后台运行」入口', dom.hasTray === true)
    check('入口显示隐藏数量', dom.trayCount === '2', dom.trayCount)
    check('面板列出全部隐藏窗口', dom.panelRows === 2 && dom.panelNames.join() === '卡罗琳,江顺明星', dom.panelNames)
    check('「已启用的应用」不含隐藏窗口', dom.enabledMeta === '1 个应用' && dom.enabledRows === 1,
      { meta: dom.enabledMeta, rows: dom.enabledRows })
  }

  // ── 5. 垃圾桶：没勾选就只提示，一个都不关 ────────────────────────
  const trash = await ui.webContents.executeJavaScript(`(async () => {
    const closed = []
    window.pix.close = id => { closed.push(id); return Promise.resolve({ success: true }) }
    const btn = document.getElementById('clearEnabled')
    if (!btn) return { error: '找不到垃圾桶按钮' }
    btn.click()
    await new Promise(r => setTimeout(r, 60))
    const toastEl = document.getElementById('pixToast')
    return {
      closed,
      toastText: toastEl ? toastEl.textContent : '',
      toastOpen: toastEl ? toastEl.matches(':popover-open') : false
    }
  })()`)

  if (trash.error) {
    check('垃圾桶可用', false, trash.error)
  } else {
    check('没勾选时一个窗口都不关', trash.closed.length === 0, trash.closed)
    check('弹出提示文案', trash.toastText === '请选择需要关闭的窗口应用', trash.toastText)
    check('提示可见（在 top-layer 上）', trash.toastOpen === true)
  }

  // ── 6. 勾选后只关勾选的（批量关闭也要过一次确认）──────────────────
  const sel = await ui.webContents.executeJavaScript(`(async () => {
    const closed = []
    window.pix.close = id => { closed.push(id); return Promise.resolve({ success: true }) }
    renderTabs({ home: false, activeId: 'a', rows: [
      { id: 'a', platform: 'whatsapp', name: '接粉1', hidden: false, unread: 0, settings: {} }
    ]})
    await new Promise(r => setTimeout(r, 30))
    const boxes = document.querySelectorAll('#enabledList input[type=checkbox]')
    if (boxes.length) { boxes[0].click(); boxes[0].dispatchEvent(new Event('change')) }
    document.getElementById('clearEnabled').click()
    await new Promise(r => setTimeout(r, 60))
    const dlg = document.getElementById('closeConfirm')
    const askedBeforeClose = closed.length === 0
    // 批量关闭的确认框里应写明数量/名称
    const title = document.getElementById('closeConfirmTitle').textContent
    document.getElementById('closeConfirmOk').click()
    await new Promise(r => setTimeout(r, 80))
    return { closed, checked: boxes.length, askedBeforeClose, title }
  })()`)

  check('批量关闭前也要确认', sel.askedBeforeClose === true, sel.closed)
  check('批量关闭确认文案写明是哪个', /接粉1/.test(sel.title || ''), sel.title)
  check('勾选后只关勾选的那个', sel.closed.length === 1 && sel.closed[0] === 'a', sel.closed)

  // ── 7. 关闭二次确认（真实点击）────────────────────────────────────
  const confirm = await ui.webContents.executeJavaScript(`(async () => {
    const closed = []
    window.pix.close = id => { closed.push(id); return Promise.resolve({ success: true }) }
    renderTabs({ home: false, activeId: 'a', rows: [
      { id: 'a', platform: 'whatsapp', name: '接粉1', hidden: false, unread: 0, settings: {} }
    ]})
    await new Promise(r => setTimeout(r, 30))
    const dlg = document.getElementById('closeConfirm')
    const x = document.querySelector('.tab[data-tab-id="a"] .x')
    const out = {}

    // 7a. 点 × → 必须弹出确认，且此时一个都没关
    x.click()
    await new Promise(r => setTimeout(r, 150))
    out.dialogOpen = !!dlg && dlg.open
    out.dialogExists = !!dlg
    out.hasShowModal = !!(dlg && typeof dlg.showModal === 'function')
    out.closedAfterX = closed.slice()
    out.title = document.getElementById('closeConfirmTitle').textContent
    out.focused = document.activeElement && document.activeElement.id
    out.pending = !!document.getElementById('closeConfirm').open

    // 7b. 点「取消」→ 仍然不关
    document.getElementById('closeConfirmCancel').click()
    await new Promise(r => setTimeout(r, 60))
    out.closedAfterCancel = closed.slice()
    out.dialogClosed = !dlg.open

    // 7c. 再点 × 然后按 ESC → 仍然不关
    x.click()
    await new Promise(r => setTimeout(r, 60))
    out.reopened = dlg.open
    dlg.dispatchEvent(new Event('cancel', { cancelable: true }))
    await new Promise(r => setTimeout(r, 60))
    out.closedAfterEsc = closed.slice()

    // 7d. 点「确认」→ 这才关
    x.click()
    await new Promise(r => setTimeout(r, 60))
    document.getElementById('closeConfirmOk').click()
    await new Promise(r => setTimeout(r, 80))
    out.closedAfterConfirm = closed.slice()

    return out
  })()`)

  check('点 × 弹出确认框', confirm.dialogOpen === true, {
    exists: confirm.dialogExists, hasShowModal: confirm.hasShowModal, open: confirm.pending
  })
  check('确认框里写明是哪个窗口', /接粉1/.test(confirm.title || ''), confirm.title)
  check('默认焦点在「取消」上', confirm.focused === 'closeConfirmCancel', confirm.focused)
  check('点 × 后还没关', confirm.closedAfterX.length === 0, confirm.closedAfterX)
  check('点「取消」不关', confirm.closedAfterCancel.length === 0, confirm.closedAfterCancel)
  check('取消后框会收起', confirm.dialogClosed === true)
  check('按 ESC 不关', confirm.closedAfterEsc.length === 0, confirm.closedAfterEsc)
  check('点「确认」才真正关闭', confirm.closedAfterConfirm.length === 1 && confirm.closedAfterConfirm[0] === 'a',
    confirm.closedAfterConfirm)

  // ── 8. 标签栏滚轮横向滚动（真实布局溢出）──────────────────────────
  const wheel = await ui.webContents.executeJavaScript(`(async () => {
    // 布局测量必须有真实尺寸：验收窗口此前是隐藏的，scrollWidth 会全是 0。
    // 真正隐藏的是 #shell.screen，.stage 只是它的子元素。
    const shell = document.getElementById('shell')
    if (shell) { shell.classList.remove('hidden'); shell.style.display = 'block' }
    // 造 20 个标签，保证真的溢出
    const rows = []
    for (let i = 0; i < 20; i++) {
      rows.push({ id: 'w' + i, platform: 'whatsapp', name: '账号' + (i + 1), hidden: false, unread: 0, settings: {} })
    }
    renderTabs({ home: false, activeId: 'w0', rows })
    await new Promise(r => setTimeout(r, 120))
    const el = document.getElementById('tabs')
    const out = {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflow: el.scrollWidth > el.clientWidth
    }
    if (!out.overflow) return out

    el.scrollLeft = 0
    await new Promise(r => setTimeout(r, 30))
    const before = el.scrollLeft

    // 合成一个真实语义的垂直滚轮：deltaY>0、非 shift、像素模式
    const ev = new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true })
    el.dispatchEvent(ev)
    await new Promise(r => setTimeout(r, 60))

    out.before = before
    out.after = el.scrollLeft
    out.defaultPrevented = ev.defaultPrevented

    // 一路滚到底，再滚一次应当放行（不 preventDefault）
    el.scrollLeft = el.scrollWidth - el.clientWidth
    await new Promise(r => setTimeout(r, 30))
    const edge = new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true })
    el.dispatchEvent(edge)
    await new Promise(r => setTimeout(r, 60))
    out.edgePrevented = edge.defaultPrevented

    // 反向滚回去
    const back = new WheelEvent('wheel', { deltaY: -200, deltaMode: 0, bubbles: true, cancelable: true })
    el.dispatchEvent(back)
    await new Promise(r => setTimeout(r, 60))
    out.backAfter = el.scrollLeft
    return out
  })()`)

  if (wheel.overflow) {
    check('滚轮能横向滚动标签栏', wheel.after > wheel.before, { before: wheel.before, after: wheel.after })
    check('滚轮时拦住页面默认滚动', wheel.defaultPrevented === true)
    check('滚到底后放行（不卡死手感）', wheel.edgePrevented === false)
    check('反向滚轮能滚回去', wheel.backAfter < wheel.scrollWidth - wheel.clientWidth, {
      back: wheel.backAfter, max: wheel.scrollWidth - wheel.clientWidth
    })
  } else {
    check('标签栏溢出（前置条件）', false, wheel)
  }

  // ── 汇总 ─────────────────────────────────────────────────────────
  const failed = rows.filter(r => !r.pass)
  console.log('\n' + '─'.repeat(62))
  console.log('  通过 ' + (rows.length - failed.length) + '/' + rows.length)
  if (failed.length) {
    console.log('  失败：')
    failed.forEach(r => console.log('   ✖ ' + r.name + (r.detail === undefined ? '' : '  → ' + JSON.stringify(r.detail))))
  }
  console.log('─'.repeat(62) + '\n')

  await sleep(100)
  app.exit(failed.length ? 1 : 0)
}).catch(err => {
  console.error('验收脚本异常：', err)
  app.exit(2)
})
