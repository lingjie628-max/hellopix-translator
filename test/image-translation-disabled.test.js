'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.join(__dirname, '..')
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('图片翻译默认关闭：页面世界不再注入图片翻译 UI', () => {
  const src = read('desktop/src/translate/page-world-inject.js')
  assert.doesNotMatch(src, /buildImageTranslateScript/)
  assert.doesNotMatch(src, /图片翻译已安装/)
})

test('图片翻译默认关闭：客页不再暴露图片翻译桥', () => {
  const src = read('desktop/guest-inject.js')
  assert.match(src, /IMAGE_TRANSLATION_ENABLED\s*=\s*false/)
  assert.match(src, /if\s*\(IMAGE_TRANSLATION_ENABLED\)\s*installImageTranslate/)
})

test('图片翻译默认关闭：主进程 IPC 直接拒绝，不取图、不发上游', () => {
  const src = read('desktop/src/ipc/translate.js')
  const start = src.indexOf("reg.handle('translate:image'")
  assert.ok(start > 0, '缺少 translate:image handler')
  const body = src.slice(start, src.indexOf("reg.handle('translate:savePrefs'", start))
  assert.match(body, /IMAGE_TRANSLATION_DISABLED/)
  assert.match(body, /IMAGE_TRANSLATION_ENABLED/)
  assert.ok(
    body.indexOf('IMAGE_TRANSLATION_ENABLED') < body.indexOf('actions.extractImage'),
    '必须在取图之前拒绝'
  )
})

test('图片翻译默认关闭：服务端返回 410，不调用视觉模型', () => {
  const src = read('server/routes/production.js')
  const handlerStart = src.indexOf('const translateImage =')
  const routeStart = src.indexOf("router.post('/translate/image'")
  assert.ok(handlerStart > 0 && routeStart > handlerStart)
  const body = src.slice(handlerStart, routeStart)
  assert.match(body, /IMAGE_TRANSLATION_DISABLED/)
  assert.doesNotMatch(body, /core\.translateImage/)
})

test('图片翻译默认关闭：不再为图片路由放开 16MB body', () => {
  const src = read('server/index.js')
  assert.doesNotMatch(src, /app\.use\('\/apis\/translate\/image',\s*express\.json/)
})

test('图片翻译默认关闭：右键和官网都不再宣传入口', () => {
  assert.doesNotMatch(read('desktop/src/window/context-menu-template.js'), /诊断图片翻译/)
  assert.doesNotMatch(read('src/components/Landing.vue'), /图文翻译|image-translate/)
})

