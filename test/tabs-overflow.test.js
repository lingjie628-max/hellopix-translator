'use strict'

/**
 * 顶部标签栏「开很多窗口后滚不动」的回归护栏。
 *
 * ## 用户反馈
 *
 * 「上方应用开很多的话，空间不够，它不会出现可以滚条的那种，
 *   目前的判定是无限拉长界面，无法通过滚动解决」
 *
 * ## 真实原因（三条叠加）
 *
 * 1. `.tabs::-webkit-scrollbar { height: 0 }` —— 滚动条被彻底隐藏。
 *    容器本身 `overflow-x: auto` 是能滚的，但**看不见的可滚区域
 *    等于不可滚**：用户没有任何"还有更多"的提示。
 * 2. `.tab` 没有 `flex-shrink: 0`。容器挤满后每个标签被等比压扁，
 *    文字变形，看起来像"界面被拉长"而不是"该滚动了"。
 * 3. 新建窗口后不滚动到新标签。新窗口其实开了，但它排在右边、
 *    视口停在最左 —— 观感就是「点了没反应」。
 *
 * 这些是纯样式/交互问题，用静态断言锁住即可（无需真实渲染）。
 */

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const css = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'styles.css'), 'utf8')
const app = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'app.js'), 'utf8')
const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')

/** 取出某个选择器的规则体。必须**行首精确匹配** ——
 * 否则 `.tab {` 会命中 `.stage.is-home .tab {` 这种后代选择器。 */
function block(selector) {
  const i = css.indexOf('\n' + selector + ' {')
  if (i < 0) return ''
  const end = css.indexOf('}', i)
  return css.slice(i, end + 1)
}

test('★ 标签栏滚动条不得被隐藏（height: 0 就是本次的 bug）', () => {
  const rule = block('.tabs::-webkit-scrollbar')
  assert.ok(rule, '必须显式定义 .tabs::-webkit-scrollbar')
  assert.ok(!/height:\s*0\b/.test(rule),
    '滚动条高度为 0 = 用户看不见可以滚，这正是反馈的问题')
  const m = /height:\s*(\d+)px/.exec(rule)
  assert.ok(m && Number(m[1]) >= 4, '滚动条应可见，且足够点中')
})

test('滚动条必须有可见的滑块（否则有高度也没用）', () => {
  assert.ok(block('.tabs::-webkit-scrollbar-thumb'), '缺少 thumb 样式')
})

test('标签栏仍可横向滚动', () => {
  assert.match(block('.tabs'), /overflow-x:\s*auto/, 'overflow-x 必须是 auto')
})

test('★ 标签不得被压缩（flex-shrink 默认 1 会压扁所有标签）', () => {
  const rule = block('.tab')
  assert.match(rule, /flex:\s*0 0 auto/,
    '标签必须固定尺寸，溢出交给容器滚动，而不是把标签压扁')
})

test('标签宽度是固定的，不会被压缩', () => {
  const rule = block('.tab')
  assert.match(rule, /width:\s*68px/)
  assert.match(rule, /min-width:\s*68px/)
})

test('★ 标签栏高度必须给滚动条留独立空间', () => {
  // box-sizing: border-box 下，滚动条算在 height 里。
  // 标签 62px + 上下 padding 10px = 72px，正好占满旧的 72px ——
  // 滚动条挤进去就会压扁标签。所以高度必须 > 72。
  const rule = block('.tabs')
  const m = /height:\s*(\d+)px/.exec(rule)
  assert.ok(m, '未找到 .tabs 的 height')
  assert.ok(Number(m[1]) > 72,
    '.tabs 高度必须大于标签所需高度（72px），否则滚动条会压扁标签')
})

test('★ main.js 的 TABS_HEIGHT 必须与 CSS 同步', () => {
  // 这个常量决定 webview 的起始位置。不同步会导致标签栏被遮挡或下方留白。
  const cssH = Number(/height:\s*(\d+)px/.exec(block('.tabs'))[1])
  const m = /const TABS_HEIGHT = (\d+)/.exec(main)
  assert.ok(m, '未找到 TABS_HEIGHT 常量')
  assert.equal(Number(m[1]), cssH,
    'TABS_HEIGHT 与 .tabs 高度不一致：webview 会错位')
})

test('★ 新建/切换窗口后必须把激活标签滚进视野', () => {
  assert.match(app, /function keepActiveTabVisible/,
    '缺少自动滚动逻辑 —— 新窗口会开在右边而用户看不见')
  assert.match(app, /keepActiveTabVisible\(state, home\)/,
    'keepActiveTabVisible 必须在 renderTabs 中被调用')
})

test('自动滚动只在激活项不可见时才触发（避免打断手动浏览）', () => {
  const fn = app.slice(app.indexOf('function keepActiveTabVisible'))
  const body = fn.slice(0, fn.indexOf('\n}') + 2)
  assert.match(body, /left < viewLeft \|\| right > viewRight/,
    '已可见时不应滚动，否则每次渲染都会抖动')
  assert.match(body, /scrollLeft/, '应操作 scrollLeft')
})

// ---------------------------------------------------------------------------
// 4. 溢出容器的 flex 最小宽度 —— 最容易踩、也最隐蔽的一条
// ---------------------------------------------------------------------------

test('★ .tabs-wrap 必须 min-width: 0（否则永远不溢出、永远滚不动）', () => {
  // 实测过的坑：flex 子项默认 min-width:auto = 内容最小宽度。
  // 标签一多，.tabs 被撑到内容宽度（25 个标签时 1912px），
  // 于是 overflow-x:auto 永远不触发 —— 容器自己变宽了，何来溢出？
  // 表现就是用户反馈的「一路排到屏幕外，不能说滚动」。
  const wrap = block('.tabs-wrap')
  assert.ok(wrap, '缺少 .tabs-wrap 规则')
  assert.match(wrap, /min-width:\s*0/, '.tabs-wrap 必须 min-width: 0')
  assert.match(wrap, /display:\s*flex/)
})

test('★ .tabs 在 wrap 里必须能收缩（min-width:0 + flex）', () => {
  const rule = block('.tabs-wrap > .tabs')
  assert.ok(rule, '缺少 .tabs-wrap > .tabs 规则')
  assert.match(rule, /min-width:\s*0/, '.tabs 也必须 min-width: 0')
  assert.match(rule, /flex:/, '.tabs 需要在 wrap 内参与收缩')
})

test('★ HTML 里必须有 tabs-wrap 包裹层（渐隐提示依赖它定位）', () => {
  const html = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'index.html'), 'utf8')
  assert.match(html, /id="tabsWrap"/, '缺少 tabsWrap 容器')
  assert.match(html, /id="tabs"\s+class="tabs"/, 'tabs 容器应保持不变')
  // wrap 必须包住 tabs
  const wi = html.indexOf('id="tabsWrap"')
  const ti = html.indexOf('id="tabs"')
  assert.ok(wi > 0 && ti > wi, 'tabs 必须位于 tabsWrap 内部')
})

test('两侧渐隐提示必须随滚动位置精确切换', () => {
  assert.match(app, /function syncTabsOverflowHint/, '缺少渐隐状态同步函数')
  const fn = app.slice(app.indexOf('function syncTabsOverflowHint'))
  const body = fn.slice(0, fn.indexOf('\n}') + 2)
  assert.match(body, /has-more-left/, '缺少左侧提示')
  assert.match(body, /has-more-right/, '缺少右侧提示')
  // 滚到边界时必须消失，否则用户会以为"还有"却滚不动
  assert.match(body, /maxScroll/, '必须依据最大可滚距离判断，而不是只看是否溢出')
})

test('渐隐层不得拦截鼠标事件（否则点不到标签）', () => {
  const i = css.indexOf('.tabs-wrap::before')
  const seg = css.slice(i, css.indexOf('.tabs-wrap.has-more-right::after') + 40)
  assert.match(seg, /pointer-events:\s*none/, '渐隐层会挡住标签点击')
})
