'use strict'

/**
 * 代理没生效时绝不能加载页面（"绝不静默换出口"）。
 *
 * ## 真实的失效链
 *
 * `startTabLoad` 原来是：
 *
 *     applyTabProxy(tab, deps).finally(() => { ensurePlatformExtension(...).then(() => loadURL()) })
 *
 * 带认证的 SOCKS5 在本地中继起不来时，`applyTabProxy` 会 `throw`（见
 * proxy-settings.js 那句"绝不退回直连 —— 那是静默换出口"）。于是：
 *
 *   1. `.finally` 回调照样执行 → `loadURL()` 被调用；
 *   2. 此时 session 上根本没写代理规则 → 真的是**直连**；
 *   3. 那条链的 rejection 没人接 → unhandledRejection。
 *
 * 用户的意图是"这个窗口必须走代理"，实际结果是"用真实 IP 打开了这个网站"。
 * 对做多账号运营的人来说，这是**账号关联**级别的后果，不是体验问题。
 *
 * ## 测试方式
 *
 * main.js 依赖 electron，不能直接 require。这里把它当成脚本：
 * 用 vm 造一个假的 electron + 假的依赖，真跑 startTabLoad，
 * 然后断言 loadURL 有没有被调用。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8')

/** 按花括号配平切出顶层函数。 */
function extractFunction (name) {
  const marker = 'function ' + name + '('
  const start = mainSource.indexOf(marker)
  assert.ok(start >= 0, 'main.js 里找不到 ' + marker)
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
 * 在隔离上下文里跑 startTabLoad。
 *
 * @param {object} opts
 * @param {'ok'|'throw'} opts.proxy   applyTabProxy 的行为
 */
async function runStartTabLoad (opts) {
  const o = opts || {}
  const events = []

  const webContents = {
    isDestroyed: () => false,
    loadURL: (url) => {
      events.push({ type: 'loadURL', url })
      return Promise.resolve()
    },
    getURL: () => ''
  }

  const ctx = {
    // startTabLoad 用到的外部注入
    applyTabProxy: () => o.proxy === 'throw'
      ? Promise.reject(new Error('本地 SOCKS5 中继未能启动'))
      : Promise.resolve(),
    tabProxyDeps: () => ({}),
    ensurePlatformExtension: () => Promise.resolve(),
    paintLoadError: (tab, code, desc) => { events.push({ type: 'paintLoadError', code, desc }) },
    clientLog: {
      error: (ch, msg) => { events.push({ type: 'log-error', ch, msg }) },
      warn: (ch, msg) => { events.push({ type: 'log-warn', ch, msg }) }
    },
    Error: Error,
    String: String,
    Promise: Promise
  }
  vm.createContext(ctx)
  vm.runInContext(extractFunction('startTabLoad'), ctx)

  const tab = {
    id: 'tab-1',
    url: 'https://web.whatsapp.com',
    view: { webContents: webContents }
  }

  ctx.startTabLoad(tab)
  // 让 then/catch 链跑完
  await new Promise(resolve => setTimeout(resolve, 30))
  return events
}

test('代理应用成功时才加载页面', async () => {
  const events = await runStartTabLoad({ proxy: 'ok' })
  const loads = events.filter(e => e.type === 'loadURL')
  assert.equal(loads.length, 1, '代理正常时不加载页面，等于窗口永远空白')
  assert.equal(loads[0].url, 'https://web.whatsapp.com')
})

test('★ 代理应用失败时绝不能 loadURL（否则是静默直连）', async () => {
  const events = await runStartTabLoad({ proxy: 'throw' })
  const loads = events.filter(e => e.type === 'loadURL')
  assert.equal(loads.length, 0,
    '代理没装上却加载了页面 —— 这个窗口会用真实 IP 访问平台，等于把账号关联暴露出去')
})

test('★ 代理失败必须画出错误页，而不是留一个黑屏', async () => {
  const events = await runStartTabLoad({ proxy: 'throw' })
  const painted = events.filter(e => e.type === 'paintLoadError')
  assert.equal(painted.length, 1, '用户需要一个能看懂的理由，不是一块黑屏')
  assert.match(painted[0].desc, /代理/, '错误页要说明是代理问题')
  assert.match(painted[0].desc, /未加载页面/, '要明说"没有加载页面"，否则用户会以为只是慢')
})

test('★ 代理失败必须留下 error 级日志（排查线索）', async () => {
  const events = await runStartTabLoad({ proxy: 'throw' })
  const errors = events.filter(e => e.type === 'log-error')
  assert.equal(errors.length, 1, '静默吞掉失败，线上就完全无法定位')
  assert.equal(errors[0].ch, 'proxy')
})

test('代理失败不能产生未处理的 rejection', async () => {
  const unhandled = []
  const onUnhandled = (reason) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    await runStartTabLoad({ proxy: 'throw' })
    // 多等一会，让微任务队列彻底排空
    await new Promise(resolve => setTimeout(resolve, 50))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  assert.equal(unhandled.length, 0,
    '未处理的 rejection 会在主进程里变成噪音，也可能被 Electron 当成崩溃上报')
})

/**
 * 结构性哨兵：源码里不许再出现 `.finally(() => ...loadURL...)` 这种写法。
 * 有人改回去，这条立刻红。
 */
test('★ startTabLoad 里不许再出现"finally 里 loadURL"的写法', () => {
  const body = extractFunction('startTabLoad')
  // 去掉注释，避免把说明文字当代码
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.equal(
    /applyTabProxy[\s\S]*?\.finally\s*\(/.test(code), false,
    '.finally 会在 applyTabProxy 失败时照样执行回调 —— 那就是静默直连的来源')
  assert.ok(
    /applyTabProxy[\s\S]*?\.catch\s*\(/.test(code),
    'applyTabProxy 必须挂 catch，否则失败路径没有任何处理')
})
