'use strict'

/**
 * 底栏（`.pix-footer`）在 Windows 上的表现。
 *
 * ## 现象（用户报「Windows 这个，好像有自己的想法」）
 *
 * 首页底栏的「Windows电脑版」和「苹果电脑版」两段文字重叠打印在同一位置，
 * 排在后面的三个按钮直接不见。macOS 不复现。
 *
 * ## 根因是两件事叠在一起
 *
 * **1) backdrop-filter 合成层残影（截图里"文字叠印"的直接原因）**
 *
 * `.stage.is-home .pix-footer` 带 `backdrop-filter: blur(12px)`。Windows/Chromium
 * 在**隐式**创建合成层时，子元素文字重绘不跟父层同步：旧帧字形留在原地、
 * 新字形又画上去。所以光看截图会误判成"布局重叠"，实际布局是对的、绘制错了。
 * macOS 走 Apple 的合成路径，不复现。
 *
 * 注意：安卓 / 苹果手机版 / 独立应用版三个按钮**本来就不显示**，那是
 * `site-info.js` 的 `footerDownloadVisible()` 按数据显隐 —— 没有对应的发布记录
 * 就隐藏，是对的。所以截图里只剩 3 个按钮也能解释，不是"按钮消失"。
 *
 * **2) 窄屏真溢出（次要，但确实存在）**
 *
 * 底栏是 `grid-template-columns: minmax(max-content, 1fr) auto minmax(max-content, 1fr)`。
 * `max-content` 让两侧轨道**不可能窄于内容**，总需宽是硬下限：
 *
 *     右组 6 个按钮约 499px + 左组约 375px + 版本块约 90px ≈ 965px
 *
 * 实测：逻辑宽 819 溢出 40px，683 溢出 176px（Windows 150% 缩放下 1024 物理宽
 * 只有 683 逻辑宽）。溢出时 `overflow: hidden` 直接裁掉后面的按钮。
 * 这就是为什么必须加窄屏断点 —— 一旦将来安卓/iOS 真的上架，6 个按钮全出现，
 * 小屏就会立刻撞上这个下限。
 *
 * 另一个前提问题：字体栈原来只有 -apple-system / SF Pro，Windows 上一个都没有，
 * 字宽不可控 —— mac 上量出来的 499px 在 Windows 上不成立。
 *
 * ## 本测试锁什么
 *
 * 只锁**能在 Node 里静态断言**的部分：
 *   · 字体栈必须覆盖 Windows（否则字宽不可控，mac 上量出来的宽度在 Windows 不成立）
 *   · 必须有窄屏降级断点，且降级时**主下载按钮不能被隐藏**
 *   · backdrop-filter 那层必须有合成层修复
 *
 * 真正的像素级验证要靠 m3.html 那种真实布局测量（见文件末尾的说明）。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const css = fs.readFileSync(
  path.join(__dirname, '..', 'desktop', 'renderer', 'styles.css'), 'utf8')

const html = fs.readFileSync(
  path.join(__dirname, '..', 'desktop', 'renderer', 'index.html'), 'utf8')

/** 取某个选择器的规则体，找不到返回空串。 */
function ruleOf(selector) {
  const idx = css.indexOf(selector + ' {')
  if (idx < 0) return ''
  const end = css.indexOf('}', idx)
  return end < 0 ? '' : css.slice(idx, end)
}

test('★ 字体栈必须覆盖 Windows（缺了它字宽不可控，mac 上量的宽度不成立）', () => {
  const body = ruleOf('html, body')
  assert.ok(body, '找不到 html/body 规则')
  assert.match(body, /Microsoft YaHei|Segoe UI/,
    '★ 原字体栈只有 -apple-system/BlinkMacSystemFont/SF Pro，这三个 Windows 上一个都没有，只能退化到裸 sans-serif')
  // macOS 的字体不能被挤掉
  assert.match(body, /-apple-system|BlinkMacSystemFont/, 'macOS 字体必须保留')
})

test('★ backdrop-filter 那层必须有合成层修复，否则 Windows 会留文字残影', () => {
  const rule = ruleOf('.stage.is-home .pix-footer')
  assert.ok(rule, '找不到 .stage.is-home .pix-footer 规则')
  assert.match(rule, /backdrop-filter/, '这条规则的用途就是给首页底栏加毛玻璃')
  assert.match(rule, /translateZ\(0\)/,
    '★ 必须显式创建合成层。由 backdrop-filter 隐式创建的层不参与子树重绘同步，' +
    'Windows 上会把旧帧文字留在原地')
  assert.match(rule, /will-change/,
    '要提示合成器这层内容会变，避免走缓存旧帧的快路径')
})

test('★ 窄屏必须有降级断点（12px 字号下 6 个按钮硬需约 965px）', () => {
  // 1000px 断点：去掉装饰符号，腾出宽度
  const narrow = css.match(/@media\s*\(max-width:\s*1000px\)\s*\{([\s\S]*?)\n\}/)
  assert.ok(narrow, '★ 缺 1000px 断点：1000 以下必然溢出，按钮会被 overflow:hidden 裁掉')
  assert.match(narrow[1], /button span[^{]*\{\s*display:\s*none/,
    '窄屏要隐藏按钮前的装饰符号（▦▣◆），每个省下约一个全角宽度')

  // 860px 断点：砍掉次要平台按钮
  const tight = css.match(/@media\s*\(max-width:\s*860px\)\s*\{([\s\S]*?)\n\}/)
  assert.ok(tight, '★ 缺 860px 断点：150% 缩放的小屏（逻辑宽约 683）溢出 176px')
})

test('★ 极窄时被隐藏的只能是次要平台，主下载入口必须保留', () => {
  const tight = css.match(/@media\s*\(max-width:\s*860px\)\s*\{([\s\S]*?)\n\}/)
  assert.ok(tight)
  const body = tight[1]

  // 这三个是次要的，官网也能下
  for (const key of ['android', 'ios', 'standalone']) {
    assert.match(body, new RegExp(`data-download-key="${key}"`),
      `${key} 应在极窄时隐藏`)
  }

  // ★ 这三个是主入口，绝不能被隐藏 ★
  for (const key of ['app', 'windows', 'macos']) {
    assert.doesNotMatch(body, new RegExp(`data-download-key="${key}"[^{]*\\{[^}]*display:\\s*none`),
      `★ data-download-key="${key}" 是主下载入口，不能在窄屏被隐藏 —— ` +
      '用户点不到就等于这个平台的包不存在')
  }
})

test('★ 窄屏隐藏必须带 !important（syncFooterDownloads 写的是内联 display）', () => {
  const tight = css.match(/@media\s*\(max-width:\s*860px\)\s*\{([\s\S]*?)\n\}/)
  assert.ok(tight)
  // site-info.js 里 btn.style.display = ... 是内联样式，优先级高于类选择器
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'desktop', 'renderer', 'site-info.js'), 'utf8')
  if (/btn\.style\.display\s*=/.test(src)) {
    const hideRules = tight[1].match(/display:\s*none[^;]*;/g) || []
    assert.ok(hideRules.length > 0, '找不到 display:none 规则')
    for (const r of hideRules) {
      assert.match(r, /!important/,
        '★ site-info.js 会写内联 style.display，类选择器压不过它。' +
        '不带 !important 这条规则就是死的')
    }
  }
})

test('index.html 里主下载按钮的 key 必须与 CSS 断点一致', () => {
  // 断点里写死的 key 如果和 HTML 对不上，那条规则就是死的
  for (const key of ['app', 'windows', 'macos', 'android', 'ios', 'standalone']) {
    assert.match(html, new RegExp(`data-download-key="${key}"`),
      `index.html 缺少 data-download-key="${key}" 的按钮，CSS 里针对它的断点会失效`)
  }
})

test('底栏结构：左右两组 + 中间版本块，顺序不能乱（grid 三列按 DOM 顺序分配）', () => {
  // grid-template-columns 有三列，DOM 必须是 左组 / 版本 / 右组 三段
  const footer = html.slice(html.indexOf('id="pixFooter"'), html.indexOf('</footer>'))
  const leftAt = footer.indexOf('footer-left')
  const verAt = footer.indexOf('footer-version')
  const rightAt = footer.indexOf('footer-right')
  assert.ok(leftAt > 0 && verAt > 0 && rightAt > 0, '底栏三段必须齐全')
  assert.ok(leftAt < verAt && verAt < rightAt,
    'DOM 顺序必须是 左组 → 版本块 → 右组，否则 grid 三列会分配错位')
})
