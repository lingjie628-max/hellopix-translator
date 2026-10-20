'use strict'

/**
 * 「界面显示的通道 = 实际扣费的通道」——客户端侧守卫。
 *
 * ## 被修的缺陷（macOS 0.1.11 真机）
 *
 * 真机截图里通道显示 **GPT**，该子账号所属套餐（基础版，`allow_engine_switch=false`）
 * 其实由服务端**锁死**到套餐内第一个已接通通道 = **DeepSeek**。
 * 用户按着界面上的 GPT 去理解计费，看到的和真实走的是两个通道。
 *
 * 服务端早已是对的（`engines().activeEngine` 就是解析结果，契约用例
 * `test/production-api.contract.test.js` 的「界面显示的当前通道必须与实际使用的一致」
 * 锁着它）。问题在客户端**无视**这个字段，改用账号里存的 `active_engine_id`
 * （`profile.activeEngine`）来显示。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
// 渲染层已拆成多个脚本，规则要在**全部源码**上校验，不能只看 app.js
const rendererSrc = require('./helpers/renderer-src')
const app = rendererSrc.all()

test('enterShell：套餐锁定时必须采用服务端解析出的通道', () => {
  // 文件里有多处 translateEngines()，这里锁定 enterShell 里那一段
  const call = app.match(
    /engineRows = \(\(resp && resp\.rows\) \|\| \[\]\)\.filter\(e => e\.allowed !== false\)[\s\S]*?authoritativeEngine = canSwitchEngine \? '' : String\(\(resp && resp\.activeEngine\) \|\| ''\)/
  )
  assert.ok(call, '找不到 enterShell 里采用 resp.activeEngine 的那段')
  const body = call[0]
  assert.match(body, /canSwitchEngine = !\(resp && resp\.canSwitch === false\)/,
    '必须从服务端读 canSwitch')
  assert.match(body, /authoritativeEngine = canSwitchEngine \? '' : String\(\(resp && resp\.activeEngine\) \|\| ''\)/,
    '锁定时必须采用 resp.activeEngine（服务端解析结果）')
})

test('engineToShow：锁定用服务端通道，可切换时尊重用户选择', () => {
  const src = app.match(/function engineToShow\(stored\)\s*\{[\s\S]*?\n\}/)
  assert.ok(src, '找不到 engineToShow')
  const make = authoritativeEngine => new Function(
    'authoritativeEngine',
    src[0] + '\nreturn engineToShow'
  )(authoritativeEngine)

  // 锁定：账号里存着 gpt，服务端解析出 deepseek → 必须显示 deepseek
  assert.equal(make('deepseek')('gpt'), 'deepseek')
  // 可切换：authoritativeEngine 为空 → 尊重用户选择
  assert.equal(make('')('gpt'), 'gpt')
  // 都没有 → 空串（界面显示"无可用通道"），不编一个
  assert.equal(make('')(''), '')
})

test('所有显示通道的地方都必须走 engineToShow，不许直接用账号里存的值', () => {
  // 侧边翻译栏
  assert.match(app, /barEngine\.value = engineToShow\(trans\.engine\)/,
    'paintTransBar 必须用 engineToShow')
  assert.ok(!/barEngine\.value = trans\.engine\b/.test(app),
    'paintTransBar 不得直接采信 trans.engine')
  // 设置面板
  assert.match(app, /transEngine\.value = engineToShow\(data\.activeEngine\)/,
    'applyTransPrefs 必须用 engineToShow')
  // 新建实例的默认值
  assert.match(app, /engine:\s*engineToShow\(\(current && current\.activeEngine\)/,
    'defaultAppSettings 必须用 engineToShow')
  // 新建实例表单（另一处会覆盖默认值的地方）
  assert.match(app, /const engine = engineToShow\(\(current && current\.activeEngine\)/,
    '新建实例表单必须用 engineToShow')
  assert.ok(!/if \(engine\) addEngine\.value = \(current && current\.activeEngine\)/.test(app),
    '新建实例表单不得直接采信 current.activeEngine')
})

test('登出必须清掉锁定的通道与通道列表，避免下个账号看到上一个账号的通道', () => {
  const fn = app.match(/function backToLogin\(msg\)\s*\{[\s\S]*?\n\}/)
  assert.ok(fn, '找不到 backToLogin')
  assert.match(fn[0], /authoritativeEngine = ''/, '登出要清 authoritativeEngine')
  assert.match(fn[0], /engineRows = \[\]/, '登出要清 engineRows')
})
