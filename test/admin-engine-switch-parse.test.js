'use strict'

/**
 * 后台「配置翻译通道」的开关解析。
 *
 * 这里踩过一个会静默停服的问题：
 *
 *   const enabled = retired ? false : Boolean(Number(data.enabled))
 *
 * 管理员在弹窗里只改备注或换模型、**没有动启用开关**时，如果请求体里
 * 根本没带 `enabled`，表达式就变成 `Boolean(Number(undefined))` = `Boolean(NaN)` = false
 * —— 渠道当场被停用，前台立刻翻译不了，而界面上只显示"已保存"。
 *
 * 正确语义：**缺省 = 保持原值**，明确传了才改；传了认不出的值就 400，
 * 绝不能默默按 false 存。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'server', 'routes', 'admin', 'clients.js')
const src = fs.readFileSync(SRC, 'utf8')

/**
 * 把 clients.js 里"开关解析"那几行抠出来单独跑。
 * 不启动 express、不连库 —— 只验这段纯逻辑。
 */
function parseSwitches(data, engine) {
  const at = src.indexOf('const retired = data.retired')
  const end = src.indexOf('\n', src.indexOf('strictBool(data.enabled', at))
  const block = src.slice(at, end)
  const bool = require(path.join(ROOT, 'server', 'services', 'core-service')).bool
  const ApiError = class extends Error { constructor(s, m, c) { super(m); this.code = c } }
  const strictBool = (value, field) => {
    const parsed = bool(value)
    if (parsed === null) throw new ApiError(400, `${field} must be bool`, 'BAD_BOOLEAN')
    return parsed
  }
  // eslint-disable-next-line no-new-func
  return new Function('data', 'engine', 'bool', 'strictBool', 'ApiError', `${block}\nreturn { retired, enabled }`)(
    data, engine, bool, strictBool, ApiError)
}

test('★ 请求体没带 enabled 时必须保持原值，不能静默停用渠道', () => {
  // 管理员只改备注
  const { enabled } = parseSwitches({ note: '换了个 key' }, { enabled: true, retiredAt: null })
  assert.strictEqual(enabled, true, '仅改备注就把渠道停用了 —— 前台会当场报翻译失败')

  const off = parseSwitches({ note: 'x' }, { enabled: false, retiredAt: null })
  assert.strictEqual(off.enabled, false, '原本停用的渠道不该被意外启用')
})

test('★ 请求体没带 retired 时必须保持原值', () => {
  const live = parseSwitches({ note: 'x' }, { enabled: true, retiredAt: null })
  assert.strictEqual(live.retired, false)
  const dead = parseSwitches({ note: 'x' }, { enabled: false, retiredAt: new Date() })
  assert.strictEqual(dead.retired, true, '已下架的渠道不该因为改备注就重新上架')
})

test('显式传值按字面意思生效', () => {
  const cases = [
    [1, true], [0, false], ['1', true], ['0', false],
    ['true', true], ['false', false], [true, true], [false, false],
    ['on', true], ['off', false]
  ]
  for (const [raw, want] of cases) {
    const got = parseSwitches({ enabled: raw }, { enabled: false, retiredAt: null })
    assert.strictEqual(got.enabled, want, `enabled=${JSON.stringify(raw)} 应解析为 ${want}`)
  }
})

test('下架一律强制停用（哪怕同时传了 enabled=1）', () => {
  const got = parseSwitches({ retired: 1, enabled: 1 }, { enabled: true, retiredAt: null })
  assert.strictEqual(got.retired, true)
  assert.strictEqual(got.enabled, false, '下架的渠道不能还是启用状态')
})

test('认不出的开关值必须报错，不能默默当 false', () => {
  assert.throws(() => parseSwitches({ enabled: 'maybe' }, { enabled: true, retiredAt: null }), /BAD_BOOLEAN|bool/)
  assert.throws(() => parseSwitches({ retired: '算了' }, { enabled: true, retiredAt: null }), /BAD_BOOLEAN|bool/)
})

test('源码里不再有 Boolean(Number(...)) 这种猜法', () => {
  for (const file of ['server/routes/admin/clients.js', 'server/services/package-service.js']) {
    // 剔除注释：正确写法会特意在注释里点名这个反例，别把注释当代码
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!/Boolean\(\s*Number\(/.test(code), `${file} 里还有 Boolean(Number(...))：布尔语义会被数值转换猜错`)
  }
})
