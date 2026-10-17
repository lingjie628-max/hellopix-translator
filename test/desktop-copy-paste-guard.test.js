'use strict'

/**
 * 译文/正文的复制、粘贴、全选 —— 源码级守卫（两层都必须存在）。
 *
 * ## 为什么单开这个文件
 *
 * 「译文复制不出来」不是**一个**缺陷，而是**两层**同时缺失：
 *
 *   第 1 层（网页里，guest-inject.js）：**.pix-trans 要能被选中**。
 *     宿主会在气泡容器上打 `user-select: none`；Chromium 在 `user-select:none`
 *     的子树里**拒绝建立任何选区**（`getSelection()` 返回空串，程序选也选不中）。
 *     所以 `.pix-trans` 必须用 `!important`（带前缀 + 不带前缀两种写法）
 *     把选中权抢回来。只做这一层 → 能选中，但快捷键复制不生效。
 *
 *   第 2 层（Electron 主进程，main.js）：**编辑快捷键要能作用到 WebContentsView**。
 *     聊天应用跑在 WebContentsView 里，Electron **不会**把 `Cmd/Ctrl+C/V/A`
 *     自动作用到嵌入的 webContents —— 要靠应用菜单的编辑角色转发，或自己接住
 *     `before-input-event` 调 `webContents.copy()/paste()/selectAll()`。
 *     本应用隐藏了菜单栏且从未注册编辑角色，`WebContentsView` 又默认不弹右键菜单
 *     → 三样全缺。只做这一层 → 快捷键通了，但网页里根本没东西可复制。
 *
 * **两层缺一不可。** 真 Electron 机制验收见
 * `desktop/scripts/verify-copy-paste-electron.js`（npm run verify:copy）；
 * 本文件守住"两层都在源码里"这件事，防止以后被顺手删掉一层。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const guest = fs.readFileSync(path.join(root, 'desktop', 'guest-inject.js'), 'utf8')
const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
const pkg = fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8')

test('第 1 层（网页）：.pix-trans 用两种前缀 + !important 把选中权抢回来', () => {
  const rule = (guest.match(/\.pix-trans\s*\{[\s\S]*?\n\s*\}/) || [''])[0]
  assert.ok(rule.length > 0, '找不到 .pix-trans 规则')
  assert.match(rule, /user-select:\s*text\s*!important/,
    '.pix-trans 缺少 user-select: text !important —— 宿主 user-select:none 会压住它，译文选不中')
  assert.match(rule, /-webkit-user-select:\s*text\s*!important/,
    '.pix-trans 缺少 -webkit-user-select: text !important —— 很多宿主用的是带前缀写法')
})

test('第 1 层（网页）：selectstart / copy 事件守卫存在且在捕获阶段', () => {
  assert.match(guest, /'selectstart',\s*'copy'/, '缺少 selectstart/copy 事件守卫')
  const start = guest.indexOf("['selectstart', 'copy']")
  assert.ok(start >= 0, '找不到事件守卫锚点')
  const end = guest.indexOf('function api(', start)
  assert.ok(end > start, '找不到事件守卫结束锚点')
  const guard = guest.slice(start, end)
  assert.match(guard, /addEventListener\(type,[\s\S]*?\},\s*true\)/,
    '事件守卫必须挂在捕获阶段（true），否则宿主更早的监听先取消')
  assert.match(guard, /stopPropagation\(\)/, '事件守卫没有掐断向宿主的传播')
})

test('第 2 层（主进程）：编辑快捷键在 WebContentsView 上被显式接住', () => {
  // 必须有 before-input-event 处理器 —— 这是不依赖菜单的兜底通道。
  const src = (main.match(/function installEditSupport\(view\)\s*\{[\s\S]*?\n\}/) || [''])[0]
  assert.ok(src.length > 0, '找不到 installEditSupport —— 编辑快捷键没有被接住')
  assert.match(src, /before-input-event/, 'installEditSupport 没有挂 before-input-event')
  for (const cmd of ['copy', 'paste', 'cut', 'selectAll']) {
    assert.match(src, new RegExp("runEditCommand\\(wc,\\s*'" + cmd + "'\\)"),
      'installEditSupport 没有处理 ' + cmd + '（译文/正文就无法复制/粘贴/全选）')
  }
  // 右键菜单：WebContentsView 默认不弹系统菜单，必须自己建。
  assert.match(src, /context-menu/, 'installEditSupport 没有挂 context-menu（右键没有复制/粘贴）')
})

test('第 2 层（主进程）：每个 WebContentsView 都装上了编辑支持', () => {
  const src = (main.match(/function createWebView[\s\S]*?\n\}/) || [''])[0]
  assert.ok(src.length > 0, '找不到 createWebView')
  assert.match(src, /installEditSupport\(view\)/, 'createWebView 没有给 view 装编辑支持')
})

test('第 2 层（主进程）：macOS 装了带编辑角色的应用菜单', () => {
  const src = (main.match(/function installApplicationMenu\(\)\s*\{[\s\S]*?\n\}\n/) || [''])[0]
  assert.ok(src.length > 0, '找不到 installApplicationMenu')
  assert.match(src, /Menu\.setApplicationMenu/, 'macOS 没有 setApplicationMenu —— Cmd+C/V/A 不会转发到 webContents')
  for (const role of ['copy', 'paste', 'cut', 'selectAll', 'undo', 'redo']) {
    assert.match(src, new RegExp("role:\\s*'" + role + "'"),
      '应用菜单缺少编辑角色：' + role)
  }
  // 必须在 createWindow 之前装好，窗口一出现快捷键就可用。
  const ready = main.indexOf("app.whenReady().then(() => {")
  const readyBody = main.slice(ready, ready + 1200)
  assert.match(readyBody, /installApplicationMenu\(\)/, 'whenReady 里没有调用 installApplicationMenu')
})

test('验证脚本已登记（npm run verify:copy）', () => {
  assert.match(pkg, /"verify:copy"\s*:\s*"[^"]*verify-copy-paste-electron\.js"/,
    'package.json 没有登记 verify:copy')
})
