'use strict'

/**
 * 开关/状态字段必须是 0/1 字面量。两个坑都真实存在于代码里过：
 *
 * 1. `number(data.status)` 对任何输入都给整数 —— `status=7` 原样进库，
 *    之后 `resolve()` 判 `!== 1` 当成停用，列表页却按真值显示"启用"。
 * 2. `Number(data.status) === 1 ? 1 : 0` 看着严格，实际上
 *    `Number('')`、`Number(null)`、`Number([])` **全是 0** ——
 *    前端漏传字段 = "停用"，还回你一句"已停用"，一切正常得可怕。
 *    同族的 `Boolean(Number(x))` 则会把 `"true"`/`"no"` 一律判成 false。
 *
 * 结论：全站只留一个 `toggle()`，三处入口都用它。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const { toggle } = require('../server/lib/http')

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('toggle 只接受 0/1 的字面形态', () => {
  for (const on of [1, '1', true]) assert.strictEqual(toggle(on), 1, `${JSON.stringify(on)} 应视为开`)
  for (const off of [0, '0', false]) assert.strictEqual(toggle(off), 0, `${JSON.stringify(off)} 应视为关`)
})

test('★ 空值绝不能当成 0（漏传字段 ≠ 关闭）', () => {
  for (const empty of ['', null, undefined, []]) {
    assert.strictEqual(toggle(empty), null,
      `${JSON.stringify(empty)} 被解析成了 ${JSON.stringify(toggle(empty))} —— Number('') 是 0，会静默把开关关掉`)
  }
})

test('其他非法值一律拒绝，不能进库', () => {
  for (const bad of [7, -1, 2, 'enabled', '0.5', 'true', 'yes', {}, ['1']]) {
    assert.strictEqual(toggle(bad), null, `${JSON.stringify(bad)} 不该被接受`)
  }
})

test('三处开关入口都用 toggle，且拒绝时给出 400', () => {
  const sites = [
    { file: 'server/routes/production.js', count: 2, label: '子账号单个 + 批量' },
    { file: 'server/routes/admin/accounts.js', count: 1, label: '超管停用商户' }
  ]
  for (const site of sites) {
    const src = code(site.file)
    const uses = src.split('\n').filter(line => /toggle\(data\.status\)/.test(line))
    assert.strictEqual(uses.length, site.count, `${site.label}：应调 toggle ${site.count} 次，实际 ${uses.length}`)
    const guards = src.split('\n').filter(line => /if \(status === null\) throw new ApiError\(400/.test(line))
    assert.strictEqual(guards.length, site.count, `${site.label}：拒绝时没有报 400`)
  }
})

test('★ 全仓不再出现 Boolean(Number(...)) 或"缺省即关闭"的猜法', () => {
  const offenders = []
  ;(function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.js')) continue
      const rel = path.relative(ROOT, full)
      const text = code(rel)
      if (/Boolean\(\s*Number\(/.test(text)) offenders.push(`${rel}: Boolean(Number(...))`)
      // `x === undefined ? null : number(x)` 是**对的**（缺省 = 保持原值）。
      // 危险的是缺省值落到 0/false 上：漏传字段 = 关掉。
      const risky = /===\s*undefined\s*\?\s*(false|0|'0')\s*:\s*(Boolean\(\s*)?(number|Number)\(/g
      let m
      while ((m = risky.exec(text)) !== null) {
        const line = text.slice(0, m.index).split('\n').length
        offenders.push(`${rel}:${line}: 缺省值被当成关闭 ${m[0].trim()}`)
      }
    }
  })(path.join(ROOT, 'server'))
  assert.deepStrictEqual(offenders, [], '这些地方还在靠数值转换猜布尔：\n' + offenders.join('\n'))
})
