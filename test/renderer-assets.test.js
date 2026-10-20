'use strict'

/**
 * 渲染层脚本的加载顺序与元素句柄完整性。
 *
 * ## 为什么需要这个文件
 *
 * 渲染层是三段传统 <script>，共享一个全局作用域，靠**标签顺序**保证
 * 后一个能用前一个的声明。这里的问题都不会报错，只会静默变 null：
 *
 *   - dom.js 放到 app.js 后面 → 顶层直接 ReferenceError，整个 UI 白屏
 *   - 两个文件重复声明同名 const → SyntaxError，整个 UI 白屏
 *   - 某个 id 拼错 → 变量是 null，只有点到那个功能才炸
 *
 * 单测跑不到 DOM，所以这里做静态校验。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = f => fs.readFileSync(path.join(root, 'desktop', 'renderer', f), 'utf8')

const html = read('index.html')
const domSrc = read('dom.js')
const appSrc = read('app.js')
const themeSrc = read('theme.js')
const pureSrc = read('pure.js')
const proxyPanelSrc = read('proxy-panel.js')
const tabsSrc = read('tabs.js')

/** 按出现顺序取出 <script src="..."> */
function scriptOrder (src) {
  return [...src.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1])
}

function topConsts (src) {
  return [...src.matchAll(/^const (\w+)/gm)].map(m => m[1])
}

test('★ 脚本顺序：依赖必须全部在 app.js 之前', () => {
  const order = scriptOrder(html)
  assert.deepEqual(order, ['theme.js', 'dom.js', 'pure.js', 'proxy-panel.js', 'tabs.js', 'app.js'],
    '顺序错了就是白屏：各模块的顶层声明必须在 app.js 执行前就位')
  // app.js 必须放在最后 —— 它是唯一会引用其它模块符号的脚本
  assert.equal(order[order.length - 1], 'app.js')
})

test('★ 文件之间不能有重复的顶层 const（重复声明 = SyntaxError = 白屏）', () => {
  const files = { 'dom.js': domSrc, 'pure.js': pureSrc, 'proxy-panel.js': proxyPanelSrc, 'tabs.js': tabsSrc, 'app.js': appSrc, 'theme.js': themeSrc }
  const seen = new Map()
  const dup = []
  for (const [name, src] of Object.entries(files)) {
    for (const id of topConsts(src)) {
      if (seen.has(id)) dup.push(id + '（' + seen.get(id) + ' 与 ' + name + '）')
      else seen.set(id, name)
    }
  }
  assert.deepEqual(dup, [], '重复声明会让整个渲染层起不来')
})

test('dom.js 只做取元素，不掺业务逻辑', () => {
  const lines = domSrc.split('\n').filter(l => l.trim() && !l.startsWith('//') && !l.startsWith(' *') && !l.startsWith('/**'))
  for (const l of lines) {
    assert.match(l, /^const \w+ = document\.(getElementById|querySelector)\(/,
      'dom.js 里只该有元素声明，出现别的说明有人把逻辑塞进来了：' + l)
  }
})

test('每个 getElementById 的 id 都真的存在于 index.html', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]))
  const missing = []
  for (const m of domSrc.matchAll(/^const (\w+) = document\.getElementById\('([^']+)'\)/gm)) {
    if (!ids.has(m[2])) missing.push(m[1] + ' -> #' + m[2])
  }
  // 这三个历史上就不存在，引用处都有 null 保护。列在这里是为了让新增的缺失无处藏身。
  const known = ['loginBgVideo -> #loginBgVideo', 'homeBgVideo -> #homeBgVideo', 'transBtn -> #transBtn']
  assert.deepEqual(missing.filter(x => !known.includes(x)), [],
    '新增了 HTML 里不存在的 id —— 那个变量会是 null，只有点到才炸')
})

test('已知的空引用都有 null 保护', () => {
  // 元素不存在没关系，但不能裸用
  for (const [name, re] of [
    ['loginBgVideo', /if \(loginBgVideo\)/],
    ['homeBgVideo', /if \(!homeBgVideo\) return/],
    ['transBtn', /if \(transBtn\) \{/]
  ]) {
    assert.match(appSrc, re, name + ' 是 null（HTML 里没有这个 id），必须判空')
  }
})

test('app.js 不再自己取元素（元素统一在 dom.js）', () => {
  const hits = [...appSrc.matchAll(/^const \w+ = document\.(getElementById|querySelector)\(/gm)]
  assert.deepEqual(hits.map(h => h[0]), [],
    '新增元素请加到 dom.js，别再往 app.js 里堆句柄')
})

test('CSP 仍然禁止内联脚本与远程脚本', () => {
  const csp = (html.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || ''
  assert.match(csp, /script-src 'self'/, 'script-src 必须是 self：不许内联、不许外链')
  assert.doesNotMatch(csp, /unsafe-eval/, '不许放开 eval')
  assert.match(csp, /default-src 'self'/)
})
