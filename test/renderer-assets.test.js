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
const transBarSrc = read('trans-bar.js')
const addAppSrc = read('add-app.js')
const uiKitSrc = read('ui-kit.js')
const opsMenuSrc = read('ops-menu.js')
const siteInfoSrc = read('site-info.js')
const linesSrc = read('lines.js')
const themeSwitchSrc = read('theme-switch.js')
const transSettingsSrc = read('trans-settings.js')

/** 按出现顺序取出 <script src="..."> */
function scriptOrder (src) {
  return [...src.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1])
}

function topConsts (src) {
  return [...src.matchAll(/^const (\w+)/gm)].map(m => m[1])
}

test('★ 脚本顺序：依赖必须全部在 app.js 之前', () => {
  const order = scriptOrder(html)
  assert.deepEqual(order, ['theme.js', 'dom.js', 'ui-kit.js', 'pure.js', 'proxy-panel.js', 'tab-layout.js', 'collision-update.js', 'site-info.js', 'ops-menu.js', 'tabs.js', 'theme-switch.js', 'lines.js', 'add-app.js', 'trans-settings.js', 'trans-bar.js', 'app.js'],
    '顺序错了就是白屏：各模块的顶层声明必须在 app.js 执行前就位')
  // ui-kit 只依赖 dom.js 的元素句柄；排到业务模块之后就等于谁都调不到它
  assert.equal(order.indexOf('ui-kit.js'), order.indexOf('dom.js') + 1,
    'ui-kit.js 必须紧跟 dom.js —— 它是所有业务模块的公共依赖')
  // app.js 必须放在最后 —— 它是唯一会引用其它模块符号的脚本
  assert.equal(order[order.length - 1], 'app.js')
})

test('★ 文件之间不能有重复的顶层 const（重复声明 = SyntaxError = 白屏）', () => {
  const files = { 'dom.js': domSrc, 'ui-kit.js': uiKitSrc, 'ops-menu.js': opsMenuSrc, 'site-info.js': siteInfoSrc, 'lines.js': linesSrc, 'theme-switch.js': themeSwitchSrc, 'trans-settings.js': transSettingsSrc, 'pure.js': pureSrc, 'proxy-panel.js': proxyPanelSrc, 'tabs.js': tabsSrc, 'trans-bar.js': transBarSrc, 'add-app.js': addAppSrc, 'app.js': appSrc, 'theme.js': themeSrc }
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

// ---------------------------------------------------------------------------
// 侧面布局的 CSS 作用域
// ---------------------------------------------------------------------------

test('★ 侧面布局的 CSS 不能用子选择器（标签栏不是 .stage 的直接子元素）', () => {
  const css = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'styles.css'), 'utf8')
  // index.html 里 .tabs-wrap 被 .stage-side-main 包了一层，
  // 写成 `.tabs-side > .tabs-wrap` 会一条都不命中：实测侧栏宽度仍是 auto、
  // 方向仍是 row —— 整块布局静默塌回顶部模式，没有任何报错。
  // 只检查真实的规则行（行首即选择器），注释里提到这个写法是合法的说明文字。
  // 注意 .stage-side-main 是 .stage 的直接子元素，用 > 是正确且必要的，
  // 这里只针对 .tabs-wrap —— 它被包了一层，> 不会命中。
  const ruleLines = css.split('\n').filter(line => /^\s*\.tabs-side\s*>[^{]*\.tabs-wrap/.test(line))
  assert.deepEqual(ruleLines, [],
    '子选择器不会命中，必须用后代选择器 .tabs-side .tabs-wrap')
  assert.ok(/\.tabs-side\s+\.tabs-wrap\s*\{/.test(css), '侧面布局的标签栏样式必须存在')
})

test('★ 侧面布局下的标签名必须解除 max-width: 62px', () => {
  const css = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'styles.css'), 'utf8')
  // 62px 是给顶部"68px 方块标签"定的。竖栏里标签是整行，
  // 不覆盖就会只显示 4 个汉字、右边留一大块空白（真机截图中确认过）。
  const block = css.slice(css.indexOf('.tabs-side .tab .tab-name'), css.indexOf('.tabs-side .tab .tab-name') + 400)
  assert.ok(/max-width:\s*none/.test(block), '竖栏里名字必须能撑满剩余宽度')
})

test('★ 侧栏宽度在 CSS 与主进程之间必须一致', () => {
  const css = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'styles.css'), 'utf8')
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  const cssW = /--tabs-side-w:\s*(\d+)px/.exec(css)
  const mainW = /const TABS_SIDE_WIDTH = (\d+)/.exec(main)
  assert.ok(cssW && mainW, '两处都必须定义侧栏宽度')
  // 对不上就是"标签栏被原生视图盖住"或"中间一条黑缝"，真机上极难定位。
  assert.equal(cssW[1], mainW[1], 'CSS 的 --tabs-side-w 与 main.js 的 TABS_SIDE_WIDTH 必须相等')
})

// ---------------------------------------------------------------------------
// ★ 按真实顺序执行全部脚本 ★
//
// 只做静态检查（找重复 const、查 ID 存在）抓不到两类真实事故：
//   1. 跨模块在顶层调用一个还没加载的函数（tab-layout.js 调 tabs.js 的
//      syncTabsOverflowHint）→ ReferenceError，整个脚本挂掉；
//   2. 重复声明（app.js 残留 let pendingUpdateUrl）→ SyntaxError，
//      **该文件整份不执行**，后面的函数全变成 undefined。
// 两者的外部表现都是"界面一部分功能静默消失"，日志里什么都没有。
// 所以这里用 vm 按 index.html 的顺序真的跑一遍。
// ---------------------------------------------------------------------------

test('★ 全部渲染层脚本按 index.html 顺序执行不抛错', () => {
  const vm = require('node:vm')
  // 最小 DOM：只要"存在且不崩"。这里验的是**顶层执行**，不是交互。
  const el = () => ({
    classList: { add () {}, remove () {}, toggle () {}, contains: () => false },
    style: { setProperty () {} },
    setAttribute () {}, appendChild () {}, removeChild () {},
    querySelector: () => null, querySelectorAll: () => [],
    innerHTML: '', textContent: '', dataset: {}, value: '', checked: false,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
    offsetHeight: 0, scrollHeight: 0, clientWidth: 0, scrollWidth: 0, scrollLeft: 0,
    addEventListener () {}, removeEventListener () {},
    showPopover () {}, hidePopover () {}, focus () {}, play: () => Promise.resolve()
  })
  // window.pix：preload 提供的 IPC 面。任何方法都返回"空成功"。
  const pix = new Proxy({}, { get: () => () => Promise.resolve({}) })
  const ctx = vm.createContext({
    document: {
      getElementById: el, querySelector: () => null, querySelectorAll: () => [],
      addEventListener () {}, createElement: el, body: el(), documentElement: el()
    },
    console: { log () {}, warn () {}, error () {} },
    setTimeout () {}, setInterval () {}, clearTimeout () {}, clearInterval () {},
    localStorage: { getItem: () => null, setItem () {} },
    navigator: { userAgent: '' }, location: {}, pix,
    ResizeObserver: function () { return { observe () {} } },
    matchMedia: () => ({ matches: false, addEventListener () {} }),
    requestAnimationFrame () {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    addEventListener () {}, removeEventListener () {}
  })
  ctx.window = ctx
  ctx.globalThis = ctx
  ctx.self = ctx

  const order = scriptOrder(html)
  for (const name of order) {
    const file = path.join(root, 'desktop', 'renderer', name)
    const src = fs.readFileSync(file, 'utf8')
    assert.doesNotThrow(
      () => vm.runInContext(src, ctx, { filename: name }),
      '脚本 ' + name + ' 在顶层抛错：这会让它自己（以及排在后面的）整份不执行'
    )
  }
})

test('★ 界面基建只允许定义一次（ui-kit.js 之外再定义 = 后加载的覆盖前面）', () => {
  // 这些函数都是后缀脚本（tabs.js / add-app.js / app.js）高频调用的。
  // 谁要是图方便在 app.js 里又写一份，改 ui-kit.js 就白改了 ——
  // 而且覆盖是无提示的，表现是"某处行为跟别处不一致"。
  const owned = ['show', 'overlayVisible', 'showOverlay', 'bindModalDismiss', 'missingShouldNotExist']
    .filter(n => n !== 'missingShouldNotExist')
    .concat(['confirmAction', 'toast', 'closeOperationMenus'])
  for (const name of owned) {
    const re = new RegExp('^function ' + name + '\\s*\\(', 'm')
    assert.match(uiKitSrc, re, 'ui-kit.js 应该定义 ' + name)
    for (const [file, src] of Object.entries({ 'app.js': appSrc, 'tabs.js': tabsSrc, 'add-app.js': addAppSrc, 'trans-bar.js': transBarSrc, 'pure.js': pureSrc, 'proxy-panel.js': proxyPanelSrc })) {
      assert.doesNotMatch(src, re, file + ' 里重复定义了 ' + name + '，应改用 ui-kit.js 的')
    }
  }
})

test('ui-kit.js 不依赖 tabs.js / app.js 的任何符号', () => {
  // 它排在它们前面加载。一旦在顶层调用了后面脚本的函数，
  // 就是 ReferenceError → 整份 ui-kit 不执行 → 所有面板和确认框全哑。
  const topLevelCalls = [...uiKitSrc.matchAll(/^([A-Za-z_$][\w$]*)\s*\(/gm)].map(m => m[1])
  const laterOwned = ['lastTabs', 'checkedIds', 'currentAccount', 'renderTabs', 'paintTabs']
  for (const symbol of laterOwned) {
    assert.ok(!topLevelCalls.includes(symbol), 'ui-kit.js 顶层不该调用 ' + symbol)
  }
  // 确认框的 resolve 变量是本文件私有的，不能和 app.js 抢名字
  assert.doesNotMatch(appSrc, /^let closeConfirmResolve/m, 'closeConfirmResolve 已归 ui-kit.js')
})

test('★ 操作菜单符号只在 ops-menu.js 定义一次', () => {
  const owned = ['activeTabState', 'paintOperationMenus', 'flashMenuButton', 'runMenuAction', 'paintStatus']
  for (const name of owned) {
    const re = new RegExp('^(?:async )?function ' + name + '\\s*\\(', 'm')
    assert.match(opsMenuSrc, re, 'ops-menu.js 应该定义 ' + name)
    assert.doesNotMatch(appSrc, re, 'app.js 里重复定义了 ' + name)
  }
  // ops-menu 排在 tabs.js 前，不能碰标签渲染的私有状态
  assert.doesNotMatch(opsMenuSrc, /\blastTabs\b/, 'ops-menu.js 不该读 lastTabs')
})

test('★ 每份共享状态只有一个持有者（两份值各走各的 = 查不出来的 bug）', () => {
  // 这些变量最容易顺手复制一份。复制不会报错、单测也不会红，但两份值从此
  // 分叉：比如 site-info 看到的 current 永远是 null，于是「独立应用版」对
  // 所有人都提示套餐未包含；lines 的 selectedId 各自一份，下拉框显示的
  // 线路和建实例实际写进去的线路会对不上。
  const sources = { 'app.js': appSrc, 'site-info.js': siteInfoSrc, 'ops-menu.js': opsMenuSrc, 'ui-kit.js': uiKitSrc, 'tabs.js': tabsSrc, 'add-app.js': addAppSrc, 'lines.js': linesSrc, 'pure.js': pureSrc }
  const owners = {
    'app.js': ['current', 'appVersion', 'skipAutoLogin', 'refreshTimer', 'platformCache'],
    'lines.js': ['lineRows', 'preferAuto', 'selectedId', 'fastest', 'speedTimer']
  }
  for (const [owner, names] of Object.entries(owners)) {
    for (const name of names) {
      assert.match(sources[owner], new RegExp('^let ' + name + '\\b', 'm'), owner + ' 应持有 ' + name)
      for (const [file, src] of Object.entries(sources)) {
        if (file === owner) continue
        assert.doesNotMatch(src, new RegExp('^let ' + name + '\\b', 'm'), file + ' 里重复声明了 ' + name + '（持有者应为 ' + owner + '）')
      }
    }
  }
})

test('站点信息符号只在 site-info.js 定义一次', () => {
  const owned = ['siteSupport', 'applySupport', 'footerDownloadVisible', 'syncFooterDownloads', 'runFooterAction', 'standaloneApps', 'openStandaloneDownload']
  for (const name of owned) {
    const re = new RegExp('^(?:async )?function ' + name + '\\s*\\(', 'm')
    assert.match(siteInfoSrc, re, 'site-info.js 应该定义 ' + name)
    assert.doesNotMatch(appSrc, re, 'app.js 里重复定义了 ' + name)
  }
})

test('★ 翻译设置：applyTransPrefs 只读、saveTransPrefs 才写 current', () => {
  // 这两个函数的方向搞反过一次，症状很隐蔽：
  //   · applyTransPrefs 写 current → openTransPanel 里它被调两次（打开时、
  //     通道列表回来后），第二次会把用户在中间动的开关覆盖掉；
  //   · saveTransPrefs 不写 current → 新建实例仍用登录那一刻的旧值，
  //     "我把收翻译关了，新窗口还开着收"。
  const applyBody = transSettingsSrc.slice(
    transSettingsSrc.indexOf('function applyTransPrefs('),
    transSettingsSrc.indexOf('/**', transSettingsSrc.indexOf('function applyTransPrefs('))
  )
  assert.doesNotMatch(applyBody, /current\.\w+\s*=/, 'applyTransPrefs 不许写 current')

  const saveBody = transSettingsSrc.slice(
    transSettingsSrc.indexOf('async function saveTransPrefs('),
    transSettingsSrc.indexOf('async function saveTransPrefs(') + 1200
  )
  assert.match(saveBody, /current\.activeEngine\s*=/, '保存后必须把通道写回 current')
  assert.match(saveBody, /current\.transRecv\s*=/, '保存后必须把开关写回 current')

  // 通道可选性归 trans-bar.js，设置面板只读
  assert.doesNotMatch(transSettingsSrc, /^let canSwitchEngine/m, 'canSwitchEngine 归 trans-bar.js')
  assert.doesNotMatch(transSettingsSrc, /^let engineRows/m, 'engineRows 归 trans-bar.js')
})

test('★ 主题：applyTheme 必须同时刷新按钮文案', () => {
  // 只改 data-theme 不改按钮，会出现"界面已经是日间、按钮还写着夜间"
  const body = themeSwitchSrc.slice(
    themeSwitchSrc.indexOf('function applyTheme('),
    themeSwitchSrc.indexOf('function applyTheme(') + 400
  )
  assert.match(body, /paintThemeButton\(/, 'applyTheme 必须调 paintThemeButton')
  // 启动校正要走 applyTheme，而不是直接 setAttribute
  const boot = themeSwitchSrc.slice(themeSwitchSrc.indexOf('if (themeBtn)'))
  assert.match(boot, /applyTheme\(saved\)/, '启动校正必须走 applyTheme')
})

test('trans-settings.js 必须排在 add-app.js 之后（它用 engineToShow）', () => {
  const order = scriptOrder(html)
  assert.ok(order.indexOf('trans-settings.js') > order.indexOf('add-app.js'),
    'engineToShow 定义在 add-app.js，排在它之前就是 ReferenceError')
  assert.match(addAppSrc, /^function engineToShow\(/m)
})
