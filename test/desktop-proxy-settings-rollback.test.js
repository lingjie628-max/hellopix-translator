'use strict'

/**
 * 改代理失败时必须回滚设置，保持"内存 / 磁盘 / 实际生效"三者一致。
 *
 * ## 真实的失效链
 *
 * `updateTabSettings` 的顺序原来是：
 *
 *     tab.settings = 新设置            // 内存改了
 *     sendTabs(); saveOpenApps()       // 落盘了
 *     if (proxyChanged) await applyTabProxy(...)   // ← 这里可能抛
 *
 * `applyTabProxy` 抛错（带认证 SOCKS5 的中继起不来、SSH 隧道起不来…）时，
 * 前两行的结果**全部保留**。于是：
 *
 *   tab.settings（内存 + 磁盘） = 新代理 B
 *   session 上的实际规则        = 旧代理 A
 *
 * 用户界面上"保存成功"，实际上出口没换。对做多账号运营的人来说，
 * 这是"以为换了 IP、其实一直在用同一个出口" —— 关联风险，不是体验问题。
 *
 * 正确口径是把设置退回改动前并重新落盘，让三者始终一致：
 * 要么整体生效，要么整体当没发生过。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8')

function extractAsyncFunction (name) {
  const marker = 'async function ' + name + '('
  const start = mainSource.indexOf(marker)
  assert.ok(start >= 0, 'main.js 里找不到 async function ' + name)
  const braceStart = mainSource.indexOf('{', start)
  let depth = 0
  for (let i = braceStart; i < mainSource.length; i++) {
    if (mainSource[i] === '{') depth++
    else if (mainSource[i] === '}') {
      depth--
      if (depth === 0) return mainSource.slice(start, i + 1)
    }
  }
  throw new Error('花括号没配平：' + name)
}

/**
 * 在隔离上下文里跑 updateTabSettings。
 *
 * @param {object} o
 * @param {boolean} o.proxyFails  applyTabProxy 是否抛错
 */
async function runUpdate (o) {
  const events = []
  const tab = {
    id: 'tab-1',
    settings: { proxyType: 'none', proxyHost: '', proxyPort: '', proxyUser: '', showTransBar: true },
    view: null
  }
  const saved = []

  const ctx = {
    tabs: [tab],
    showHome: true,
    // normalizeTabSettings：只关心代理字段，其余原样
    normalizeTabSettings: (s) => Object.assign({}, s),
    proxyFieldsChanged: (a, b) => (a.proxyType !== b.proxyType) || (a.proxyHost !== b.proxyHost),
    applyTabProxy: () => o.proxyFails
      ? Promise.reject(new Error('本地 SOCKS5 中继未能启动'))
      : Promise.resolve(),
    tabProxyDeps: () => ({}),
    reloadTabContents: () => { events.push('reload') },
    sendTabs: () => { events.push('sendTabs') },
    saveOpenApps: () => { saved.push(JSON.parse(JSON.stringify(tab.settings))) },
    animateChromeTo: () => { events.push('animate') },
    layoutViews: () => { events.push('layout') },
    chromeOffset: () => 0,
    tabPrefs: () => ({}),
    clientLog: {
      error: (ch, msg) => { events.push('log:' + ch) },
      warn: () => {}
    },
    Object: Object,
    String: String,
    Error: Error,
    Promise: Promise
  }
  vm.createContext(ctx)
  vm.runInContext(extractAsyncFunction('updateTabSettings'), ctx)

  const result = await ctx.updateTabSettings('tab-1', {
    proxyType: 'socks5',
    proxyHost: '1.2.3.4:1080'
  })
  return { result, tab, events, saved }
}

test('改代理成功时正常 reload', async () => {
  const { result, tab, events } = await runUpdate({ proxyFails: false })
  assert.equal(result.success, true)
  assert.equal(result.proxyChanged, true)
  assert.equal(tab.settings.proxyType, 'socks5')
  assert.ok(events.includes('reload'), '代理改成功后要 reload 才生效')
})

test('★ 改代理失败时必须把 settings 退回原值', async () => {
  const { tab } = await runUpdate({ proxyFails: true })
  assert.equal(tab.settings.proxyType, 'none',
    'settings 留在新值是致命的：界面说改了，session 实际还是旧代理')
  assert.equal(tab.settings.proxyHost, '')
})

test('★ 改代理失败时不得 reload（否则是拿旧代理刷新页面，假生效）', async () => {
  const { events } = await runUpdate({ proxyFails: true })
  assert.equal(events.includes('reload'), false,
    '代理没切成功还 reload，用户会以为新出口已生效')
})

test('★ 改代理失败必须返回 success:false 并带上原因', async () => {
  const { result } = await runUpdate({ proxyFails: true })
  assert.equal(result.success, false)
  assert.match(result.msg, /代理/, '渲染层靠 msg 出提示，不能只说"失败"')
  assert.equal(result.proxyChanged, false, '没生效就不能声称改过')
})

test('★ 改代理失败后必须重新落盘（否则磁盘上留的是新值）', async () => {
  const { saved } = await runUpdate({ proxyFails: true })
  assert.ok(saved.length >= 2, '回滚之后没有再 saveOpenApps，重启后又会读到新代理')
  const last = saved[saved.length - 1]
  assert.equal(last.proxyType, 'none', '最后落盘的那份必须是回滚后的值')
})

test('改代理失败必须留 error 级日志', async () => {
  const { events } = await runUpdate({ proxyFails: true })
  assert.ok(events.includes('log:proxy'), '静默回滚等于没有线索可查')
})

/**
 * 结构性哨兵：applyTabProxy 的调用必须被 try/catch 包住。
 */
test('★ updateTabSettings 里的 applyTabProxy 必须挂 catch', () => {
  const body = extractAsyncFunction('updateTabSettings')
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.ok(
    /try\s*\{[\s\S]*?await applyTabProxy/.test(code),
    'applyTabProxy 抛错时如果不回滚，设置会停在"已改但没生效"的脏状态'
  )
})
