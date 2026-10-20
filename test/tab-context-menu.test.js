'use strict'

/**
 * 标签栏右键菜单。
 *
 * 断言的重点不是"菜单能弹出来"，而是**危险项有没有放对位置**：
 *   - 隐藏必须和关闭分开。放进"关闭"那一组，误点会把正在收消息的
 *     窗口藏掉，用户会以为被关了。
 *   - 关闭必须走 closeAsk（渲染层二次确认），主进程直接关 = 绕过了确认。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createTabContextMenu, menuTemplate } = require('../desktop/src/window/tab-context-menu')

function ctx (opts) {
  const o = opts || {}
  const calls = []
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getZoomFactor: () => o.zoom === undefined ? 1 : o.zoom,
    setZoomFactor: v => calls.push(['zoom', v]),
    reload: () => calls.push(['reload']),
    reloadIgnoringCache: () => calls.push(['reloadIgnoringCache']),
    session: { clearCache: async () => calls.push(['clearCache']) }
  })
  const tab = { id: 'wa-1', platform: 'wa', view: { webContents: wc } }
  return {
    home: !!o.home,
    tab: o.noTab ? null : tab,
    // 默认按"选中的窗口"出菜单（精细操作那套）。要测未选中态就显式传
    // selected:false —— 两种菜单来自同一个模板，只是分组不同。
    selected: o.selected !== false,
    wc: o.destroyed ? Object.assign(wc, { isDestroyed: () => true }) : wc,
    sendCommand: c => calls.push(['send', c]),
    restart: () => calls.push(['restart']),
    libs: {
      openLogDir: () => calls.push(['logDir']),
      hideTab: id => calls.push(['hide', id]),
      openProxySettingsFor: id => calls.push(['proxy', id]),
      updatePlatformWeb: p => calls.push(['update', p]),
      refreshTabsOfPlatform: p => calls.push(['refreshAll', p]),
      platformLabel: p => p === 'wa' ? 'WhatsApp' : p
    },
    calls,
    wcRef: wc
  }
}

function labels (tpl) {
  return tpl.filter(i => i.type !== 'separator').map(i => i.label)
}

test('主页菜单：只有全局操作，没有实例操作', () => {
  const tpl = menuTemplate(ctx({ home: true }))
  const l = labels(tpl)
  assert.deepEqual(l, ['个人中心', '检查软件更新', '打开日志目录', '重启软件'])
  assert.ok(!l.some(x => /隐藏/.test(x)), '主页不该有隐藏某一项')
})

test('找不到 tab / view 已销毁时回落成主页菜单（不能抛）', () => {
  assert.deepEqual(labels(menuTemplate(ctx({ noTab: true }))),
    ['个人中心', '检查软件更新', '打开日志目录', '重启软件'])
  assert.deepEqual(labels(menuTemplate(ctx({ destroyed: true }))),
    ['个人中心', '检查软件更新', '打开日志目录', '重启软件'])
})

test('★ 挂起（隐藏）必须是独立菜单项，且不在"关闭"附近', () => {
  const tpl = menuTemplate(ctx())
  const l = labels(tpl)
  // "挂起"就是原来的"隐藏该窗口"：进程保留、登录态不丢。
  // 菜单文案与产品稿对齐后测试跟着改名，但**约束没变** —— 它必须离关闭足够远。
  const hideAt = l.findIndex(x => x === '挂起')
  const closeAt = l.findIndex(x => x === '关闭应用')
  assert.ok(hideAt >= 0, '实例菜单必须有"挂起"')
  assert.equal(hideAt, 0, '挂起放在第一项：它是最常用、也最安全的"收拾窗口"方式')
  assert.ok(closeAt >= 0)
  assert.ok(closeAt - hideAt > 3, '挂起离关闭太近，误点会把收消息的窗口藏掉')
  // 挂起和关闭之间必须有分隔线，视觉上也要分开
  const rawClose = tpl.findIndex(i => i.label === '关闭应用')
  const between = tpl.slice(0, rawClose)
  assert.ok(between.some(i => i.type === 'separator'), '挂起与关闭之间必须有分隔')
})

test('★ 关闭走 closeAsk（渲染层二次确认），不能直接关', () => {
  const h = ctx()
  const tpl = menuTemplate(h)
  const close = tpl.find(i => i.label === '关闭应用')
  close.click()
  assert.deepEqual(h.calls[0], ['send', { action: 'closeAsk', id: 'wa-1' }],
    '主进程直接关会绕过确认')
})

test('挂起点下去是隐藏而不是关闭', () => {
  const h = ctx()
  menuTemplate(h).find(i => i.label === '挂起').click()
  assert.deepEqual(h.calls[0], ['hide', 'wa-1'])
})

test('缩放钳在 0.5 ~ 2，且不出现浮点尾巴', () => {
  let h = ctx({ zoom: 1 })
  let tpl = menuTemplate(h)
  tpl.find(i => i.label === '放大页面').click()
  assert.deepEqual(h.calls[0], ['zoom', 1.1])

  h = ctx({ zoom: 1.9 })
  menuTemplate(h).find(i => i.label === '放大页面').click()
  assert.deepEqual(h.calls[0], ['zoom', 2], '不能超过 2')

  h = ctx({ zoom: 0.5 })
  menuTemplate(h).find(i => i.label === '缩小页面').click()
  assert.deepEqual(h.calls[0], ['zoom', 0.5], '不能低于 0.5')

  // 反复点不能出现 1.3000000000000003
  h = ctx({ zoom: 1 })
  tpl = menuTemplate(h)
  const zoomIn = tpl.find(i => i.label === '放大页面')
  zoomIn.click(); zoomIn.click(); zoomIn.click()
  for (const [, v] of h.calls) {
    assert.equal(String(v).length <= 4, true, '缩放值出现了浮点尾巴：' + v)
  }
})

test('还原缩放回到 1', () => {
  const h = ctx({ zoom: 1.6 })
  menuTemplate(h).find(i => i.label === '还原缩放').click()
  assert.deepEqual(h.calls[0], ['zoom', 1])
})

test('刷新 / 代理 / 检查更新 / 日志目录各自接到正确的能力上', () => {
  const h = ctx()
  const tpl = menuTemplate(h)
  tpl.find(i => i.label === '刷新当前应用').click()
  tpl.find(i => i.label === '代理设置').click()
  tpl.find(i => i.label === '检查应用更新').click()
  tpl.find(i => i.label === '打开日志目录').click()
  assert.deepEqual(h.calls, [
    ['reload'], ['proxy', 'wa-1'], ['update', 'wa'], ['logDir']
  ])
})

test('清理缓存：清完必须忽略缓存重载（否则用户看到的还是旧的）', async () => {
  const h = ctx()
  menuTemplate(h).find(i => i.label === '清理当前应用缓存').click()
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(h.calls, [['clearCache'], ['reloadIgnoringCache']])
})

test('重命名走命令通道，交渲染层弹框', () => {
  const h = ctx()
  menuTemplate(h).find(i => /重命名窗口/.test(i.label)).click()
  assert.deepEqual(h.calls[0], ['send', { action: 'rename', id: 'wa-1' }])
})

test('popup 真的挂到窗口上，并返回成功', () => {
  let popped = null
  const state = { win: { isDestroyed: () => false, webContents: { send: () => {} } }, tabs: [] }
  const api = createTabContextMenu({
    electron: {
      Menu: { buildFromTemplate: tpl => ({ popup: opts => { popped = { tpl, opts } } }) },
      app: {}
    },
    state,
    libs: { openLogDir() {}, hideTab() {}, openProxySettingsFor() {}, updatePlatformWeb() {} }
  })
  const r = api.popupTabContextMenu({ home: true })
  assert.deepEqual(r, { success: true })
  assert.ok(popped)
  assert.equal(popped.opts.window, state.win, '右键菜单必须挂在主窗口上')
})

test('窗口已销毁时 sendCommand 不抛', () => {
  let sent = 0
  const state = { win: { isDestroyed: () => true, webContents: { send: () => sent++ } }, tabs: [] }
  const api = createTabContextMenu({
    electron: { Menu: { buildFromTemplate: () => ({ popup: () => {} }) }, app: {} },
    state,
    libs: { openLogDir() {}, hideTab() {}, openProxySettingsFor() {}, updatePlatformWeb() {} }
  })
  assert.doesNotThrow(() => api.popupTabContextMenu({ home: true }))
  assert.equal(sent, 0)
})

// ---------------------------------------------------------------------------
// 选中 / 未选中两套菜单
// ---------------------------------------------------------------------------

test('★ 未选中菜单：产品稿那 5 项，顺序固定', () => {
  const tpl = menuTemplate(ctx({ selected: false }))
  assert.deepEqual(labels(tpl), [
    '挂起',
    '刷新全部WhatsApp',
    '关闭应用',
    '关闭全部WhatsApp',
    '开发者工具'
  ])
})

test('★ 选中菜单：保留精细操作，同时也有批量项', () => {
  const l = labels(menuTemplate(ctx()))
  for (const need of ['挂起', '刷新全部WhatsApp', '关闭应用', '关闭全部WhatsApp', '开发者工具',
    '重命名窗口…', '上一页', '下一页', '放大页面', '缩小页面', '还原缩放',
    '代理设置', '检查应用更新', '清理当前应用缓存']) {
    assert.ok(l.includes(need), '选中菜单缺少：' + need)
  }
})

test('★ 平台名为空时标题不能退化成"关闭全部"（看不出关的是谁）', () => {
  const h = ctx({ selected: false })
  h.tab.platform = ''
  h.libs.platformLabel = () => ''
  const l = labels(menuTemplate(h))
  assert.ok(!l.includes('关闭全部'), '不能出现没有范围说明的"关闭全部"')
  assert.ok(l.includes('关闭全部该平台'))
})

test('★「关闭全部同平台」必须走渲染层确认，不能在主进程直接关', () => {
  const h = ctx({ selected: false })
  menuTemplate(h).find(i => i.label === '关闭全部WhatsApp').click()
  assert.deepEqual(h.calls[0], ['send', { action: 'closePlatformAsk', id: 'wa-1', platform: 'wa' }])
})

test('「刷新全部同平台」直接在主进程执行（没有破坏性，不需要确认）', () => {
  const h = ctx({ selected: false })
  menuTemplate(h).find(i => i.label === '刷新全部WhatsApp').click()
  assert.deepEqual(h.calls[0], ['refreshAll', 'wa'])
})

test('上一页 / 下一页走命令通道，与 app:contextAction 的 back/forward 对齐', () => {
  const h = ctx()
  const tpl = menuTemplate(h)
  tpl.find(i => i.label === '上一页').click()
  tpl.find(i => i.label === '下一页').click()
  assert.deepEqual(h.calls, [
    ['send', { action: 'back', id: 'wa-1' }],
    ['send', { action: 'forward', id: 'wa-1' }]
  ])
})

test('开发者工具：没开就开（detach），开着就关', () => {
  const h = ctx()
  let opened = false
  h.wcRef.isDevToolsOpened = () => opened
  h.wcRef.openDevTools = opts => { opened = true; h.calls.push(['openDevTools', opts]) }
  h.wcRef.closeDevTools = () => { opened = false; h.calls.push(['closeDevTools']) }

  menuTemplate(h).find(i => i.label === '开发者工具').click()
  menuTemplate(h).find(i => i.label === '开发者工具').click()
  assert.deepEqual(h.calls, [
    ['openDevTools', { mode: 'detach' }],
    ['closeDevTools']
  ])
})

test('★ popup：只有 id 命中的那一个才是 selected，别的窗口右键走未选中菜单', () => {
  const seen = []
  const tab = id => ({ id, platform: 'wa', view: { webContents: {
    isDestroyed: () => false,
    getZoomFactor: () => 1,
    setZoomFactor() {},
    reload() {}
  } } })
  const state = {
    win: { isDestroyed: () => false, webContents: { send: () => {} } },
    tabs: [tab('wa-1'), tab('wa-2')],
    activeId: 'wa-1'
  }
  const api = createTabContextMenu({
    electron: { Menu: { buildFromTemplate: tpl => ({ popup: () => seen.push(labels(tpl)) }) }, app: {} },
    state,
    libs: {
      openLogDir() {}, hideTab() {}, openProxySettingsFor() {}, updatePlatformWeb() {},
      refreshTabsOfPlatform() {}, platformLabel: () => 'WhatsApp'
    }
  })
  api.popupTabContextMenu({ id: 'wa-1' })
  api.popupTabContextMenu({ id: 'wa-2' })
  assert.ok(seen[0].includes('重命名窗口…'), '激活窗口应拿到完整菜单')
  assert.deepEqual(seen[1], ['挂起', '刷新全部WhatsApp', '关闭应用', '关闭全部WhatsApp', '开发者工具'],
    '非激活窗口应拿到精简菜单')
})
