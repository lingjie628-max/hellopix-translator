'use strict'

/**
 * 崩溃上报的**服务端**行为与跨进程契约。
 *
 * ## 和 crash-report.test.js 的分工
 *
 * 那个文件测客户端怎么挑行（`pickReportableLines`），
 * 这个文件测服务端怎么处理收到的行 —— 以及两端的过滤规则**是否仍然一致**。
 *
 * 两端各有一份 `['crash','memory']`。源码里靠注释互相提醒"保持一致"，
 * 但注释拦不住任何人。两边漂移的后果：
 *
 *   - 都放宽   → 用户聊天内容被传上服务器
 *   - 服务端更严 → 客户端挑好的行被二次丢弃，看着"上报成功"库里却是空的
 *   - 服务端更松 → 改个客户端就能把任意作用域写进库
 *
 * 所以这里直接 require 两边的模块，逐个常量比对。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  CrashReportService,
  parseLines,
  summarize,
  ALLOWED_SCOPES,
  MAX_LINES,
  MAX_LINE_CHARS
} = require('../server/services/crash-report-service')

const client = require('../desktop/src/stability/crash-report')

// ---------------------------------------------------------------- 跨进程契约

test('白名单必须与客户端逐字一致', () => {
  assert.deepEqual(ALLOWED_SCOPES, client.ALLOWED_SCOPES,
    '服务端与客户端的作用域白名单不一致 —— 一边放宽就是把用户隐私送出去')
})

test('行数上限必须与客户端一致', () => {
  // 服务端更严会让客户端挑好的行被二次丢弃；更松则挡不住改过的客户端。
  assert.equal(MAX_LINES, client.MAX_LINES,
    '行数上限不一致：客户端按 200 行裁剪，服务端若更小会静默丢尾部（崩溃现场就在尾部）')
})

test('单行字符上限必须与客户端一致', () => {
  assert.equal(MAX_LINE_CHARS, client.MAX_LINE_CHARS,
    '单行上限不一致：服务端更小会截掉崩溃堆栈的关键帧')
})

// ---------------------------------------------------------------- 过滤规则

test('只保留 crash / memory，其余作用域一个都不留', () => {
  const lines = parseLines(JSON.stringify([
    { at: '2026-10-19T09:57:01', scope: 'crash', text: 'boom' },
    { at: '2026-10-19T09:57:02', scope: 'memory', text: '整机已用 80%' },
    { at: '2026-10-19T09:57:03', scope: 'message', text: '客户名字：张三' },
    { at: '2026-10-19T09:57:04', scope: 'network', text: 'GET https://x' }
  ]))
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map(l => l.scope), ['crash', 'memory'])
  // 正文绝不能出现在结果里 —— 这是隐私边界的本体
  assert.ok(!JSON.stringify(lines).includes('张三'), '业务日志内容漏进了上报结果')
})

test('作用域大小写敏感，Crash 不算 crash', () => {
  assert.equal(parseLines(JSON.stringify([{ scope: 'Crash', text: 'x' }])).length, 0)
  assert.equal(parseLines(JSON.stringify([{ scope: 'CRASH', text: 'x' }])).length, 0)
})

test('未知作用域被丢弃后，数量上限按"已过滤的行"算', () => {
  // 先塞满垃圾再塞真货：如果上限在过滤**之前**生效，
  // 垃圾会把 200 行的额度占光，真数据一条都进不来。
  const junk = Array.from({ length: MAX_LINES }, (_, i) => ({ scope: 'junk', text: `j${i}` }))
  const real = Array.from({ length: 5 }, (_, i) => ({ scope: 'crash', text: `real${i}` }))
  const lines = parseLines(JSON.stringify([...junk, ...real]))
  assert.equal(lines.length, 5, '上限在过滤之前生效了，真数据被垃圾挤掉')
  assert.ok(lines.every(l => l.scope === 'crash'))
})

test('超过上限时保留末行（崩溃现场）而不是首行', () => {
  const rows = Array.from({ length: MAX_LINES + 50 }, (_, i) => ({ scope: 'crash', text: `line${i}` }))
  const lines = parseLines(JSON.stringify(rows))
  assert.equal(lines.length, MAX_LINES)
  assert.equal(lines[lines.length - 1].text, `line${rows.length - 1}`, '尾部（崩溃现场）被裁掉了')
  assert.equal(lines[0].text, 'line50', '应从第 50 条开始保留')
})

test('单行超长被截断，不采信客户端已截断的假设', () => {
  const long = 'x'.repeat(5000)
  const lines = parseLines(JSON.stringify([{ scope: 'crash', text: long }]))
  assert.equal(lines[0].text.length, MAX_LINE_CHARS)
})

test('at 字段超长被截断（不能借时间戳字段塞正文）', () => {
  const lines = parseLines(JSON.stringify([{ scope: 'crash', at: 'y'.repeat(500), text: 'x' }]))
  assert.equal(lines[0].at.length, 32)
})

test('畸形 JSON / 非数组 / null 都返回空数组，不抛异常', () => {
  for (const bad of ['{不是JSON', '{"a":1}', 'null', '42', '', null, undefined, {}]) {
    assert.deepEqual(parseLines(bad), [], `输入 ${JSON.stringify(bad)} 应返回空数组`)
  }
})

test('数组里的非对象元素被跳过', () => {
  const lines = parseLines(JSON.stringify([null, 'str', 42, { scope: 'crash', text: 'ok' }]))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].text, 'ok')
})

test('已经是数组时直接处理（兼容 JSON 客户端）', () => {
  const lines = parseLines([{ scope: 'crash', text: 'ok' }])
  assert.equal(lines.length, 1)
})

// ---------------------------------------------------------------- 摘要

test('摘要：崩溃条数与原因集合', () => {
  const s = summarize(parseLines(JSON.stringify([
    { at: '2026-10-19T09:57:01', scope: 'crash', text: 'uncaught reason=gpu-crash at x' },
    { at: '2026-10-19T09:57:02', scope: 'crash', text: 'uncaught reason=oom' },
    { at: '2026-10-19T09:57:03', scope: 'crash', text: 'same reason=gpu-crash' }
  ])))
  assert.equal(s.crashCount, 3)
  // 重复原因只收一次，否则库里 reasons 数组会有几十个同名的
  assert.deepEqual(s.reasons.sort(), ['gpu-crash', 'oom'])
})

test('内存峰值取最大值，且不把 crash 行里的百分比算进去', () => {
  const s = summarize(parseLines(JSON.stringify([
    { at: '2026-10-19T09:57:01', scope: 'memory', text: '整机已用 60%' },
    { at: '2026-10-19T09:57:02', scope: 'crash', text: '崩溃时整机已用 99%' },
    { at: '2026-10-19T09:57:03', scope: 'memory', text: '整机已用 75%' }
  ])))
  assert.equal(s.memoryPeak, 75, 'crash 行里的百分比不属于内存探针数据')
})

test('没有内存行时峰值是 null 而不是 0', () => {
  const s = summarize(parseLines(JSON.stringify([{ scope: 'crash', text: 'boom' }])))
  assert.equal(s.memoryPeak, null, '0 会被误读成"内存一点没涨"')
})

test('crashedAt 取最后一行的时间；解析不了给 null 而不是"现在"', () => {
  const ok = summarize(parseLines(JSON.stringify([
    { at: '2026-10-19T09:00:00', scope: 'crash', text: 'a' },
    { at: '2026-10-19T09:05:00', scope: 'crash', text: 'b' }
  ])))
  assert.ok(ok.crashedAt instanceof Date)
  // 没有时区后缀的字符串，Date.parse 按**本地时间**解析。
  // 所以这里比时间戳，不比 toISOString —— 后者会随运行机器的时区漂，
  // 那种断言在 CI（UTC）和开发机（UTC-4）上会得出不同结果。
  assert.equal(ok.crashedAt.getTime(), Date.parse('2026-10-19T09:05:00'))

  const bad = summarize(parseLines(JSON.stringify([
    { at: 'not-a-date', scope: 'crash', text: 'a' }
  ])))
  assert.equal(bad.crashedAt, null,
    '编一个"现在"当崩溃时间会让去重键 (device_id, crashed_at) 失效，同一崩溃反复入库')
})

// ---------------------------------------------------------------- 落库

function fakeRepo({ returned = [{ id: 1 }] } = {}) {
  const calls = []
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values })
      return { rows: returned }
    }
  }
}

test('没有可存内容时不碰数据库', async () => {
  const repo = fakeRepo()
  const result = await new CrashReportService(repo).submit({ lines: '[]' })
  assert.deepEqual(result, { stored: false, crashCount: 0, memoryPeak: null })
  assert.equal(repo.calls.length, 0, '空上报不该产生一次 INSERT')
})

test('正常上报落库，字段逐个截断', async () => {
  const repo = fakeRepo()
  const result = await new CrashReportService(repo).submit({
    lines: JSON.stringify([{ at: '2026-10-19T09:57:01', scope: 'crash', text: 'boom reason=oom' }]),
    data: { version: 'v'.repeat(100), platform: 'p'.repeat(100), arch: 'a'.repeat(100) },
    user: { id: 7, username: 'u'.repeat(100) },
    deviceId: 'd'.repeat(200)
  })

  assert.equal(result.stored, true)
  assert.equal(result.crashCount, 1)

  const [, values] = [repo.calls[0].sql, repo.calls[0].values]
  const [userId, deviceId, username, version, platform, arch, crashedAt] = values
  assert.equal(userId, 7)
  assert.equal(deviceId.length, 64, 'deviceId 没截断 —— 可以往库里塞正文')
  assert.equal(username.length, 64)
  assert.equal(version.length, 32)
  assert.equal(platform.length, 16)
  assert.equal(arch.length, 16)
  assert.equal(crashedAt, new Date(Date.parse('2026-10-19T09:57:01')).toISOString(),
    '落库的必须是 ISO 字符串（无时区后缀的输入按本地时间解析，这里跟着算，不写死 UTC）')
})

test('未登录也能上报（崩溃常发生在登录前）', async () => {
  const repo = fakeRepo()
  const result = await new CrashReportService(repo).submit({
    lines: JSON.stringify([{ at: '2026-10-19T09:57:01', scope: 'crash', text: 'boom' }]),
    user: null,
    deviceId: 'dev-1'
  })
  assert.equal(result.stored, true)
  const values = repo.calls[0].values
  assert.equal(values[0], null, '未登录时 user_id 应为 null')
  assert.equal(values[2], '', '未登录时 username 应为空串')
})

test('重复上报被去重时 stored=false，但摘要是真实的', async () => {
  // ON CONFLICT DO NOTHING 时 RETURNING 为空，rows 是空数组 ——
  // 这不是失败，是"这台设备这条崩溃已经记过了"。
  const repo = fakeRepo({ returned: [] })
  const result = await new CrashReportService(repo).submit({
    lines: JSON.stringify([{ at: '2026-10-19T09:57:01', scope: 'crash', text: 'boom' }])
  })
  assert.equal(result.stored, false)
  assert.equal(result.crashCount, 1, '去重不该把摘要清零 —— 客户端会以为没解析到内容')
})

test('去重键要求 crashed_at 非空，SQL 必须带部分索引条件', async () => {
  const repo = fakeRepo()
  await new CrashReportService(repo).submit({
    lines: JSON.stringify([{ at: '2026-10-19T09:57:01', scope: 'crash', text: 'boom' }])
  })
  assert.match(repo.calls[0].sql, /ON CONFLICT \(device_id, crashed_at\) WHERE crashed_at IS NOT NULL/,
    'crashed_at 可空，普通唯一索引对 NULL 不生效 —— ON CONFLICT 找不到匹配索引会直接报错')
})

test('构造时没有 repo.query 直接报错', () => {
  assert.throws(() => new CrashReportService({}), TypeError)
  assert.throws(() => new CrashReportService(null), TypeError)
})
