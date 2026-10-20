'use strict'

/**
 * 配置 / 线路 IPC 的单元测试。
 *
 * 这里不启动 Electron：用一个假的 registrar 收集 handler，然后直接调。
 * 重点验三件事：
 *   1. 写操作真的**写回**了 state（不是改副本）
 *   2. 非法输入被拒（不安全的线路地址）
 *   3. 来源校验由注册器统一负责（见 registrar.test.js）
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { registerConfigIpc } = require('../desktop/src/ipc/config')

function harness (overrides) {
  const handlers = {}
  const reg = {
    handle: (ch, fn) => { handlers[ch] = fn },
    handleUnsafe: (ch, fn) => { handlers[ch] = fn }
  }
  const saved = []
  const state = Object.assign({
    apiBase: 'https://a.example.com',
    theme: 'light',
    tabLayout: 'top',
    lineId: 'overseas',
    backgroundRunning: true,
    lines: [
      { id: 'overseas', url: 'https://a.example.com' },
      { id: 'hk', url: 'https://b.example.com' }
    ],
    proxyPresets: [{ id: 'p1' }]
  }, overrides || {})

  const calls = []
  registerConfigIpc({
    reg,
    state,
    env: {
      DEFAULT_API: 'https://a.example.com',
      EXTERNAL_HOSTS: ['example.com'],
      // 简化版：只允许 https
      safeApiUrl: url => (String(url).startsWith('https://') ? String(url) : ''),
      fetchFrom: async (base, p) => { calls.push(['fetch', base, p]); return { ok: 1 } },
      isAllowedExternalUrl: (href, hosts) => hosts.some(h => String(href).includes(h))
    },
    actions: Object.assign({
      saveConfig: () => saved.push({ ...state }),
      setBackgroundRunning: v => { state.backgroundRunning = v },
      currentLine: () => state.lines.find(l => l.id === state.lineId),
      refreshLines: async () => { calls.push(['refresh']); return { success: true } },
      applyLine: id => {
        const line = state.lines.find(l => l.id === id)
        state.lineId = line.id
        state.apiBase = line.url
        return line
      },
      pingLine: async id => ({ id, ok: true }),
      pingAllLines: async () => ({ all: true }),
      openExternal: async url => { calls.push(['open', url]) },
      detectProxyNode: async p => ({ detected: p }),
      // 布局切换要重排原生视图；测试里换成计数桩
      relayoutViews: () => ((global.__relayout = (global.__relayout || 0) + 1))
    })
  })
  return { handlers, state, saved, calls }
}

test('config:get 返回全部字段，含当前线路 id', () => {
  const { handlers } = harness()
  assert.deepEqual(handlers['config:get'](), {
    apiBase: 'https://a.example.com',
    theme: 'light',
    tabLayout: 'top',
    backgroundRunning: true,
    lineId: 'overseas',
    lines: [{ id: 'overseas', url: 'https://a.example.com' }, { id: 'hk', url: 'https://b.example.com' }]
  })
})

test('config:setTheme 必须真的写回 state 并落盘', () => {
  const { handlers, state, saved } = harness()
  const r = handlers['config:setTheme']({}, 'dark')
  assert.equal(r.success, true)
  assert.equal(r.theme, 'dark')
  assert.equal(state.theme, 'dark', 'setter 没接上就是界面闪回')
  assert.equal(saved.length, 1, '必须落盘，否则重启后回到亮色')
})

test('config:setTheme 只认 dark / light，其它值一律亮色', () => {
  const { handlers, state } = harness()
  handlers['config:setTheme']({}, 'purple')
  assert.equal(state.theme, 'light')
  handlers['config:setTheme']({})
  assert.equal(state.theme, 'light')
})

test('config:setBackgroundRunning：只有明确的 false 才关闭', () => {
  const { handlers, state } = harness()
  handlers['config:setBackgroundRunning']({}, false)
  assert.equal(state.backgroundRunning, false)
  // undefined / null / 0 / '' 都不该把关掉 —— 与 loadConfig 的 !== false 一致
  for (const v of [undefined, null, 0, '']) {
    handlers['config:setBackgroundRunning']({}, v)
    assert.equal(state.backgroundRunning, true, '传 ' + String(v) + ' 时不应关闭')
  }
})

test('config:setApiBase 拒绝不符合安全策略的地址', () => {
  const { handlers, state } = harness()
  const r = handlers['config:setApiBase']({}, 'javascript:alert(1)')
  assert.equal(r.success, false)
  assert.match(r.msg, /安全策略/)
  assert.equal(state.apiBase, 'https://a.example.com', '被拒时不能改动现有配置')
})

test('config:setApiBase 命中已有线路时同步切换 lineId', () => {
  const { handlers, state } = harness()
  const r = handlers['config:setApiBase']({}, 'https://b.example.com')
  assert.equal(r.apiBase, 'https://b.example.com')
  assert.equal(r.lineId, 'hk')
  assert.equal(state.lineId, 'hk')
  assert.equal(state.apiBase, 'https://b.example.com')
})

test('config:setApiBase 对未知线路只换地址，不动 lineId', () => {
  const { handlers, state } = harness()
  const r = handlers['config:setApiBase']({}, 'https://new.example.com')
  assert.equal(r.apiBase, 'https://new.example.com')
  assert.equal(r.lineId, 'overseas', '没匹配到就不应乱改线路')
  assert.equal(state.lineId, 'overseas')
})

test('lines:select 同时更新 lineId 与 apiBase', () => {
  const { handlers, state } = harness()
  const r = handlers['lines:select']({}, 'hk')
  assert.equal(r.success, true)
  assert.equal(r.lineId, 'hk')
  assert.equal(r.apiBase, 'https://b.example.com')
  assert.equal(state.lineId, 'hk')
})

test('site:info 带上架构参数（否则 Apple 芯片会下到 Intel 包）', async () => {
  const { handlers, calls } = harness()
  await handlers['site:info']({})
  const [, , p] = calls.find(c => c[0] === 'fetch')
  assert.match(p, /^\/site\/info\?arch=/)
  assert.ok(p.includes(encodeURIComponent(process.arch)))
})

test('site:info 网络出错时返回空对象而不是抛给渲染层', async () => {
  const handlers = {}
  registerConfigIpc({
    reg: { handle: (ch, fn) => { handlers[ch] = fn }, handleUnsafe: (ch, fn) => { handlers[ch] = fn } },
    state: { apiBase: 'https://a.example.com', lines: [], lineId: 'x', proxyPresets: [] },
    env: {
      DEFAULT_API: '', EXTERNAL_HOSTS: [], safeApiUrl: v => v,
      fetchFrom: async () => { throw new Error('boom') },
      isAllowedExternalUrl: () => true
    },
    actions: { currentLine: () => ({ id: 'x' }) }
  })
  assert.deepEqual(await handlers['site:info']({}), {})
})

test('shell:open 拦截不在信任名单里的链接', async () => {
  const { handlers, calls } = harness()
  const bad = await handlers['shell:open']({}, 'https://evil.com/x')
  assert.equal(bad.success, false)
  assert.equal(calls.filter(c => c[0] === 'open').length, 0, '恶意链接绝不能调 openExternal')

  const ok = await handlers['shell:open']({}, 'https://example.com/help')
  assert.equal(ok.success, true)
  assert.equal(calls.find(c => c[0] === 'open')[1], 'https://example.com/help')
})

test('app:proxyPresets / proxy:detect 直接转发', async () => {
  const { handlers } = harness()
  assert.deepEqual(handlers['app:proxyPresets'](), { success: true, rows: [{ id: 'p1' }] })
  assert.deepEqual(await handlers['proxy:detect']({}, { node: 'x' }), { detected: { node: 'x' } })
})

// ---------------------------------------------------------------------------
// 标签栏布局
// ---------------------------------------------------------------------------

test('config:setTabLayout 只认 top / side，其它值一律回落 top', () => {
  const { handlers, state, saved } = harness()
  assert.deepEqual(handlers['config:setTabLayout']({}, 'side'),
    { success: true, tabLayout: 'side' })
  assert.equal(state.tabLayout, 'side')
  assert.equal(saved.length, 1, '必须落盘，否则重启后回到顶部')
  // 拼错的/被篡改的值不能让界面处在"既不是顶部也不是侧面"的状态
  assert.equal(handlers['config:setTabLayout']({}, 'sidebar').tabLayout, 'top')
  assert.equal(handlers['config:setTabLayout']({}, undefined).tabLayout, 'top')
})

test('★ 切换布局必须让主进程重排原生视图（否则标签栏被实例视图盖住）', () => {
  const { handlers } = harness()
  global.__relayout = 0
  handlers['config:setTabLayout']({}, 'side')
  assert.equal(global.__relayout, 1)
})

test('★ 布局没变化时不重排：每次重排都会让原生视图闪一下', () => {
  const { handlers } = harness()
  global.__relayout = 0
  handlers['config:setTabLayout']({}, 'top')   // 默认就是 top
  assert.equal(global.__relayout, 0)
  handlers['config:setTabLayout']({}, 'top')
  assert.equal(global.__relayout, 0)
})
