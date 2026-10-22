'use strict'

/**
 * 静态断言：翻译链路必须有超时兜底。
 *
 * 这类不变量用运行时测不了 —— 要复现"IPC 永不返回"得主进程真的卡死。
 * 所以直接约束源码形状：`translateTextDetailed` 构造 job 时必须经过
 * `withTranslateTimeout`，超时分支必须 `pending.delete(key)`。
 *
 * 断言是**结构化的**，不是"文件里出现过这串字"：
 *   1. 抓出 translateTextDetailed 的函数体
 *   2. 断言 pix.translate(...) 被 withTranslateTimeout 包着
 *   3. 抓出 withTranslateTimeout 的函数体，断言超时分支会删 pending
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'desktop', 'guest-inject.js')

function sliceFunction(src, name) {
  const marker = 'function ' + name + '('
  const start = src.indexOf(marker)
  assert.ok(start >= 0, '找不到函数 ' + name)
  let depth = 0
  let started = false
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') { depth++; started = true }
    else if (ch === '}') {
      depth--
      if (started && depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error('函数 ' + name + ' 括号不配对')
}

test('translateTextDetailed：翻译 job 必须过看门狗', () => {
  const src = fs.readFileSync(SRC, 'utf8')
  const body = sliceFunction(src, 'translateTextDetailed')

  assert.match(body, /pix\.translate\(/, '前提变了：这里不再是 pix.translate')
  assert.match(
    body,
    /withTranslateTimeout\s*\(\s*key\s*,\s*pix\.translate\(/,
    '翻译 job 没有经过 withTranslateTimeout —— 一旦 IPC 永不返回，' +
    'pending 表会留下死 job、sendBusy 永远为 true，用户此后所有发送都被拦死'
  )
})

test('withTranslateTimeout：超时必须摘掉 pending 并给出可识别的错误码', () => {
  const src = fs.readFileSync(SRC, 'utf8')
  const body = sliceFunction(src, 'withTranslateTimeout')

  assert.match(body, /setTimeout\(/, '没有超时计时器')
  assert.match(body, /pending\.delete\(\s*key\s*\)/, '超时分支没有清理 pending —— 重试会复用同一个死 job')
  assert.match(body, /code:\s*'CLIENT_TIMEOUT'/, '超时没有专用错误码，界面会把超时说成"翻译失败"')
  assert.match(body, /clearTimeout\(/, '正常返回时没有清掉计时器，会留下一个空跑的 timer')
})

test('超时值必须宽于网络层最坏预算（避免误杀正常慢请求）', () => {
  const src = fs.readFileSync(SRC, 'utf8')
  const m = src.match(/TRANSLATE_TIMEOUT_MS\s*=\s*(\d+)\s*\*\s*(\d+)/)
  assert.ok(m, '找不到 TRANSLATE_TIMEOUT_MS 定义')
  const ms = Number(m[1]) * Number(m[2])
  assert.ok(ms >= 60 * 1000, '超时 ' + ms + 'ms 太短，会把正常的冷启动/长句请求误判成超时')
})
