'use strict'

/**
 * 从 asar 里解出一个文件 —— 用来对**发布字节**跑链路验证，而不是只验源码。
 *
 * 只对源码跑等于"验的是 A、发的是 B"，正是 0.1.12 那次事故的形态。
 *
 * 用法：
 *   node scripts/extract-asar-file.js <app.asar> <内部路径> [输出路径]
 * 例：
 *   node scripts/extract-asar-file.js \
 *     "desktop/release/win-unpacked/resources/app.asar" guest-inject.js /tmp/pix-guest.js
 *
 * asar 偏移推算与 scripts/verify-preload-load.js 保持**同一套实现**，
 * 避免两个工具对同一份产物得出不同结论。
 */

const fs = require('node:fs')

function readAsar (asarPath) {
  const buf = fs.readFileSync(asarPath)
  const jsonStart = buf.indexOf(Buffer.from('{"files":'))
  if (jsonStart < 0) throw new Error('不是合法的 asar（找不到头）')
  let depth = 0; let end = -1; let inStr = false; let esc = false
  for (let i = jsonStart; i < buf.length; i++) {
    const c = buf[i]
    if (inStr) { if (esc) esc = false; else if (c === 0x5c) esc = true; else if (c === 0x22) inStr = false; continue }
    if (c === 0x22) { inStr = true; continue }
    if (c === 0x7b) depth++
    else if (c === 0x7d) { depth--; if (depth === 0) { end = i + 1; break } }
  }
  if (end < 0) throw new Error('asar 头解析失败')
  const header = JSON.parse(buf.subarray(jsonStart, end).toString('utf8'))
  const dataStart = jsonStart + (((end - jsonStart) + 3) & ~3)

  const index = new Map()
  const walk = (node, prefix) => {
    for (const key of Object.keys(node.files || {})) {
      const entry = node.files[key]
      const full = prefix + '/' + key
      if (entry.files) walk(entry, full)
      else index.set(full, entry)
    }
  }
  walk(header, '')
  return {
    read: (name) => {
      const entry = index.get('/' + String(name).replace(/^\//, ''))
      if (!entry) return null
      const off = dataStart + Number(entry.offset)
      return buf.subarray(off, off + Number(entry.size)).toString('utf8')
    }
  }
}

const asarPath = process.argv[2]
const inner = process.argv[3]
const outPath = process.argv[4]
if (!asarPath || !inner) {
  console.error('用法：node scripts/extract-asar-file.js <app.asar> <内部路径> [输出路径]')
  process.exit(2)
}
const text = readAsar(asarPath).read(inner)
if (text == null) {
  console.error('asar 里找不到：' + inner)
  process.exit(1)
}
if (outPath) {
  fs.writeFileSync(outPath, text)
  console.log('已写出 ' + outPath + '（' + text.length + ' 字节，来源 ' + asarPath + '）')
} else {
  process.stdout.write(text)
}
