'use strict'

/**
 * 侧栏「翻译设置」渲染测试。
 *
 * 为什么需要：2026-09-13 把翻译通道下拉从写死的 youdao/google/deepl 改成读后台的
 * 已接通通道列表。这段只在真机上点开侧栏才会跑到，改错了（少个转义、少个 selected、
 * 三元写反）本地完全看不出来 —— 而"下拉里选不到可用通道"的表现又是气泡不出译文，
 * 跟编译失败长得一样。
 *
 * 做法：把真实的 renderer/app.js 放进 node:vm，配一个最小 DOM 桩，
 * 走真实路径 showKind('trans') -> openFlyout(transHtml()) -> bindFlyout()，
 * 再从桩里取 flyoutBody.innerHTML 和 savePrefs 的入参断言。验的是真代码。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const APP_JS = path.join(__dirname, '..', 'standalone', 'telegram-win', 'renderer', 'app.js')

function makeElement(id) {
  return {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    checked: false,
    dataset: {},
    onclick: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    querySelectorAll() { return [] }
  }
}

/**
 * 真实 DOM 里 innerHTML 会立即建出元素；桩不会。
 * 这里只挑测试要用的 <select>，按标签上有没有 disabled 建出对应桩元素，
 * 好让 bindFlyout 里按 id 取元素的真实代码能拿到正确的禁用态。
 */
function registerSelectsFromHtml(elements, html) {
  const tag = /<select id="([^"]+)"([^>]*)>/g
  let match
  while ((match = tag.exec(html)) !== null) {
    const element = makeElement(match[1])
    element.disabled = /\bdisabled\b/.test(match[2])
    elements.set(match[1], element)
  }
}

/** 在 vm 里跑真实 app.js，返回渲染出的侧栏 HTML 与捕获到的 savePrefs 入参。 */
async function renderTransFlyout(statePayload) {
  const elements = new Map()
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id))
      return elements.get(id)
    },
    querySelector(selector) { return this.getElementById(selector) },
    querySelectorAll() { return [] }
  }
  const saved = []
  const app = {
    async state() { return statePayload },
    async engines() { return statePayload.engines },
    async flyout() { return { ok: true } },
    async savePrefs(payload) { saved.push(payload); return payload },
    async translate() { return { text: '' } },
    async login() { return {} },
    async logout() {},
    async openTelegram() { return { ok: true } },
    async addInstance() { return [] },
    async focusTelegram() { return { ok: true } },
    on() {}
  }
  const sandbox = {
    document,
    window: { app, close() {} },
    console,
    setTimeout,
    clearTimeout,
    Promise
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), context)
  // 走真实入口：showKind 会重新拉一次通道列表再渲染并绑定事件，和点侧栏按钮同一条路径。
  await context.showKind('trans')
  const html = elements.get('flyoutBody').innerHTML
  registerSelectsFromHtml(elements, html)
  return { html, elements, saved }
}

const WIRED = { known: true, wired: true, rows: [{ id: 'deepseek', name: 'DeepSeek 翻译' }] }

test('已接通通道会渲染成可选项并被选中', async () => {
  const { html } = await renderTransFlyout({
    pix: null,
    engines: WIRED,
    prefs: { engine: 'deepseek', lang: 'zh', transRecv: true, transSend: true, transGroup: true }
  })
  assert.match(html, /<select id="prefEngine">/)
  assert.match(html, /<option value="deepseek" selected>DeepSeek 翻译<\/option>/)
  // 写死的那三个通道不能再出现：它们在后台都没接通
  assert.doesNotMatch(html, /youdao/)
  assert.doesNotMatch(html, /google/)
  assert.doesNotMatch(html, /deepl/)
})

test('多个已接通通道全部列出，只选中当前那个', async () => {
  const { html } = await renderTransFlyout({
    pix: null,
    engines: {
      known: true,
      wired: true,
      rows: [
        { id: 'deepseek', name: 'DeepSeek 翻译' },
        { id: 'gpt', name: 'GPT 翻译' }
      ]
    },
    prefs: { engine: 'gpt', lang: 'zh' }
  })
  assert.match(html, /<option value="deepseek" ?>DeepSeek 翻译<\/option>/)
  assert.match(html, /<option value="gpt" selected>GPT 翻译<\/option>/)
})

test('问过后台但套餐里没有已接通通道：下拉禁用并说明要去后台接通', async () => {
  const { html, elements } = await renderTransFlyout({
    pix: null,
    engines: { known: true, wired: false, rows: [] },
    prefs: { engine: '', lang: 'zh' }
  })
  assert.match(html, /<select id="prefEngine" disabled>/)
  assert.match(html, /套餐内没有已接通的通道/)
  assert.equal(elements.get('prefEngine').disabled, true)
  // 没有可用通道时不能给出一个看着能选的空下拉
  assert.doesNotMatch(html, /<option value=""/)
})

test('没连上后台：提示的是连接问题而不是套餐问题', async () => {
  const { html } = await renderTransFlyout({
    pix: null,
    engines: { known: false, wired: false, rows: [] },
    prefs: { engine: '', lang: 'zh' }
  })
  assert.match(html, /<select id="prefEngine" disabled>/)
  assert.match(html, /还没连上 Hello Pix 后台/)
  assert.doesNotMatch(html, /套餐内没有已接通的通道/)
})

test('通道名做 HTML 转义，后台数据不能注入侧栏', async () => {
  const { html } = await renderTransFlyout({
    pix: null,
    engines: {
      known: true,
      wired: true,
      rows: [{ id: 'x"><script>alert(1)</script>', name: '<img src=x onerror=alert(1)>' }]
    },
    prefs: { engine: '' }
  })
  assert.doesNotMatch(html, /<img src=x/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('通道缺失时 state.engines 为空也不炸（首帧还没拉到后台）', async () => {
  const { html } = await renderTransFlyout({
    pix: null,
    engines: undefined,
    prefs: { engine: '', lang: 'zh' }
  })
  assert.match(html, /<select id="prefEngine" disabled>/)
  assert.match(html, /还没连上 Hello Pix 后台/)
})

test('下拉禁用时保存，不会把占位文案当成 engine 存下去', async () => {
  const { elements, saved } = await renderTransFlyout({
    pix: null,
    engines: { known: true, wired: false, rows: [] },
    prefs: { engine: '', lang: 'zh' }
  })
  assert.equal(elements.get('prefEngine').disabled, true)
  await elements.get('savePrefs').onclick()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].engine, '', '禁用的下拉不能被当成用户选择')
})

test('下拉可用时保存，存的是用户选中的通道', async () => {
  const { elements, saved } = await renderTransFlyout({
    pix: null,
    engines: WIRED,
    prefs: { engine: 'deepseek', lang: 'zh' }
  })
  const select = elements.get('prefEngine')
  assert.equal(select.disabled, false)
  select.value = 'deepseek'
  await elements.get('savePrefs').onclick()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].engine, 'deepseek')
})
