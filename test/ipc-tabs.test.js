'use strict'

/**
 * 标签页 IPC 的单元测试。
 *
 * 这一组最容易踩的三条线：
 *   1. 关闭必须二次确认 —— 直接关 = 用户误点一下号就没了
 *   2. 隐藏不是关闭 —— 从 tabs 里删掉就再也找不回来
 *   3. 改名写进预设模板时绝不能带代理 —— 否则下个新实例静默继承
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { registerTabsIpc } = require('../desktop/src/ipc/tabs')

function fakeWc (opts) {
  const o = opts || {}
  const calls = []
  return {
    calls,
    isDestroyed: () => !!o.destroyed,
    reload: () => calls.push('reload'),
    reloadIgnoringCache: () => calls.push('reloadIgnoringCache'),
    getZoomFactor: () => o.zoom === undefined ? 1 : o.zoom,
    setZoomFactor: z => calls.push(['zoom', z]),
    session: { clearCache: async () => calls.push('clearCache') },
    canGoBack: () => !!o.canBack,
    canGoForward: () => !!o.canForward,
    goBack: () => calls.push('back'),
    goForward: () => calls.push('forward'),
    navigationHistory: o.history
  }
}

function harness (opts) {
  const o = opts || {}
  const handlers = {}
  const unsafe = new Set()
  const state = {
    tabs: o.tabs || [],
    activeId: o.activeId === undefined ? 't1' : o.activeId,
    overlayOpen: false
  }
  const calls = []
  const presets = o.presets || {}

  registerTabsIpc({
    reg: {
      handle: (ch, fn) => { handlers[ch] = fn },
      handleUnsafe: (ch, fn) => { handlers[ch] = fn; unsafe.add(ch) }
    },
    state,
    actions: {
      tabPayload: () => ({ rows: state.tabs.map(t => t.id), activeId: state.activeId }),
      openPlatform: p => { calls.push(['open', p]); return { success: true } },
      closeTab: id => { calls.push(['close', id]); return { success: true } },
      switchTab: id => { calls.push(['switch', id]); return { success: true } },
      hideTab: id => { calls.push(['hide', id]); return { success: true } },
      showHiddenTab: id => { calls.push(['show', id]); return { success: true } },
      popupTabContextMenu: p => { calls.push(['menu', p]); return { success: true } },
      goHome: () => { calls.push(['home']); return { success: true } },
      readPresets: () => JSON.parse(JSON.stringify(presets)),
      writePresets: all => { calls.push(['writePresets', all]); Object.assign(presets, all) },
      sendTabs: () => calls.push('sendTabs'),
      saveOpenApps: () => calls.push('saveOpenApps'),
      updateTabSettings: (id, s) => { calls.push(['updateSettings', id, s]); return { success: true } },
      layoutViews: () => calls.push('layout'),
      relaunchAndExit: () => calls.push('relaunch')
    },
    env: {
      sealSettings: s => ({ sealed: s }),
      stripProxyFields: s => {
        const out = {}
        for (const k of Object.keys(s)) if (!/^proxy/i.test(k)) out[k] = s[k]
        return out
      },
      proxySettingsOf: s => {
        const out = {}
        for (const k of Object.keys(s)) if (/^proxy/i.test(k)) out[k] = s[k]
        return out
      }
    }
  })
  return { handlers, state, calls, presets, unsafe }
}

test('全部频道都必须是受保护的 reg.handle（这组只给主界面用）', () => {
  const { unsafe } = harness()
  assert.equal(unsafe.size, 0, '标签页操作不该允许客页调用：' + [...unsafe].join(','))
})

test('★ app:contextAction 的 close 必须拦下并要二次确认', async () => {
  const wc = fakeWc()
  const { handlers, calls } = harness({ tabs: [{ id: 't1', view: { webContents: wc } }] })
  const r = await handlers['app:contextAction']({}, { id: 't1', action: 'close' })
  assert.equal(r.success, false)
  assert.equal(r.needConfirm, true)
  assert.equal(calls.filter(c => c[0] === 'close').length, 0, '绝不能在主进程直接关')
})

test('app:contextAction 目标不存在时返回应用不存在', async () => {
  const { handlers } = harness({ tabs: [] })
  const r = await handlers['app:contextAction']({}, { id: 'nope', action: 'reload' })
  assert.equal(r.success, false)
  assert.match(r.msg, /不存在/)
})

test('app:contextAction 缺省 id 时回落到当前激活窗口', async () => {
  const wc = fakeWc()
  const { handlers } = harness({
    tabs: [{ id: 't1', view: { webContents: wc } }],
    activeId: 't1'
  })
  const r = await handlers['app:contextAction']({}, { action: 'reload' })
  assert.equal(r.success, true)
  assert.deepEqual(wc.calls, ['reload'])
})

test('缩放夹在 50% ~ 200% 之间', async () => {
  const wc = fakeWc({ zoom: 2 })
  const { handlers } = harness({ tabs: [{ id: 't1', view: { webContents: wc } }] })
  let r = await handlers['app:contextAction']({}, { action: 'zoomIn' })
  assert.equal(r.msg, '200%', '不能超过 200%')
  r = await handlers['app:contextAction']({}, { action: 'zoomReset' })
  assert.equal(r.msg, '100%')
})

test('前进/后退优先用 navigationHistory，没有则退回旧 API', async () => {
  // 新 API
  const history = {
    canGoBack: () => true, goBack: () => history._went = 'back',
    canGoForward: () => false
  }
  const wcNew = fakeWc({ history })
  let h = harness({ tabs: [{ id: 't1', view: { webContents: wcNew } }] })
  assert.equal((await h.handlers['app:contextAction']({}, { action: 'back' })).success, true)
  assert.equal(history._went, 'back')
  assert.equal((await h.handlers['app:contextAction']({}, { action: 'forward' })).success, false)

  // 旧 API
  const wcOld = fakeWc({ canBack: true })
  h = harness({ tabs: [{ id: 't1', view: { webContents: wcOld } }] })
  assert.equal((await h.handlers['app:contextAction']({}, { action: 'back' })).success, true)
  assert.ok(wcOld.calls.includes('back'))
})

test('未知 action 不报错，返回不支持', async () => {
  const { handlers } = harness({ tabs: [{ id: 't1', view: { webContents: fakeWc() } }] })
  const r = await handlers['app:contextAction']({}, { id: 't1', action: 'launchMissiles' })
  assert.equal(r.success, false)
  assert.match(r.msg, /不支持/)
})

test('★ app:reorder 不接受整表覆盖，只做单条移动', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const { handlers, calls } = harness({ tabs })
  // 模拟渲染层偷偷传了 rows
  handlers['app:reorder']({}, { id: 'c', targetId: 'a', before: true, rows: [{ id: 'x' }] })
  assert.deepEqual(tabs.map(t => t.id), ['c', 'a', 'b'], '只把 c 挪到 a 前，多余字段忽略')
  assert.ok(calls.includes('sendTabs'), '改完必须通知渲染层')
  assert.ok(calls.includes('saveOpenApps'), '改完必须落盘')
})

test('app:reorder 以 home 为基准时挪到最前/最后', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const { handlers } = harness({ tabs })
  handlers['app:reorder']({}, { id: 'b', targetId: 'home', before: true })
  assert.deepEqual(tabs.map(t => t.id), ['b', 'a', 'c'])
  handlers['app:reorder']({}, { id: 'b', targetId: 'home', before: false })
  assert.deepEqual(tabs.map(t => t.id), ['a', 'c', 'b'])
})

test('app:reorder 位置没变时明确返回失败（不静默）', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }]
  const { handlers } = harness({ tabs })
  const r = handlers['app:reorder']({}, { id: 'a', targetId: 'a' })
  assert.equal(r.success, false)
  assert.match(r.msg, /未变化/)
})

test('app:reorder 目标不存在时不动数组', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }]
  const { handlers, calls } = harness({ tabs })
  const r = handlers['app:reorder']({}, { id: 'a', targetId: 'zzz' })
  assert.equal(r.success, false)
  assert.deepEqual(tabs.map(t => t.id), ['a', 'b'])
  assert.ok(!calls.includes('saveOpenApps'), '失败的排序不该落盘')
})

test('★ app:rename 写预设模板时必须摘掉代理字段', () => {
  const tabs = [{ id: 't1', platform: 'wa', name: '旧名', settings: { proxyHost: '1.2.3.4', proxyPass: 'secret', lang: 'zh' } }]
  const { handlers, presets } = harness({ tabs })
  const r = handlers['app:rename']({}, { id: 't1', name: '新名' })
  assert.equal(r.success, true)
  assert.equal(tabs[0].name, '新名')
  const tpl = presets.wa
  assert.equal(tpl.name, '新名')
  assert.equal(tpl.settings.sealed.proxyHost, undefined, '模板里绝不能再带代理主机')
  assert.equal(tpl.settings.sealed.proxyPass, undefined, '模板里绝不能带代理密码')
  assert.equal(tpl.settings.sealed.lang, 'zh', '非代理设置要保留')
})

test('app:rename 名称不能为空 / 窗口必须存在', () => {
  const { handlers } = harness({ tabs: [{ id: 't1', platform: 'wa', settings: {} }] })
  assert.equal(handlers['app:rename']({}, { id: 't1', name: '   ' }).success, false)
  assert.equal(handlers['app:rename']({}, { id: 'zz', name: 'x' }).success, false)
})

test('app:hide 缺省 id 时隐藏当前激活窗口（垃圾篓兜底语义）', () => {
  const { handlers, calls } = harness({ tabs: [{ id: 't1' }, { id: 't2' }], activeId: 't2' })
  handlers['app:hide']({}, '')
  assert.deepEqual(calls.find(c => c[0] === 'hide'), ['hide', 't2'])
})

test('app:reloadActive / clearActiveCache 在没有激活窗口时给明确提示', async () => {
  const { handlers } = harness({ tabs: [], activeId: '' })
  assert.equal(handlers['app:reloadActive']({}).success, false)
  assert.equal((await handlers['app:clearActiveCache']({})).success, false)
})

test('app:proxySettings 只回传代理字段（不抖整份 settings）', () => {
  const settings = { proxyHost: 'h', proxyPass: 'p', lang: 'zh', server: 'x' }
  const { handlers } = harness({ tabs: [{ id: 't1', settings }] })
  const r = handlers['app:proxySettings']({}, { id: 't1' })
  assert.equal(r.success, true)
  assert.deepEqual(r.data, { proxyHost: 'h', proxyPass: 'p' })
  assert.equal(r.data.lang, undefined, '非代理字段不能给渲染层')
})

test('app:restart 延迟重启，让本次 IPC 先回执', () => {
  const { handlers, calls } = harness()
  const r = handlers['app:restart']({})
  assert.equal(r.success, true)
  assert.equal(calls.filter(c => c === 'relaunch').length, 0, '必须延迟，否则渲染层等不到回执')
})

test('app:overlay 改状态并重排视图', () => {
  const { handlers, state, calls } = harness()
  handlers['app:overlay']({}, true)
  assert.equal(state.overlayOpen, true)
  assert.ok(calls.includes('layout'))
  handlers['app:overlay']({}, 0)
  assert.equal(state.overlayOpen, false)
})

test('app:tabs / open / close / switch / home 直接转发', () => {
  const { handlers, calls } = harness({ tabs: [{ id: 't1' }] })
  assert.deepEqual(handlers['app:tabs']({}).rows, ['t1'])
  handlers['app:open']({}, { platform: 'wa' })
  handlers['app:close']({}, 't1')
  handlers['app:switch']({}, 't1')
  handlers['app:home']({})
  assert.deepEqual(calls.find(c => c[0] === 'open'), ['open', { platform: 'wa' }])
  assert.deepEqual(calls.find(c => c[0] === 'close'), ['close', 't1'])
  assert.deepEqual(calls.find(c => c[0] === 'switch'), ['switch', 't1'])
  assert.ok(calls.some(c => c[0] === 'home'))
})
