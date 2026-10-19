'use strict'

/**
 * 崩溃日志上报 —— **隐私边界**的回归护栏。
 *
 * 这个模块把用户本机的日志挑一部分送上服务器。过滤写错的后果不是"功能坏了"，
 * 而是**用户隐私外泄**（WhatsApp 群名、联系人、翻译正文）。所以这里的测试
 * 重点不是"能跑通"，而是"**不该传的一个字都不能传出去**"。
 */

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  ALLOWED_SCOPES,
  pickReportableLines,
  summarize,
  findLatestLog,
  detectAbnormalExit,
  writeMarker
} = require('../desktop/crash-report')

const L = (ts, level, scope, text) => `${ts} [${level}] [${scope}] ${text}`

// ---------------------------------------------------------------------------
// 1. 白名单：只放 crash / memory
// ---------------------------------------------------------------------------

test('只保留 crash / memory，其余作用域一个都不许出去', () => {
  const text = [
    L('2026-10-19 10:00:00.000', 'ERROR', 'crash', '实例渲染进程退出：whatsapp#3 reason=oom'),
    L('2026-10-19 10:00:05.000', 'INFO ', 'memory', '整机已用 91%（7450/8192MB）'),
    // 下面这些**必须**被丢掉：含用户内容或凭据
    L('2026-10-19 10:00:10.000', 'INFO ', 'guest', '群聊「家人群」收到消息'),
    L('2026-10-19 10:00:11.000', 'INFO ', 'translate', '翻译正文：你好'),
    L('2026-10-19 10:00:12.000', 'ERROR', 'console', 'password=abc123')
  ].join('\n')

  const { lines } = pickReportableLines(text)
  assert.deepEqual(lines.map(l => l.scope), ['crash', 'memory'])
  assert.equal(lines.length, 2, '非白名单行必须全部丢弃')
})

test('白名单常量本身不得被悄悄放宽', () => {
  assert.deepEqual(ALLOWED_SCOPES, ['crash', 'memory'],
    '放宽白名单等于把用户聊天内容送上服务器，必须显式评审')
})

test('无法解析的行一律丢弃（多行堆栈可能夹带任意内容）', () => {
  const text = [
    '    at Object.<anonymous> (/app/x.js:1:1)',
    '群聊「家人群」收到消息 123456',
    L('2026-10-19 10:00:00.000', 'ERROR', 'crash', 'ok')
  ].join('\n')
  const { lines, dropped } = pickReportableLines(text)
  assert.equal(lines.length, 1)
  assert.equal(dropped, 2)
})

test('解析不了作用域就无法确认不含隐私 → 丢弃', () => {
  const { lines } = pickReportableLines('[ERROR] 没有时间戳也没有作用域')
  assert.equal(lines.length, 0)
})

// ---------------------------------------------------------------------------
// 2. 摘要
// ---------------------------------------------------------------------------

test('摘要：崩溃条数、内存峰值、原因集合', () => {
  const lines = [
    { scope: 'crash', text: '实例渲染进程退出：whatsapp#3 reason=oom exitCode=-1' },
    { scope: 'crash', text: '子进程退出：type=GPU reason=killed' },
    { scope: 'memory', text: '整机已用 85%（6996/8192MB）' },
    { scope: 'memory', text: '整机已用 93%（7600/8192MB）' },
    { scope: 'memory', text: '整机已用 71%（5800/8192MB）' }
  ]
  const s = summarize(lines)
  assert.equal(s.crashCount, 2)
  assert.equal(s.memoryPeak, 93, '取峰值而不是最后一条')
  assert.deepEqual(s.reasons.sort(), ['killed', 'oom'])
})

test('没有内存行时峰值是 null，不能是 0（0 会被误读成"内存没问题"）', () => {
  const s = summarize([{ scope: 'crash', text: 'x reason=crashed' }])
  assert.equal(s.memoryPeak, null)
})

// ---------------------------------------------------------------------------
// 3. 异常退出判定
// ---------------------------------------------------------------------------

function makeDirWithLog(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-crash-'))
  const day = '2026-10-19'
  fs.writeFileSync(path.join(dir, `hello-pix-${day}.log`), lines.join('\n') + '\n')
  return { dir, day }
}

test('日志比标记新 → 判定为异常退出', () => {
  const { dir } = makeDirWithLog([
    L('2026-10-19 10:00:00.000', 'ERROR', 'crash', '崩溃 reason=oom')
  ])
  // 标记停在更早的时间
  fs.writeFileSync(path.join(dir, 'last-clean-exit'), String(Date.parse('2026-10-18T10:00:00Z')))
  assert.ok(detectAbnormalExit(dir), '应当判定为异常退出')
})

test('标记比日志新 → 正常退出，不上报', () => {
  const { dir } = makeDirWithLog([
    L('2026-10-19 10:00:00.000', 'ERROR', 'crash', '崩溃 reason=oom')
  ])
  fs.writeFileSync(path.join(dir, 'last-clean-exit'), String(Date.parse('2026-10-20T10:00:00Z')))
  assert.equal(detectAbnormalExit(dir), null)
})

test('全新安装（有日志无标记）且日志里毫无崩溃 → 仍会上报一次', () => {
  // 这是**已知的行为**：日志里只要有 memory 行、且没有标记，就会被判定为异常退出。
  // 宁可多传一次的代价很小（数据量小、有去重），
  // 而漏传会导致"用户崩了但我们什么都不知道" —— 后者代价大得多。
  const { dir } = makeDirWithLog([
    L('2026-10-19 10:00:00.000', 'INFO ', 'memory', '整机已用 40%')
  ])
  assert.ok(detectAbnormalExit(dir))
})

test('没有任何日志文件 → 不上报（首次启动）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-crash-empty-'))
  assert.equal(detectAbnormalExit(dir), null)
})

// ---------------------------------------------------------------------------
// 4. 选文件
// ---------------------------------------------------------------------------

test('多个日志文件时选最新的那一天', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-crash-multi-'))
  fs.writeFileSync(path.join(dir, 'hello-pix-2026-10-17.log'),
    L('2026-10-17 10:00:00.000', 'ERROR', 'crash', 'old') + '\n')
  fs.writeFileSync(path.join(dir, 'hello-pix-2026-10-18.log'),
    L('2026-10-18 10:00:00.000', 'ERROR', 'crash', 'new') + '\n')
  const found = findLatestLog(dir)
  assert.ok(found)
  assert.equal(found.day, '2026-10-18')
  assert.equal(found.picked.lines[0].text, 'new')
})

test('轮转文件 .1.log 比同日的 .log 新', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-crash-rot-'))
  fs.writeFileSync(path.join(dir, 'hello-pix-2026-10-19.log'),
    L('2026-10-19 10:00:00.000', 'ERROR', 'crash', 'base') + '\n')
  fs.writeFileSync(path.join(dir, 'hello-pix-2026-10-19.log.1'),
    L('2026-10-19 11:00:00.000', 'ERROR', 'crash', 'rotated') + '\n')
  const found = findLatestLog(dir)
  assert.equal(found.picked.lines[0].text, 'rotated')
})

test('writeMarker 写得进去，readMarker 读得回来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-crash-marker-'))
  writeMarker(dir)
  const v = fs.readFileSync(path.join(dir, 'last-clean-exit'), 'utf8').trim()
  assert.ok(Number(v) > 0)
})
