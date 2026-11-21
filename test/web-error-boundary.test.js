'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const compiler = require('vue-template-compiler')

const root = path.join(__dirname, '..')

test('路由页面由全局错误边界包裹，组件异常不能直接白屏', () => {
  const app = fs.readFileSync(path.join(root, 'src', 'App.vue'), 'utf8')
  const boundary = fs.readFileSync(path.join(root, 'src', 'components', 'AppErrorBoundary.vue'), 'utf8')
  const sfc = compiler.parseComponent(boundary)
  const compiled = compiler.compile(sfc.template.content)
  assert.deepEqual(compiled.errors, [])
  assert.match(app, /<app-error-boundary>[\s\S]*<router-view\/>[\s\S]*<\/app-error-boundary>/)
  assert.match(boundary, /errorCaptured\(error, _vm, info\)/)
  assert.match(boundary, /return false/)
  assert.match(boundary, /页面加载失败/)
})

test('错误边界的捕获方法会记录异常并切换到兜底状态', () => {
  const boundary = fs.readFileSync(path.join(root, 'src', 'components', 'AppErrorBoundary.vue'), 'utf8')
  const sfc = compiler.parseComponent(boundary)
  const mod = { exports: {} }
  const code = sfc.script.content.replace('export default', 'module.exports =')
  new Function('module', 'exports', code)(mod, mod.exports)
  const ctx = {
    error: null,
    info: '',
    routePath: '',
    $route: { fullPath: '/count/tickets' }
  }
  const result = mod.exports.errorCaptured.call(ctx, new Error('ticket is null'), {}, 'render')
  assert.equal(result, false)
  assert.equal(ctx.error.message, 'ticket is null')
  assert.equal(ctx.info, 'render')
  assert.equal(ctx.routePath, '/count/tickets')
})

test('业务 bundle 启动失败时有静态兜底页', () => {
  const guard = fs.readFileSync(path.join(root, 'public', 'boot-guard.js'), 'utf8')
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8')
  assert.match(html, /src="\/boot-guard\.js"/)
  assert.match(guard, /BOOT_TIMEOUT_MS = 12000/)
  assert.match(guard, /window\.__pixShowFatal/)
  assert.match(guard, /window\.__pixBootReady/)
  assert.match(guard, /页面加载失败/)
  assert.match(guard, /new URL\(raw, window\.location\.href\)\.origin === window\.location\.origin/,
    '第三方统计/监控脚本失败不能整页判死')
  assert.match(guard, /if \(sameOrigin\) showFatal/, '只有同源业务资源失败才显示启动错误页')
})
