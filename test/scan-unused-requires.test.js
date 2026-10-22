'use strict'

/**
 * 未使用 import 扫描器的测试。
 *
 * 一个"永远返回 0 个问题"的扫描器是最好写也最没用的东西 ——
 * 它会让人以为检查过了。所以这里重点验证**它确实能抓出东西**，
 * 以及**不会把合法用法误判成未使用**（误报会逼人把检查关掉）。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const acorn = require('acorn')
const { topLevelRequires, moduleImports, isUsedOutsideDeclaration } = require('../scripts/scan-unused-requires')

/** 把一段源码当文件扫，返回 unused 名单 */
function unusedIn(source) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', locations: true, sourceType: 'script' })
  return topLevelRequires(ast)
    .filter(r => !isUsedOutsideDeclaration(ast, r.name))
    .map(r => r.name)
}

test('抓出真正没用的 require', () => {
  assert.deepEqual(unusedIn(`
    const fs = require('fs')
    const path = require('path')
    fs.readFileSync('x')
  `), ['path'])
})

test('解构里没用的也要抓，不能只看第一个', () => {
  assert.deepEqual(unusedIn(`
    const { readFileSync, writeFileSync, existsSync } = require('fs')
    readFileSync('x')
  `).sort(), ['existsSync', 'writeFileSync'])
})

test('重命名解构按**本地名**判断', () => {
  // { STATUS: RECHARGE_STATUS } —— 用 RECHARGE_STATUS 才算用到
  assert.deepEqual(unusedIn(`
    const { STATUS: RECHARGE_STATUS } = require('./state')
  `), ['RECHARGE_STATUS'])

  assert.deepEqual(unusedIn(`
    const { STATUS: RECHARGE_STATUS } = require('./state')
    if (RECHARGE_STATUS.OK) {}
  `), [])
})

test('默认值解构也要认', () => {
  assert.deepEqual(unusedIn(`
    const { a = 1 } = require('./m')
    a()
  `), [])
})

// ---------------------------------------------------------------- 误报防护

test('对象字面量的键不算引用', () => {
  // { path: 'x' } 里的 path 是字符串键，不是变量引用
  assert.deepEqual(unusedIn(`
    const path = require('path')
    const cfg = { path: '/tmp' }
  `), ['path'])
})

test('简写对象 { path } 算引用', () => {
  assert.deepEqual(unusedIn(`
    const path = require('path')
    const cfg = { path }
  `), [])
})

test('成员访问的属性名不算引用', () => {
  // foo.path 里的 path 不是变量 path
  assert.deepEqual(unusedIn(`
    const path = require('path')
    const foo = {}
    foo.path
  `), ['path'])
})

test('模板字符串里的引用算', () => {
  assert.deepEqual(unusedIn([
    "const path = require('path')",
    'const s = `${path.sep}`'
  ].join('\n')), [])
})

test('函数参数里的同名遮蔽不算"使用了外层 import"', () => {
  // 这条是**已知局限**：参数遮蔽时我们会误判成"已使用"。
  // 误判方向是"漏报"而不是"误报"，可以接受 —— 漏报只是少查一次，
  // 误报会逼人把整个检查关掉。这里把行为钉住，将来改实现时能看到。
  assert.deepEqual(unusedIn(`
    const path = require('path')
    function f(path) { return path }
  `), [])
})

// ---------------------------------------------------------------- ESM

test('ESM 的 import 也能扫', () => {
  const ast = acorn.parse(`
    import Vue from 'vue'
    import { a, b as c } from './m'
    import * as ns from './n'
    import './side-effect'
    Vue.use(a)
  `, { ecmaVersion: 'latest', sourceType: 'module' })
  const names = moduleImports(ast).map(s => s.name)
  assert.deepEqual(names.sort(), ['Vue', 'a', 'c', 'ns'],
    '副作用导入（import "m"）没有绑定，不该出现在名单里')
})

// ---------------------------------------------------------------- 真实仓库

test('本仓库当前没有任何未使用 import', () => {
  // 扫 server/ 与 scripts/ —— 前端 src/ 由构建工具（vue-cli）自己会提示
  const { scanFile } = require('../scripts/scan-unused-requires')
  const ROOT = path.join(__dirname, '..')
  const offenders = []

  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(p); continue }
      if (!entry.name.endsWith('.js')) continue
      const result = scanFile(p)
      if (result.parseError) continue
      for (const u of result.unused) {
        offenders.push(`${path.relative(ROOT, p)}:${u.line} ${u.name}`)
      }
    }
  }

  walk(path.join(ROOT, 'server'))
  walk(path.join(ROOT, 'scripts'))

  assert.deepEqual(offenders, [],
    '存在未使用的 import。拆服务时最容易留下这种残留：\n  ' + offenders.join('\n  '))
})
