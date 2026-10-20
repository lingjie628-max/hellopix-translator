const { coversFile } = require('./helpers/whitelist')
'use strict'

/**
 * 远程页面读取的**安全不变量** + 产品与验收共用同一实现。
 *
 * 背景：探测线路出口 IP 需要打开一个远程页面并读回它的文本。安全测试
 * （desktop-security.test.js）明令禁止在远程页面的 page world 里执行脚本
 * —— 那等于把主进程代码放进页面能窥探、能篡改的环境。
 * 正确做法是隔离世界（isolated world），本文件把这条不变量钉死。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { readPageText, PROBE_WORLD_ID } = require('../desktop/src/translate/probe-page')

const root = path.join(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
const probeSrc = fs.readFileSync(path.join(root, 'desktop', 'src/translate/probe-page.js'), 'utf8')
const scriptSrc = fs.readFileSync(path.join(root, 'desktop', 'scripts', 'proxy-mechanism-electron.js'), 'utf8')

function fakeWebContents(result) {
  return {
    isDestroyed: () => false,
    calls: [],
    executeJavaScriptInIsolatedWorld(worldId, scripts) {
      this.calls.push({ worldId, scripts })
      return Promise.resolve(result)
    }
  }
}

test('readPageText：用隔离世界读回页面文本', async () => {
  const wc = fakeWebContents(['{"ip":"203.0.113.7"}'])
  const text = await readPageText(wc)
  assert.equal(text, '{"ip":"203.0.113.7"}')
  assert.equal(wc.calls.length, 1)
  assert.equal(wc.calls[0].worldId, PROBE_WORLD_ID, '必须指定隔离世界 id')
  assert.equal(wc.calls[0].scripts.length, 1)
  assert.ok(wc.calls[0].scripts[0].code.includes('document.body'), '读的是页面正文')
})

test('readPageText：兼容「直接返回结果」的 Electron 版本（返回数组时只取首字符是真实缺陷）', async () => {
  // Electron 33 实测直接返回字符串。曾按数组取 results[0]，结果只拿到 '{'，
  // JSON.parse 失败 → 探测节点永远报"连不上"。
  const wc = fakeWebContents('{"ip":"198.51.100.9"}')
  assert.equal(await readPageText(wc), '{"ip":"198.51.100.9"}')
})

test('readPageText：对象不可用 / 已销毁 / 读取报错时安静返回空串（由调用方判失败）', async () => {
  assert.equal(await readPageText(null), '')
  assert.equal(await readPageText({}), '')
  assert.equal(await readPageText({ isDestroyed: () => true, executeJavaScriptInIsolatedWorld() { throw new Error('不该被调用') } }), '')
  assert.equal(await readPageText({ executeJavaScriptInIsolatedWorld() { return Promise.reject(new Error('boom')) } }), '')
})

test('【安全】probe-page.js 不用 page world 的 executeJavaScript，只用隔离世界', () => {
  assert.ok(probeSrc.includes('executeJavaScriptInIsolatedWorld'), '必须走隔离世界')
  assert.ok(!/\.executeJavaScript\s*\(/.test(probeSrc), '不得使用 page world 的 executeJavaScript')
})

test('【安全】main.js 里没有任何 page world 的 executeJavaScript（远程页面不注入脚本）', () => {
  // 这条与 desktop-security.test.js 的守卫同源，这里再钉一次，避免以后手滑加回来。
  // 探测实现已迁到 src/proxy/detect.js —— 守卫必须覆盖它，否则搬走就等于失守。
  const detectSrc = fs.readFileSync(
    path.join(root, 'desktop', 'src', 'proxy', 'detect.js'), 'utf8')
  for (const [name, src] of [['main.js', mainSrc], ['src/proxy/detect.js', detectSrc]]) {
    assert.ok(!src.includes('executeJavaScript('), name + ' 出现了 page world 的 executeJavaScript')
  }
  assert.ok(mainSrc.includes("require('./src/translate/probe-page')"), 'main.js 必须复用隔离世界读取实现')
  // 调用点在 detect.js（main.js 只把 readPageText 注入进去）
  assert.ok(detectSrc.includes('libs.readPageText('), '节点探测必须用 readPageText 读远程页面')
  assert.ok(mainSrc.includes('readPageText,'), 'main.js 必须把 readPageText 注入探测模块')
})

test('【验收一致性】真机脚本用的是产品同一份读取实现（否则验收证明不了产品路径）', () => {
  assert.ok(scriptSrc.includes("require('../src/translate/probe-page')"), '验收脚本必须复用 probe-page.js')
  assert.ok(scriptSrc.includes('readPageText('), '验收脚本必须调用同一实现')
  assert.ok(!scriptSrc.includes('executeJavaScript('), '验收脚本里同样不得出现 page world 执行')
})

test('【打包】新增的本地模块都在 electron-builder 白名单里', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'))
  for (const f of ['src/proxy/socks-relay.js', 'src/translate/probe-page.js', 'src/proxy/proxy-settings.js']) {
    assert.ok(coversFile(pkg.build.files, f), f + ' 不在 build.files 覆盖范围内，打包后会缺失导致启动即崩')
  }
})
