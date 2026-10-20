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
    wc: o.destroyed ? Object.assign(wc, { isDestroyed: () => true }) : wc,
    sendCommand: c => calls.push(['send', c]),
    restart: () => calls.push(['restart']),
    libs: {
      openLogDir: () => calls.push(['logDir']),
      hideTab: id => calls.push(['hide', id]),
      openProxySettingsFor: id => calls.push(['proxy', id]),
      updatePlatformWeb: p => calls.push(['update', p])
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

test('★ 隐藏必须是独立菜单项，且不在"关闭"附近', () => {
  const tpl = menuTemplate(ctx())
  const l = labels(tpl)
  const hideAt = l.findIndex(x => /隐藏该窗口/.test(x))
  const closeAt = l.findIndex(x => x === '关闭应用')
  assert.ok(hideAt >= 0, '实例菜单必须有"隐藏该窗口"')
  assert.ok(closeAt >= 0)
  assert.ok(closeAt - hideAt > 3, '隐藏离关闭太近，误点会把收消息的窗口藏掉')
  // 隐藏和关闭之间必须有分隔线，视觉上也要分开
  const rawHide = tpl.findIndex(i => /隐藏该窗口/.test(i.label || ''))
  const rawClose = tpl.findIndex(i => i.label === '关闭应用')
  const between = tpl.slice(rawHide + 1, rawClose)
  assert.ok(between.some(i => i.type === 'separator'), '隐藏与关闭之间必须有分隔')
})

test('★ 关闭走 closeAsk（渲染层二次确认），不能直接关', () => {
  const h = ctx()
  const tpl = menuTemplate(h)
  const close = tpl.find(i => i.label === '关闭应用')
  close.click()
  assert.deepEqual(h.calls[0], ['send', { action: 'closeAsk', id: 'wa-1' }],
    '主进程直接关会绕过确认')
})

test('隐藏点下去是隐藏而不是关闭', () => {
  const h = ctx()
  menuTemplate(h).find(i => /隐藏该窗口/.test(i.label)).click()
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
