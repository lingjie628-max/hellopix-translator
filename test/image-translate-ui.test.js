'use strict'

/**
 * 注入客页的「翻译图片」UI 脚本。
 *
 * ## 为什么这段要专门测
 *
 * 它是一段**字符串**，只能在真实的 WhatsApp 页面里执行才能发现问题。
 * 而它出错的代价很大：挂在每个客页里、每 400ms 跑一次，一旦抛异常
 * 就是持续刷错误日志；一旦它写坏宿主 DOM，用户会觉得"软件把 WhatsApp 搞坏了"。
 *
 * 所以这里用静态断言钉住几条硬要求：
 *   1. 能被解析成合法 JS（语法错在页面里是静默失败）；
 *   2. 幂等（重复注入不能出现两个按钮）；
 *   3. 不碰宿主的 DOM 结构（只 append 自己的元素，不改别人的）；
 *   4. 不把异常抛出去（try/catch 兜住 tick）。
 */

const test = require('node:test')
const assert = require('node:assert')

const { buildImageTranslateScript, MIN_EDGE, POLL_MS } = require('../desktop/src/translate/image-translate-ui')

const SRC = buildImageTranslateScript()

test('注入脚本能被解析（语法错误在页面里是静默失败）', () => {
  assert.doesNotThrow(() => new Function(SRC))
})

test('★ 注入脚本内部不使用块注释（模板字符串里写 */ 会截断整个脚本）', () => {
  // 这个文件用模板字符串承载整段脚本。模板内部一旦出现 `*/`，
  // JS 解析器会把它当成模板的结束，后面的代码变成裸标识符 →
  // require 直接抛 SyntaxError（本文件根本加载不了）。
  //
  // 已经踩过一次：在模板里写了一块 /** ... */ 注释。
  //
  // 所以刻意让注入脚本**只用 // 行注释**。这条断言在源码层面兜底：
  // 模板内出现 `/*` 就是错的，哪怕它碰巧配对（配对成功，但下次改一处就不配对了）。
  //
  // 判据：从模板起点开始，到结尾之间的内容不含 `/*`。
  const start = SRC.indexOf('(function installImageTranslate')
  assert.ok(start > 0, '找不到注入脚本主体')
  const body = SRC.slice(start)
  assert.equal(
    body.indexOf('/*'), -1,
    '注入脚本内部不许用块注释 —— 改成 // 行注释，否则模板会被截断'
  )
})

test('重复注入是幂等的（不能出现两个按钮）', () => {
  assert.match(SRC, /__pixImageTranslateInstalled/)
  // 守卫必须在最前面，且立刻置位
  const guardIdx = SRC.indexOf('if (window.__pixImageTranslateInstalled) return')
  const flagIdx = SRC.indexOf('window.__pixImageTranslateInstalled = true')
  assert.ok(guardIdx > 0, '缺少幂等守卫')
  assert.ok(flagIdx > guardIdx, '守卫必须在置位之前')
})

test('按钮与面板都只 append 到 body，不改宿主已有节点', () => {
  // 只允许 appendChild 我们自己的元素
  assert.match(SRC, /document\.body\.appendChild\(btn\)/)
  assert.match(SRC, /document\.body\.appendChild\(panel\)/)
  // 不允许替换/删除宿主内容
  assert.doesNotMatch(SRC, /document\.body\.innerHTML\s*=/)
  assert.doesNotMatch(SRC, /document\.body\.replaceWith/)
  assert.doesNotMatch(SRC, /\.remove\(\)\s*$/)
  assert.doesNotMatch(SRC, /outerHTML\s*=/)
})

test('轮询与观察都用 try/catch 兜住（异常不能刷满日志）', () => {
  assert.match(SRC, /try \{ tick\(\) \} catch/)
  assert.match(SRC, /try \{ var mo = new MutationObserver|try \{\s*var mo/)
})

test('语言从 window.__pixImageLang 读，不写死', () => {
  assert.match(SRC, /__pixImageLang/)
})

test('调桥用 window.__pixTranslateImage，且缺失时给提示而不是静默', () => {
  assert.match(SRC, /__pixTranslateImage/)
  assert.match(SRC, /typeof window\.__pixTranslateImage !== 'function'/)
})

test('大图判据：长宽都要够大（只看面积会把横向缩略图误判成灯箱）', () => {
  assert.match(SRC, /m\.w < MIN_EDGE \|\| m\.h < MIN_EDGE/)
  assert.ok(MIN_EDGE >= 100, 'MIN_EDGE 太小会把聊天缩略图当成灯箱')
})

test('轮询间隔是正数且不至于把主线程打满', () => {
  assert.ok(POLL_MS >= 200, '太快会拖慢宿主')
  assert.ok(POLL_MS <= 2000, '太慢用户点了图按钮要等很久')
})

test('面板可以关闭，且按钮点击不会冒泡到宿主（避免触发 WhatsApp 手势）', () => {
  assert.match(SRC, /stopPropagation\(\)/)
  assert.match(SRC, /pix-it-close/)
})

test('z-index 压过宿主灯箱但不是最大值（留出自有提示层的空间）', () => {
  const m = SRC.match(/z-index:(\d+)/)
  assert.ok(m, '缺 z-index')
  const z = Number(m[1])
  assert.ok(z >= 1000000, '压不过宿主灯箱')
  assert.ok(z < 2147483647, '取满后我们的提示层压不上去')
})

test('按钮文案可配置', () => {
  const custom = buildImageTranslateScript({ buttonText: 'Translate Image' })
  assert.match(custom, /Translate Image/)
})
