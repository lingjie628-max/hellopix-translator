'use strict'

/**
 * 客户端日志落盘测试。
 *
 * ## 被测的风险
 *
 * 日志是个"写不好反而有害"的东西，这里守住四件事：
 *
 * 1. **脱敏** 这是多开翻译工具，日志一旦混进商户凭据就是安全事故。
 *    测试里逐条钉住 password / token / Bearer / 邮箱 / 手机号 / 长随机串。
 * 2. **崩溃前必须落盘** uncaughtException 之后进程随时消失，
 *    所以 fatal 走同步写 —— 否则最该留下的那条恰恰留不下。
 * 3. **不能写爆用户磁盘** 按天切分 + 只留最近若干天 + 单文件体积上限。
 * 4. **日志自身故障不能拖垮客户端** 磁盘满 / 无权限时只上报，
 *    绝不向外抛异常。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { EventEmitter } = require('node:events')

const {
  KEEP_DAYS,
  redact,
  logFileName,
  logFileDate,
  logFileIndex,
  filesToPrune,
  safeMessage,
  formatLine,
  rotatedName,
  createLogger,
  installConsoleBridge,
  attachProcessHandlers
} = require('../desktop/log-file')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hello-pix-log-'))
}

/* ---------------------------------------------------------------- 文件命名 */

test('日志文件名按本地日期切分，且可反解', () => {
  const d = new Date(2026, 8, 25, 15, 4, 5)
  assert.equal(logFileName(d), 'hello-pix-2026-09-25.log')

  const back = logFileDate('hello-pix-2026-09-25.log')
  assert.equal(back.getFullYear(), 2026)
  assert.equal(back.getMonth(), 8)
  assert.equal(back.getDate(), 25)
})

test('轮转后的 .1 .2 后缀同样能反解出日期', () => {
  // 这一条曾经漏了：反解只认 .log 结尾，导致轮转文件永远清理不掉
  assert.equal(logFileDate('hello-pix-2026-09-25.log.3').getDate(), 25)
  assert.equal(logFileIndex('hello-pix-2026-09-25.log'), 0)
  assert.equal(logFileIndex('hello-pix-2026-09-25.log.3'), 3)
})

test('不属于本模块的文件一律不认（避免误删用户自己放的东西）', () => {
  for (const name of ['notes.txt', 'hello-pix.log', 'hello-pix-20260925.log',
    'other-2026-09-25.log', 'hello-pix-2026-09-25.txt', '']) {
    assert.equal(logFileDate(name), null, name)
  }
})

/* ---------------------------------------------------------------- 保留策略 */

test('只保留最近 N 天，更早的删掉', () => {
  const today = new Date(2026, 8, 25)
  const names = [
    'hello-pix-2026-09-25.log',   // 今天，留
    'hello-pix-2026-09-24.log',   // 昨天，留
    'hello-pix-2026-09-19.log',   // 第 6 天，留（KEEP_DAYS=7 含今天）
    'hello-pix-2026-09-18.log',   // 第 7 天，删
    'hello-pix-2026-08-01.log',   // 更早，删
    'hello-pix-2026-09-18.log.2', // 轮转文件，同样按日期删
    'notes.txt'                   // 不是日志，不碰
  ]
  const doomed = filesToPrune(names, today, KEEP_DAYS)
  assert.deepEqual(doomed.sort(), [
    'hello-pix-2026-08-01.log',
    'hello-pix-2026-09-18.log',
    'hello-pix-2026-09-18.log.2'
  ])
  assert.ok(!doomed.includes('notes.txt'))
})

test('保留天数可调，且 0 天表示只留今天', () => {
  const today = new Date(2026, 8, 25)
  const names = ['hello-pix-2026-09-25.log', 'hello-pix-2026-09-24.log']
  assert.deepEqual(filesToPrune(names, today, 0), ['hello-pix-2026-09-24.log'])
})

/* ---------------------------------------------------------------- 脱敏 */

test('凭据键值对被脱敏', () => {
  assert.ok(!redact('password=Share-9!').includes('Share-9!'))
  assert.ok(!redact('token: abcdefghijklmnop').includes('abcdefghijklmnop'))
  assert.ok(!redact('shareToken=xyzsecretvalue').includes('xyzsecretvalue'))
  assert.ok(!redact('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6').includes('eyJhbGciOiJIUzI1NiIsInR5cCI6'))
  assert.ok(!redact('https://api.x.com/y?token=abcdef123456&z=1').includes('abcdef123456'))
})

test('邮箱与手机号保留可辨识位，其余打码', () => {
  const mail = redact('联系 zhang.san@example.com 处理')
  assert.ok(mail.includes('@example.com'))
  assert.ok(!mail.includes('hang.san'), '邮箱本地部分不应完整保留')

  const phone = redact('手机 13812345678')
  assert.ok(!phone.includes('13812345678'))
  assert.ok(phone.includes('138'), '应保留前三位便于定位')
})

test('长随机串（疑似 token/hash）被整体替换', () => {
  const token = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'
  assert.ok(!redact('session=' + token).includes(token))
})

test('普通文本不被误伤', () => {
  const text = '托盘创建失败，将退化为关闭即退出：Cannot find module'
  assert.equal(redact(text), text)
})

/* ---------------------------------------------------------------- 单行化 */

test('多行错误被压成一行，且带上堆栈', () => {
  const err = new Error('boom')
  const line = safeMessage(err)
  assert.ok(line.includes('boom'))
  assert.ok(line.includes('Error'))
  assert.ok(!line.includes('\n'), '必须单行，否则日志会被一条错误切得七零八落')
})

test('超长内容被截断，避免单条把文件撑爆', () => {
  const line = safeMessage('x'.repeat(20000))
  assert.ok(line.length < 5000, '实际长度 ' + line.length)
  assert.ok(line.includes('已截断'))
})

test('循环引用的对象不会抛异常', () => {
  const a = {}
  a.self = a
  assert.doesNotThrow(() => safeMessage(a))
})

test('formatLine 带时间戳、级别与作用域', () => {
  const line = formatLine('warn', 'tray', '托盘创建失败', new Date(2026, 8, 25, 9, 8, 7, 6))
  assert.equal(line, '2026-09-25 09:08:07.006 [WARN ] [tray] 托盘创建失败\n')
})

/* ---------------------------------------------------------------- 写入 */

test('正常日志异步落盘，flush 后可见', async () => {
  const dir = tempDir()
  const log = createLogger(dir)
  log.info('app', '启动完成')
  log.warn('tray', '托盘创建失败')
  await log.flush()

  const file = path.join(dir, logFileName(new Date()))
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.includes('[INFO ] [app] 启动完成'))
  assert.ok(text.includes('[WARN ] [tray] 托盘创建失败'))
})

test('fatal 同步落盘：不 flush 也必须已经写进去', () => {
  const dir = tempDir()
  const log = createLogger(dir)
  log.fatal('crash', '主进程未捕获异常')
  // 刻意不调用 flush —— 模拟进程下一刻就消失
  const text = fs.readFileSync(path.join(dir, logFileName(new Date())), 'utf8')
  assert.ok(text.includes('[FATAL] [crash] 主进程未捕获异常'))
})

test('单文件超过上限后轮转到 .1，且旧内容不丢', async () => {
  const dir = tempDir()
  const log = createLogger(dir, { maxBytes: 200 })
  for (let i = 0; i < 12; i += 1) log.info('t', '第 ' + i + ' 条日志-' + 'x'.repeat(30))
  await log.flush()

  const names = fs.readdirSync(dir).sort()
  assert.ok(names.includes(logFileName(new Date())), '当前文件应存在')
  assert.ok(names.some(n => n.endsWith('.log.1')), '应产生轮转文件，实际：' + names.join(', '))
})

test('换天时自动清理过期文件', async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'hello-pix-2020-01-01.log'), '很久以前\n')
  fs.writeFileSync(path.join(dir, 'notes.txt'), '别删我\n')

  let clock = new Date(2026, 8, 25, 23, 59)
  const log = createLogger(dir, { now: () => clock, keepDays: 7 })
  log.info('app', '第一条')
  await log.flush()

  // 跨到第二天：应触发清理
  clock = new Date(2026, 8, 26, 0, 1)
  log.info('app', '跨天后的第一条')
  await log.flush()

  const names = fs.readdirSync(dir)
  assert.ok(!names.includes('hello-pix-2020-01-01.log'), '过期日志应被删除')
  assert.ok(names.includes('notes.txt'), '非日志文件不能被删')
  assert.ok(names.includes('hello-pix-2026-09-26.log'), '新的一天应建新文件')
})

test('日志目录不可写时只上报，不向外抛异常', async () => {
  // 用一个"路径被普通文件占住"的目录制造失败，比改权限更稳定
  const dir = tempDir()
  const blocked = path.join(dir, 'logs')
  fs.writeFileSync(blocked, 'I am a file, not a directory')

  const errors = []
  const log = createLogger(blocked, { onError: e => errors.push(e) })
  assert.doesNotThrow(() => log.info('app', '写不进去'))
  assert.doesNotThrow(() => log.fatal('crash', '写不进去'))
  await log.flush()
  assert.ok(errors.length >= 1, '应通过 onError 上报')
})

test('redact 兜底：写入的凭据不会出现在文件里', async () => {
  const dir = tempDir()
  const log = createLogger(dir)
  log.error('net', '请求失败 token=SuperSecretValue123456 password=Pw123456')
  await log.flush()
  const text = fs.readFileSync(path.join(dir, logFileName(new Date())), 'utf8')
  assert.ok(!text.includes('SuperSecretValue123456'))
  assert.ok(!text.includes('Pw123456'))
})

/* ---------------------------------------------------------------- console 桥 */

test('console 桥既落盘又保留原有控制台输出', async () => {
  const dir = tempDir()
  const log = createLogger(dir)
  const fake = { calls: [], log(...a) { this.calls.push(['log', a]) }, error(...a) { this.calls.push(['error', a]) } }

  installConsoleBridge(fake, log)
  fake.log('托盘已就绪')
  fake.error('[hello-pix] 托盘创建失败，将退化为关闭即退出：', new Error('no tray'))
  await log.flush()

  const text = fs.readFileSync(path.join(dir, logFileName(new Date())), 'utf8')
  assert.ok(text.includes('托盘已就绪'))
  assert.ok(text.includes('托盘创建失败'))
  assert.ok(text.includes('no tray'), 'Error 参数应被展开记录')

  assert.equal(fake.calls.length, 2, '原有控制台行为必须保留')
  assert.equal(fake.calls[0][0], 'log')
  assert.equal(fake.calls[1][0], 'error')
})

/* ---------------------------------------------------------------- 进程钩子 */

test('uncaughtException 记 fatal 并退出', () => {
  const dir = tempDir()
  const log = createLogger(dir)
  const proc = new EventEmitter()
  const exits = []
  attachProcessHandlers(proc, log, { exit: code => exits.push(code), flush: () => log.flush() })

  proc.emit('uncaughtException', new Error('主进程炸了'))

  const text = fs.readFileSync(path.join(dir, logFileName(new Date())), 'utf8')
  assert.ok(text.includes('[FATAL] [crash]'))
  assert.ok(text.includes('主进程炸了'))
  assert.deepEqual(exits, [1], '未捕获异常后必须退出，不能留下状态不可信的进程')
})

test('unhandledRejection 只记录，不退出（不该把在用的客户端关掉）', async () => {
  const dir = tempDir()
  const log = createLogger(dir)
  const proc = new EventEmitter()
  const exits = []
  const seen = []
  attachProcessHandlers(proc, log, {
    exit: code => exits.push(code),
    onUnhandled: reason => seen.push(reason)
  })

  proc.emit('unhandledRejection', new Error('没接住的 Promise'))
  await log.flush() // 这一条走的是异步写入，读文件前必须等落盘

  const text = fs.readFileSync(path.join(dir, logFileName(new Date())), 'utf8')
  assert.ok(text.includes('[ERROR] [crash]'))
  assert.ok(text.includes('没接住的 Promise'))
  assert.deepEqual(exits, [], '未处理的 Promise 不应导致退出')
  assert.equal(seen.length, 1)
})

test('日志自身抛出时不会冒泡到调用方', async () => {
  const dir = tempDir()
  const log = createLogger(dir)
  const broken = {
    write() { throw new Error('磁盘满了') },
    on() { return this },
    end(cb) { if (cb) cb() }
  }
  const realCreate = fs.createWriteStream
  fs.createWriteStream = () => broken
  try {
    assert.doesNotThrow(() => log.info('app', '这条会失败'))
    await log.flush()
  } finally {
    fs.createWriteStream = realCreate
  }
})

test('rotatedName 只给轮转文件加后缀', () => {
  assert.equal(rotatedName('hello-pix-2026-09-25.log', 0), 'hello-pix-2026-09-25.log')
  assert.equal(rotatedName('hello-pix-2026-09-25.log', 2), 'hello-pix-2026-09-25.log.2')
})
