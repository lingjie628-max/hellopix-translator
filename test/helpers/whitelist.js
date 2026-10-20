'use strict'

/**
 * 打包白名单（`build.files`）覆盖判断 —— 测试共用。
 *
 * ## 为什么单独抽出来
 *
 * 白名单原先逐项列文件（`"tab-budget.js"`、`"hidden-tabs.js"` …），
 * 每新增一个模块都得记得补一行，**漏了就是安装包启动即崩**
 * （main.js require 到不存在的文件 → MODULE_NOT_FOUND，窗口都建不出来）。
 * 这个坑 tab-budget / background-mode / instance-slot 都踩过。
 *
 * 现在白名单接受目录通配（`src/**\/*.js`）：模块放进对应目录就自动进包。
 * 但护栏测试不能因此失效 —— 判断必须认得通配，同时仍逐项报出漏网的文件。
 *
 * 支持 electron-builder 用到的 glob 子集：
 *   · `*`   单层任意字符（不跨 /）
 *   · `**`  跨层任意
 *   · `**\/` 零层或多层目录（`src/**\/*.js` 应匹配 `src/a.js` 与 `src/x/a.js`）
 *   · `!xxx` 排除项（不贡献覆盖）
 */

function globToRegExp (pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped
    .replace(/\*\*\//g, '\u0000')   // 先占位，避免被后面的 ** 规则吃掉
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*')
  return new RegExp('^' + body + '$')
}

/** 某一个相对路径是否被白名单覆盖。rel 用 `/` 分隔，相对 desktop/。 */
function coversFile (files, rel) {
  const list = Array.isArray(files) ? files : []
  if (list.includes(rel)) return true
  return list.some(pattern => {
    if (typeof pattern !== 'string') return false
    if (pattern.startsWith('!')) return false
    if (!pattern.includes('*')) return false
    return globToRegExp(pattern).test(rel)
  })
}

/**
 * 从 `main.js` 源码里抓出所有本地 require，返回**没被覆盖**的文件。
 *
 * @param {string} mainSrc  main.js 源码
 * @param {string[]} files  package.json 的 build.files
 * @param {function} exists  (rel) => boolean，用于跳过目录型 require
 * @returns {string[]} 漏网文件（相对 desktop/）
 */
function missingFromWhitelist (mainSrc, files, exists) {
  const re = /require\('(\.\.?\/[\w./-]+)'\)/g
  const missing = new Set()
  let m
  while ((m = re.exec(String(mainSrc || '')))) {
    let rel = m[1].replace(/^\.\//, '')
    if (rel.startsWith('../')) continue          // 指向 desktop 之外，不属于本白名单
    if (!/\.[a-z]+$/.test(rel)) rel += '.js'
    if (!rel.endsWith('.js')) continue
    if (typeof exists === 'function' && !exists(rel)) continue   // 目录型 require 跳过
    if (!coversFile(files, rel)) missing.add(rel)
  }
  return [...missing]
}

module.exports = { coversFile, globToRegExp, missingFromWhitelist }
