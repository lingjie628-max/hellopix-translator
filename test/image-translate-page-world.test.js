'use strict'

/**
 * 「翻译图片」按钮的**注入链路**契约。
 *
 * ## 这个文件在防什么（每一条都是 2026-10-29 真机踩出来的）
 *
 * 用户报"点开图片找不到翻译图片的按钮"。代码看上去处处正确：按钮建了、
 * 样式对、`display:flex`、坐标有值。实际全平台都不可用，原因有三层：
 *
 *   1. **注入在隔离世界** → 隔离世界的 addEventListener 收不到真实鼠标，
 *      按钮能看见但点不动；
 *   2. **`<script src="file://…">` 被 Chromium 拒** → `Not allowed to load
 *      local resource`，所以修 (1) 改注入页面世界时又卡住；
 *   3. **`protocol.handle()` 晚于导航** → 自定义协议的请求直接 ERR_FAILED，
 *      处理函数一次都不会被调用；
 *   4. **preload 的 `window.x = …` 页面世界读不到**（contextIsolation）→
 *      即使按钮能点，也会报"图片翻译不可用"。
 *
 * 这四条任何一条回退，功能就整体消失，而且**不报错**。所以必须有测试。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('★ 注入1：UI 脚本必须跑在页面世界，不能 new Function 在 preload 里执行', () => {
  const src = read('desktop/guest-inject.js')
  assert.doesNotMatch(
    src, /new Function\(code\)\(\)/,
    '又回到 preload 里执行 UI 脚本了 —— 隔离世界的事件收不到真实鼠标，' +
    '按钮会出现但点不动（而且这个 bug 在单测里看不出来）'
  )
  assert.match(src, /injectPageScripts/, '必须走 injectPageScripts')
})

test('★ 注入2：脚本 URL 必须走 pix:// 协议，不能是 file://', () => {
  const src = read('desktop/src/translate/page-world-inject.js')
  assert.doesNotMatch(
    src, /pathToFileURL/,
    'file:// 脚本会被 Chromium 拒绝：Not allowed to load local resource —— ' +
    '真机实测，关掉 webSecurity 也没用'
  )
  assert.match(src, /scriptUrl/, '必须用 pix:// 的 scriptUrl()')
})

test('★ 注入3：pix:// 协议必须在导航之前挂上（main.js 预挂 + web-view 补挂）', () => {
  const main = read('desktop/main.js')
  const idxReady = main.indexOf('app.whenReady()')
  assert.ok(idxReady > 0, '找不到 app.whenReady')
  const readyBody = main.slice(idxReady, idxReady + 4000)
  assert.match(
    readyBody, /prewarm/,
    'app.whenReady 里必须调 prewarm —— 实测 protocol.handle() 晚于页面导航' +
    '就彻底失效，页面里请求脚本直接 ERR_FAILED，且 handler 不会被调用'
  )
  assert.match(readyBody, /registerPrivilegedScheme/, '特权 scheme 必须在 ready 里注册')

  const view = read('desktop/src/window/web-view.js')
  assert.match(view, /attachHandler/, '每个客页的 partition 也要挂协议（新建分区不会自动继承）')
})

test('★ 注入4：桥必须用 contextBridge，不能用 window 赋值', () => {
  const src = read('desktop/guest-inject.js')
  assert.doesNotMatch(
    src, /window\.__pixTranslateImage\s*=/,
    '直接给 window 赋值，页面世界读不到（contextIsolation 下两个 window 是不同对象），' +
    '表现为每次点按钮都报"图片翻译不可用，请重启软件"'
  )
  assert.match(src, /exposeInMainWorld\(\s*['"]__pixTranslateImage/, '必须 exposeInMainWorld')
})

test('★ 注入5：pix:// 协议只服务三个白名单文件', () => {
  const src = read('desktop/src/translate/pix-protocol.js')
  assert.match(src, /ALLOWED\s*=\s*new Set\(\[/, '必须有文件名白名单')
  assert.match(src, /'patch\.js'/, '缺 patch.js')
  assert.match(src, /'main\.js'/, '缺 main.js')
  assert.match(src, /'guard\.js'/, '缺 guard.js')
  assert.match(src, /!ALLOWED\.has\(name\)/, '不在白名单必须拒绝')
  // 不能把用户可控路径拼进去 —— 那就是本地文件读取漏洞
  assert.match(src, /url\.hostname !== HOST/, '必须校验 host')
})

test('★ 注入6：三段脚本的源码必须是合法 JS（拼错了就是静默失效）', () => {
  const { buildHostScript } = require('../desktop/src/translate/page-world-inject')
  const { PATCH_BODY, GUARD_BODY } = require('../desktop/src/translate/page-world-scripts')

  assert.doesNotThrow(() => new Function(buildHostScript()), 'main.js 语法错误')
  assert.doesNotThrow(() => new Function(PATCH_BODY), 'patch.js 语法错误')
  assert.doesNotThrow(
    () => new Function(GUARD_BODY('pix://pix/main.js').replace('HOST_MAIN_URL_PLACEHOLDER', '"pix://pix/main.js"')),
    'guard.js 语法错误'
  )
})

test('★ 注入7：按钮必须挂在 documentElement，不能挂 body', () => {
  const { buildImageTranslateScript } = require('../desktop/src/translate/image-translate-ui.js')
  const src = buildImageTranslateScript()
  assert.doesNotMatch(
    src, /document\.body\.appendChild\(btn\)/,
    '灯箱打开时宿主会改/替换 body（overflow:hidden、全屏 portal），' +
    '挂 body 的按钮会被裁掉或清掉'
  )
  assert.match(src, /documentElement/, '必须挂 documentElement')
})

test('★ 注入8：灯箱动画期间要补几拍 tick（否则量到小尺寸就藏了按钮）', () => {
  const { buildImageTranslateScript } = require('../desktop/src/translate/image-translate-ui.js')
  const src = buildImageTranslateScript()
  assert.match(
    src, /scheduleBurst/,
    '灯箱是 200~400ms 的缩放动画，只在插入/srchange 时 tick 一次会量到动画中途的' +
    '小尺寸，按钮被藏后再也没有触发点'
  )
  assert.match(src, /attributeFilter:\s*\[[^\]]*'style'/, '要盯 style —— 动画收尾靠它')
})

test('★ 注入9：判断"灯箱大图"不能只看 naturalWidth', () => {
  const { buildImageTranslateScript } = require('../desktop/src/translate/image-translate-ui.js')
  const src = buildImageTranslateScript()
  // maybeHasPreview 里读 naturalWidth 会强制解码整页缩略图（性能），
  // 而且会把"CSS 放大但原图小"的灯箱整个漏掉。
  const start = src.indexOf('function maybeHasPreview')
  assert.ok(start > 0, '找不到 maybeHasPreview')
  const body = src.slice(start, start + 400)
  assert.doesNotMatch(
    body, /naturalWidth >= MIN_EDGE/,
    '预判不要用 naturalWidth 阈值 —— 会漏掉"原图小、CSS 放大"的灯箱，' +
    '并且每 400ms 全量解码缩略图会让宿主发涩'
  )
})

test('★ 注入10：选灯箱图不能拿 naturalWidth 卡门槛（真假灯箱的根因）', () => {
  const { buildImageTranslateScript } = require('../desktop/src/translate/image-translate-ui.js')
  const src = buildImageTranslateScript()

  const start = src.indexOf('function findPreviewImage')
  assert.ok(start > 0, '找不到 findPreviewImage')
  const body = src.slice(start, src.indexOf('function placeButton', start))

  // 2026-10-30 真机：WhatsApp 把 <img> 放大到 900x600，但原图自然尺寸
  // 只有几十像素（表情包/压缩截图）。旧写法 `nw < MIN_EDGE && nh < MIN_EDGE`
  // 直接 continue —— 按钮连创建都不创建。
  assert.doesNotMatch(
    body, /var\s+n[wh]\s*=\s*img\.naturalWidth|n[wh]\s*<\s*MIN_EDGE/,
    'findPreviewImage 用 naturalWidth < MIN_EDGE 过滤：原图小的灯箱会被整体跳过，' +
    '按钮永远不出现。判据只能是"现在屏幕上够不够大"'
  )
  // 屏幕尺寸门槛必须留着，否则聊天列表里的 60x60 缩略图会招出满屏按钮
  assert.match(body, /m\.w < MIN_EDGE \|\| m\.h < MIN_EDGE/,
    '可见面积门槛不能删 —— 它才是挡住缩略图的那道闸')
})
