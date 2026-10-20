'use strict'

/**
 * 打开实例的顺序约束。
 *
 * 这个函数最怕的不是逻辑错，是**顺序错**：
 *   - 预算判断放到建视图之后 → 内存吃满时仍然先建了 Chromium 对象，
 *     用户看到的就是"点了就卡死"
 *   - sendTabs / saveOpenApps 放到 push 之前 → 界面和磁盘都对不上
 *   - 地址校验放到建视图之后 → 白开一个进程
 * 所以断言里大量检查"谁先谁后"。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { createOpenPlatform, memorySuffix } = require('../desktop/src/window/open-platform')

function harness (opts) {
  const o = opts || {}
  const order = []
  const state = {
    tabs: o.tabs || [],
    usedCount: o.usedCount || {},
    nextTab: o.nextTab === undefined ? 1 : o.nextTab,
    activeId: '',
    showHome: true
  }
  const logged = []
  const notices = []

  const fakeView = { webContents: { setAudioMuted: v => order.push('mute:' + v), on: () => {} } }
  const api = createOpenPlatform({
    state,
    libs: {
      tabBudget: {
        canOpenAnotherTab: args => {
          order.push(['budget', args.tabCount])
          return o.budget || { ok: true }
        },
        openHandleCount: () => 10,
        handleLimit: () => 1000
      },
      effectiveMaxTabs: () => 0,
      makePartition: (id, i) => 'persist:' + id + ':' + i,
      normalizeTabSettings: s => Object.assign({}, s),
      safePlatformHomeUrl: () => (o.badUrl ? '' : 'https://web.whatsapp.com/'),
      createWebView: (...args) => { order.push(['createView', args[0]]); return fakeView },
      accountSlug: () => 'acc',
      bindTabLoading: () => order.push('bindLoading'),
      watchdogBridge: () => order.push('watchdog'),
      startTabLoad: tab => order.push(['load', tab.id]),
      layoutViews: () => order.push('layout'),
      sendTabs: () => order.push('sendTabs'),
      saveOpenApps: () => order.push('saveOpenApps'),
      showResourceNotice: (reason, code) => notices.push([reason, code]),
      logWarn: (ch, msg) => logged.push([ch, msg])
    },
    env: {
      platforms: o.platforms || [{ id: 'wa', name: 'WhatsApp' }, { id: 'whatsapp-pro', name: 'WA Pro' }]
    }
  })
  return { api, state, order, logged, notices }
}

test('不支持的平台直接拒绝，不建视图', () => {
  const { api, order } = harness()
  const r = api.openPlatform({ platformId: 'nope' })
  assert.equal(r.success, false)
  assert.match(r.msg, /不支持/)
  assert.equal(order.length, 0)
})

test('★ 资源预算必须在创建视图之前判断', () => {
  const { api, order } = harness({
    budget: { ok: false, code: 'MEMORY_HIGH', reason: '内存不足', used: 10, limit: 1000 }
  })
  const r = api.openPlatform({ platformId: 'wa' })
  assert.equal(r.success, false)
  assert.equal(r.code, 'MEMORY_HIGH')
  const budgetAt = order.findIndex(o => Array.isArray(o) && o[0] === 'budget')
  const viewAt = order.findIndex(o => Array.isArray(o) && o[0] === 'createView')
  assert.ok(budgetAt >= 0, '必须问过预算')
  assert.equal(viewAt, -1, '预算不足时绝不能建 Chromium 对象 —— 那正是"点了就卡死"')
})

test('预算拒绝时必须弹原生提示（渲染层会被视图盖住）', () => {
  const { api, notices } = harness({
    budget: { ok: false, code: 'MEMORY_HIGH', reason: '内存不足，请先关掉一些窗口', used: 10, limit: 1000 }
  })
  api.openPlatform({ platformId: 'wa' })
  assert.equal(notices.length, 1)
  assert.equal(notices[0][1], 'MEMORY_HIGH')
})

test('预算拒绝要落日志，带内存与句柄水位', () => {
  const { api, logged } = harness({
    budget: {
      ok: false, code: 'MEMORY_HIGH', reason: '内存不足',
      used: 10, limit: 1000,
      memory: { used: 8 * 1048576, total: 16 * 1048576, ratio: 0.5 }
    }
  })
  api.openPlatform({ platformId: 'wa' })
  assert.equal(logged.length, 1)
  assert.match(logged[0][1], /MEMORY_HIGH/)
  assert.match(logged[0][1], /8\/16MB/)
  assert.match(logged[0][1], /已用 50%/)
})

test('★ 地址不合规时不能建视图', () => {
  const { api, order } = harness({ badUrl: true })
  const r = api.openPlatform({ platformId: 'wa' })
  assert.equal(r.success, false)
  assert.match(r.msg, /安全策略/)
  assert.equal(order.filter(o => Array.isArray(o) && o[0] === 'createView').length, 0)
})

test('★ 顺序：建视图 → 入列 → 看门狗 → 加载 → 切过去 → 通知 → 落盘', () => {
  const { api, order, state } = harness()
  const r = api.openPlatform({ platformId: 'wa' })
  assert.equal(r.success, true)
  const seq = order.filter(o => typeof o === 'string' ||
    (Array.isArray(o) && ['createView', 'load'].includes(o[0])))
  assert.deepEqual(seq, [
    ['createView', 'persist:wa:1'],
    'bindLoading',
    'watchdog',
    ['load', 'wa-1'],
    'layout',
    'sendTabs',
    'saveOpenApps'
  ])
  assert.equal(state.tabs.length, 1, 'push 必须发生在通知之前')
})

test('新开的实例变成当前激活，并离开主页', () => {
  const { api, state } = harness()
  const r = api.openPlatform({ platformId: 'wa' })
  assert.equal(state.activeId, r.id)
  assert.equal(state.showHome, false)
})

test('id 与序号按平台独立计数', () => {
  const { api, state } = harness({ usedCount: { wa: 2 }, nextTab: 5 })
  const r = api.openPlatform({ platformId: 'wa' })
  assert.equal(r.id, 'wa-5')
  assert.equal(state.usedCount.wa, 3)
  assert.equal(state.nextTab, 6, 'nextTab 必须真的递增，否则下一个 id 会撞')
})

test('★ whatsapp-pro 默认开启防撤回，但不覆盖用户显式选择', () => {
  let h = harness()
  h.api.openPlatform({ platformId: 'whatsapp-pro' })
  assert.equal(h.state.tabs[0].settings.antiRevoke, true, '这是用户选 Pro 的理由')

  h = harness()
  h.api.openPlatform({ platformId: 'whatsapp-pro', settings: { antiRevoke: false } })
  assert.equal(h.state.tabs[0].settings.antiRevoke, false, '用户关掉了就别擅自打开')
})

test('普通平台不会自动开防撤回', () => {
  const h = harness()
  h.api.openPlatform({ platformId: 'wa' })
  assert.equal(h.state.tabs[0].settings.antiRevoke, undefined)
})

test('muteAll 生效、自定义名称生效', () => {
  const h = harness()
  h.api.openPlatform({ platformId: 'wa', name: '  客服号  ', settings: { muteAll: true } })
  assert.equal(h.state.tabs[0].name, '客服号', '名称要 trim')
  assert.ok(h.order.includes('mute:true'))
})

test('名称为空时回落到平台名', () => {
  const h = harness()
  h.api.openPlatform({ platformId: 'wa', name: '   ' })
  assert.equal(h.state.tabs[0].name, 'WhatsApp')
})

test('disableAutoLoad 时要挂 did-fail-load 停止重试', () => {
  const listeners = []
  const state = { tabs: [], usedCount: {}, nextTab: 1, activeId: '', showHome: true }
  const fakeView = {
    webContents: {
      setAudioMuted: () => {},
      on: (ev) => listeners.push(ev)
    }
  }
  const api = createOpenPlatform({
    state,
    libs: {
      tabBudget: { canOpenAnotherTab: () => ({ ok: true }), openHandleCount: () => 0, handleLimit: () => 1 },
      effectiveMaxTabs: () => 0,
      makePartition: () => 'p',
      normalizeTabSettings: s => Object.assign({}, s),
      safePlatformHomeUrl: () => 'https://x/',
      createWebView: () => fakeView,
      accountSlug: () => 'a',
      bindTabLoading: () => {},
      watchdogBridge: () => {},
      startTabLoad: () => {},
      layoutViews: () => {},
      sendTabs: () => {},
      saveOpenApps: () => {},
      showResourceNotice: () => {},
      logWarn: () => {}
    },
    env: { platforms: [{ id: 'wa', name: 'WA' }] }
  })
  api.openPlatform({ platformId: 'wa', settings: { disableAutoLoad: true } })
  assert.ok(listeners.includes('did-fail-load'), '关闭自动加载时必须挂监听，别再重试烧流量')

  listeners.length = 0
  state.tabs.length = 0
  api.openPlatform({ platformId: 'wa', settings: {} })
  assert.ok(!listeners.includes('did-fail-load'), '没关自动加载时不该多挂一个监听')
})

test('memorySuffix：没有数据时返回空串（不输出 0/0MB 这种噪音）', () => {
  assert.equal(memorySuffix(null), '')
  assert.equal(memorySuffix({}), '')
  assert.equal(memorySuffix({ total: 0 }), '')
  assert.match(memorySuffix({ used: 1048576, total: 2097152, ratio: 0.5 }), /1\/2MB.*50%/)
})
