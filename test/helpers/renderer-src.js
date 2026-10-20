'use strict'

/**
 * 读取渲染层源码。
 *
 * ## 为什么要合并读
 *
 * 渲染层拆成了多个传统 <script>，共享同一个全局作用域。很多测试是
 * "在源码里找某段实现 / 抓某个函数的函数体"，它们关心的是**逻辑还在不在**，
 * 而不是它具体躺在哪个文件里。
 *
 * 以前这些测试直接读 app.js，于是每次拆模块都要挨个改测试 ——
 * 拆一次坏一片，导致没人敢继续拆。
 *
 * 这里按 index.html 里的真实加载顺序拼接，测试就与文件划分解耦了。
 */

const fs = require('node:fs')
const path = require('node:path')

const RENDERER = path.join(__dirname, '..', '..', 'desktop', 'renderer')

/** index.html 里 <script src> 的真实顺序 */
function scriptList () {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8')
  return [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1])
}

const cache = new Map()

/** 单个文件 */
function read (name) {
  return fs.readFileSync(path.join(RENDERER, name), 'utf8')
}

/**
 * 全部渲染层脚本按加载顺序拼接。
 * 加分隔注释，方便断言失败时看出问题在哪个文件。
 */
function all () {
  if (cache.has('all')) return cache.get('all')
  const merged = scriptList()
    .map(name => '\n/* ==== ' + name + ' ==== */\n' + read(name))
    .join('\n')
  cache.set('all', merged)
  return merged
}

module.exports = { read, all, scriptList, RENDERER }
