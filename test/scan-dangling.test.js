'use strict'

/**
 * 悬空标识符扫描器的自身测试。
 *
 * ## 为什么扫描器也要测
 *
 * 这个工具是用来抓"测试假绿"的 —— 如果它自己是绿的但什么都扫不出来，
 * 那比没有更糟：给人虚假的安全感。
 *
 * 下面每一条都对应一个**真实踩过的坑**：
 *
 * · 正则版把 SQL 关键字当悬空常量，真出事的标识符被截断漏掉
 * · 小写标识符（`repo`）不在"常量"这个假设里，直接漏
 * · 提升（`f(); function f(){}`）会误报
 * · 块作用域泄漏（`{let a} console.log(a)`）必须报
 * · 属性名、对象 key 不是变量，误报会淹没信号
 * · 跨文件共享作用域（desktop/renderer 的 <script> 平铺加载）
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  findDanglingIdentifiers,
  findDanglingIdentifiersInSet,
  GLOBALS
} = require('../scripts/scan-dangling-lib')

/** 只取名字，方便断言 */
const names = src => findDanglingIdentifiers(src).map(h => h.name)

test('抓到悬空函数（readSettings 事故）', () => {
  assert.deepEqual(names('function f(){ return readSettings() }'), ['readSettings'])
})

test('抓到悬空常量（USDT_TRC20_CONTRACT / RECHARGE_TTL_MINUTES 事故）', () => {
  assert.deepEqual(names('const x = RECHARGE_TTL_MINUTES * 60 * 1000'), ['RECHARGE_TTL_MINUTES'])
})

test('抓到悬空的小写标识符（repo 闭包丢失事故）—— 正则版最大的盲区', () => {
  // 提到模块顶层后引用 repo，而 repo 是原来闭包里的变量
  assert.deepEqual(names('async function list(){ return repo.query("x") }'), ['repo'])
})

test('正常闭包不误报', () => {
  const src = `
    function outer() {
      const repo = { query() {} }
      async function list() { return repo.query() }
      return list
    }
  `
  assert.deepEqual(names(src), [])
})

test('函数声明提升不误报', () => {
  assert.deepEqual(names('foo(); function foo(){}'), [])
})

test('var 在块内提升到函数作用域，不误报', () => {
  assert.deepEqual(names('if (1) { var a = 1 } console.log(a)'), [])
})

test('let 不跨块泄漏，必须报', () => {
  assert.deepEqual(names('{ let a = 1 } console.log(a)'), ['a'])
})

test('解构声明不误报，但解构里引用的外部对象要报', () => {
  assert.deepEqual(names('const { a, b: { c } } = obj'), ['obj'])
  assert.deepEqual(names('const obj = {}; const { a, b: { c } } = obj'), [])
})

test('函数参数（含解构、默认值、rest）不误报', () => {
  assert.deepEqual(names('const f = (x, { y, z = 1 }, ...rest) => x + y + z + rest'), [])
})

test('属性访问不是变量引用', () => {
  assert.deepEqual(names('obj.foo.bar'), ['obj'])       // obj 本身是引用
  assert.deepEqual(names('const obj = {}; obj.foo.bar'), [])
})

test('对象字面量的 key 不是变量', () => {
  assert.deepEqual(names('const bar = 1; const o = { foo: 1, bar }'), [])
  // 计算属性 key 是引用
  assert.deepEqual(names('const o = { [key]: 1 }'), ['key'])
})

test('for-of / for-in / for 头部的声明不误报', () => {
  assert.deepEqual(names('for (const x of arr) { console.log(x) }'), ['arr'])
  assert.deepEqual(names('const arr = [1]; for (const x of arr) { console.log(x) }'), [])
  assert.deepEqual(names('for (let i = 0; i < 3; i++) {}'), [])
})

test('catch 参数不误报', () => {
  assert.deepEqual(names('try {} catch (e) { console.log(e) }'), [])
})

test('类声明与类名在类体内可见', () => {
  assert.deepEqual(names('class A { m() { return A } }'), [])
})

test('Node 全局（require/process/Buffer/console）不误报', () => {
  assert.deepEqual(names('console.log(process.env.X, Buffer.from("a"), require("fs"))'), [])
})

test('浏览器全局不误报', () => {
  assert.deepEqual(names('window.foo; document.title; localStorage.x = 1'), [])
})

test('ESM：import 绑定名可见，export 声明名可见', () => {
  const src = `
    import { ref, computed } from 'vue'
    import api from './api'
    const x = ref(0)
    const y = computed(() => api.get(x))
    export { y }
    export const z = 1
  `
  assert.deepEqual(names(src), [])
})

test('ESM：未导入的标识符要报', () => {
  const src = `
    import { ref } from 'vue'
    const x = ref(0)
    const y = computed(() => x)
  `
  assert.deepEqual(names(src), ['computed'])
})

test('模板字符串插值里的引用会被检查', () => {
  assert.deepEqual(names('const s = `a${missing}b`'), ['missing'])
})

test('行号定位准确，便于直接跳转', () => {
  const src = 'const a = 1\n\n\nconst b = missingThing\n'
  const hits = findDanglingIdentifiers(src)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].name, 'missingThing')
  assert.equal(hits[0].line, 4)
})

test('语法错误抛出带文件名的错误，不静默吞掉', () => {
  assert.throws(
    () => findDanglingIdentifiers('const = ;', 'bad.js'),
    err => /bad\.js/.test(err.message)
  )
})

test('SQL 关键字与错误码字符串不算引用', () => {
  // 正则版把 SELECT/FROM/PACKAGE_NOT_FOUND 全报了一遍
  const src = `
    const rows = await repo.query('SELECT id FROM packages WHERE code = $1')
    throw new ApiError(404, '套餐不存在', 'PACKAGE_NOT_FOUND')
  `
  assert.deepEqual(names(src).sort(), ['ApiError', 'repo'])
})

// ------------------------------------------------------------ 共享作用域

test('共享作用域：跨文件声明的全局变量不误报', () => {
  const hits = findDanglingIdentifiersInSet([
    { filename: 'dom.js', source: "const profile = document.getElementById('profile')" },
    { filename: 'ui-kit.js', source: 'function overlay(){ return profile.classList }' }
  ])
  assert.deepEqual(hits, [])
})

test('共享作用域：真悬空的引用照样报，且定位到正确文件与行号', () => {
  const hits = findDanglingIdentifiersInSet([
    { filename: 'a.js', source: 'const a = 1\nconst b = 2' },
    { filename: 'b.js', source: '\nfunction f(){ return totallyMissing }' }
  ])
  assert.equal(hits.length, 1)
  assert.equal(hits[0].name, 'totallyMissing')
  assert.equal(hits[0].file, 'b.js')
  assert.equal(hits[0].line, 2)     // b.js 自己的第 2 行
})

test('全局白名单本身不含拼接错误（导出给 CLI 用）', () => {
  assert.ok(GLOBALS.has('require'))
  assert.ok(GLOBALS.has('window'))
  assert.ok(!GLOBALS.has(''))
})
