'use strict'
/**
 * 客户端日志落盘。
 *
 * 为什么需要它：客户端此前**不写任何日志**。于是这些情况全都没有痕迹 ——
 * 主进程抛异常、渲染进程被杀、翻译静默失败、托盘创建失败。
 * 排查只能靠用户截图，或者让用户复述"当时点了什么"。
 *
 * 三条设计原则：
 *
 * 1. **绝不记录聊天内容与凭据**
 *    这是多开翻译工具，日志里如果混进客户对话原文或登录 token，
 *    等于把商户的客户资料和账号凭据写到了本机明文文件里。
 *    所以：内容一律不记（在调用处就不传），凭据在这里统一脱敏兜底。
 *
 * 2. **正常日志走写入流，致命错误走同步写**
 *    正常日志用 fs.createWriteStream 异步落盘，不阻塞 UI 线程；
 *    而 uncaughtException 之后进程随时可能消失，必须 appendFileSync 同步写，
 *    否则最该留下的那条恰恰留不下。
 *
 * 3. **按天切分 + 只保留最近若干天**
 *    单个文件设体积上限，超限就切到 .1 .2 后缀，
 *    避免一个跑几个月的客户端攒出几百 MB 日志把用户磁盘写满。
 *
 * 依赖注入的形式（目录显式传入、console/process 作为参数）是为了让这些
 * 逻辑可以在不启动 Electron 的情况下被测试 —— 见 test/desktop-log-file.test.js。
 */
const fs = require('fs')
const path = require('path')

const KEEP_DAYS = 7
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_LINE_CHARS = 4000
const FILE_PREFIX = 'hello-pix-'
const FILE_SUFFIX = '.log'

const LEVELS = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR', fatal: 'FATAL' }

/* ---------------------------------------------------------------- 脱敏 */

// 宁可多脱一点，也不要漏。命中即替换为掩码，保留少量首尾便于人工比对。
//
// **顺序有讲究**：具体形态的规则必须排在通用键值对规则之前。
// 反过来写会漏 —— 通用规则会把 `Authorization: Bearer xxx` 的 `Bearer`
// 当成值吃掉，于是 Bearer 规则再也匹配不上，剩下的 token 就留在日志里了。
const REDACTIONS = [
  // Bearer / Basic 认证头（必须先于通用键值对规则）
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme) => scheme + ' <已脱敏>'],
  // JWT：三段 base64url 用点连接，形态很好认
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?/g, '<已脱敏JWT>'],
  // password / token / secret / cookie / authorization 之类的键值对
  [/((?:password|passwd|pwd|token|secret|cookie|authorization|apikey|api_key|shareToken|sharePassword)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi,
    (_m, key) => key + '<已脱敏>'],
  // URL 里的查询参数同样可能带凭据
  [/([?&](?:token|password|pwd|secret|key)=)[^&\s]+/gi, (_m, key) => key + '<已脱敏>'],
  // 邮箱：保留首字与域名，便于判断是谁的问题
  [/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (_m, a, d) => a + '***' + d],
  // 中国大陆手机号
  [/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, (_m, a, b) => a + '****' + b],
  // 长随机串（可能是 session / token / hash）：连续 24 位以上无空格的字母数字
  [/\b[A-Za-z0-9_-]{24,}\b/g, '<已脱敏长串>']
]

function redact(text) {
  let out = String(text == null ? '' : text)
  for (const [pattern, replacer] of REDACTIONS) {
    out = out.replace(pattern, replacer)
  }
  return out
}

/* ---------------------------------------------------------------- 纯函数 */

function pad(n, width) {
  return String(n).padStart(width, '0')
}

/** 本地日期 → 文件名。按**本地**日期切分，用户看日志时和"今天"对得上。 */
function logFileName(date) {
  const d = date instanceof Date ? date : new Date(date)
  return FILE_PREFIX + d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' +
    pad(d.getDate(), 2) + FILE_SUFFIX
}

/** 从文件名还原日期；不是本模块的日志文件时返回 null（含 .1 .2 轮转后缀）。 */
function logFileDate(name) {
  const m = /^hello-pix-(\d{4})-(\d{2})-(\d{2})\.log(?:\.(\d+))?$/.exec(String(name || ''))
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

/** 轮转序号：无名后缀视为 0，便于比较“同一天的第几段”。 */
function logFileIndex(name) {
  const m = /\.log\.(\d+)$/.exec(String(name || ''))
  return m ? Number(m[1]) : 0
}

/**
 * 该删哪些日志文件。保留「含今天共 keepDays 天」，更早的删掉；
 * 不是本模块命名的文件一律**不碰** —— 用户往这个目录里放别的东西不该被误删。
 *
 * 注意是 keepDays - 1：keepDays=7 表示今天 + 前 6 天共 7 天，
 * 不是"今天往前数 7 天"（那样会留下 8 天）。
 * keepDays<=1 时退化为只留今天。
 */
function filesToPrune(names, today, keepDays) {
  const base = today instanceof Date ? today : new Date(today)
  const days = Number.isFinite(keepDays) ? keepDays : KEEP_DAYS
  const cutoff = new Date(base.getFullYear(), base.getMonth(), base.getDate())
  cutoff.setDate(cutoff.getDate() - Math.max(days - 1, 0))
  const doomed = []
  for (const name of names || []) {
    const d = logFileDate(name)
    if (d && d < cutoff) doomed.push(name)
  }
  return doomed
}

/** 把任意值安全地压成一行有长度上限的字符串（避免把整个对象灌进日志）。 */
function safeMessage(value) {
  let text
  if (value instanceof Error) {
    text = (value.stack || (value.name + ': ' + value.message)) + ''
  } else if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch (e) {
      text = String(value)
    }
  }
  if (text == null) text = String(value)
  text = text.replace(/\r?\n/g, ' ⏎ ')
  if (text.length > MAX_LINE_CHARS) {
    text = text.slice(0, MAX_LINE_CHARS) + '…[已截断 ' + (text.length - MAX_LINE_CHARS) + ' 字]'
  }
  return redact(text)
}

function formatLine(level, scope, message, date) {
  const d = date instanceof Date ? date : new Date()
  const stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) +
    ' ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) +
    '.' + pad(d.getMilliseconds(), 3)
  const lv = LEVELS[level] || LEVELS.info
  const sc = scope ? '[' + String(scope).replace(/[\[\]]/g, '') + '] ' : ''
  return stamp + ' [' + lv + '] ' + sc + safeMessage(message) + '\n'
}

/** 超过上限就换到 .1 / .2 … 后缀，返回当前应写入的文件名。 */
function rotatedName(name, suffixIndex) {
  if (!suffixIndex) return name
  return name + '.' + suffixIndex
}

/* ---------------------------------------------------------------- 日志器 */

/**
 * @param {string} dir      日志目录（主进程传 app.getPath('userData')/logs）
 * @param {object} [options] keepDays / maxBytes / now（测试用）
 */
function createLogger(dir, options) {
  const opts = options || {}
  const keepDays = Number.isFinite(opts.keepDays) ? opts.keepDays : KEEP_DAYS
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : MAX_FILE_BYTES
  const now = opts.now || (() => new Date())
  const onError = opts.onError || (() => {})

  let stream = null
  let streamDay = ''
  let streamIndex = 0
  let streamBytes = 0
  let disabled = false
  let dirReady = false

  function ensureDir() {
    if (dirReady) return true
    fs.mkdirSync(dir, { recursive: true })
    dirReady = true
    return true
  }

  function openStream(day, index, append) {
    const file = path.join(dir, rotatedName(FILE_PREFIX + day + FILE_SUFFIX, index))
    let size = 0
    try {
      if (append) size = fs.statSync(file).size
    } catch (e) {
      size = 0
    }
    stream = fs.createWriteStream(file, { flags: 'a' })
    stream.on('error', error => {
      // 磁盘满 / 权限不足：日志写不下去时**不能让主流程跟着崩**
      disabled = true
      onError(error)
    })
    streamDay = day
    streamIndex = index
    streamBytes = size
    return file
  }

  function ensureStream(d) {
    const day = logFileName(d).slice(FILE_PREFIX.length, -FILE_SUFFIX.length)
    if (stream && streamDay === day) return
    if (stream) {
      try { stream.end() } catch (e) {}
      stream = null
    }
    // 换天了：顺手清理过期文件，不必另起定时器
    try {
      const names = fs.readdirSync(dir)
      for (const name of filesToPrune(names, d, keepDays)) {
        try { fs.unlinkSync(path.join(dir, name)) } catch (e) {}
      }
    } catch (e) {
      // 目录还不存在等情况：下面 mkdir 会处理
    }
    openStream(day, 0, true)
  }

  function write(level, scope, message) {
    const d = now()
    const line = formatLine(level, scope, message, d)
    // 致命错误必须同步落盘：之后进程可能立刻消失
    if (level === 'fatal') {
      try {
        ensureDir()
        fs.appendFileSync(path.join(dir, logFileName(d)), line)
      } catch (e) {
        onError(e)
      }
      return line
    }
    if (disabled) return line
    try {
      ensureDir()
      ensureStream(d)
      if (streamBytes + Buffer.byteLength(line) > maxBytes) {
        try { stream.end() } catch (e) {}
        stream = null
        openStream(streamDay, streamIndex + 1, false)
      }
      if (stream) {
        stream.write(line)
        streamBytes += Buffer.byteLength(line)
      }
    } catch (e) {
      disabled = true
      onError(e)
    }
    return line
  }

  return {
    dir: dir,
    get file() {
      return path.join(dir, rotatedName(FILE_PREFIX + (streamDay || '') + FILE_SUFFIX, streamIndex))
    },
    debug: (scope, msg) => write('debug', scope, msg),
    info: (scope, msg) => write('info', scope, msg),
    warn: (scope, msg) => write('warn', scope, msg),
    error: (scope, msg) => write('error', scope, msg),
    fatal: (scope, msg) => write('fatal', scope, msg),
    flush() {
      return new Promise(resolve => {
        if (!stream) return resolve()
        const s = stream
        stream = null
        s.end(() => resolve())
      })
    }
  }
}

/* ---------------------------------------------------------------- 接线 */

/**
 * 把已有的 console.* 输出接进日志文件。
 * 这样 main.js 里那些 `console.error('[hello-pix] 托盘创建失败…')`
 * 不需要逐条改写就自动落盘 —— 改动面最小，覆盖最全。
 * 原来的输出行为**保持不变**（控制台照常打印）。
 */
function installConsoleBridge(target, logger) {
  const originals = {}
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = typeof target[level] === 'function' ? target[level].bind(target) : null
  }
  const map = { log: 'info', info: 'info', debug: 'debug', warn: 'warn', error: 'error' }
  for (const level of Object.keys(map)) {
    target[level] = function (...args) {
      if (originals[level]) {
        try { originals[level](...args) } catch (e) {}
      }
      try {
        logger[map[level]]('console', args.map(a => safeMessage(a)).join(' '))
      } catch (e) {}
    }
  }
  return originals
}

/**
 * 挂上全局异常钩子。
 * uncaughtException 之后进程状态不可信，记完就退出（退出动作由调用方决定，
 * 以便测试时不必真的杀进程）；unhandledRejection 只记不退出 ——
 * 一个没接住的 Promise 不该把用户正在用的客户端整个关掉。
 */
/**
 * 判断未捕获异常是否致命。
 *
 * ## 为什么需要这个函数
 *
 * 0.1.36/0.1.37 的真实上报显示：代理节点抖动产生的 `ECONNRESET` /
 * `writeAfterFIN` 被 `uncaughtException` 捕获后无条件 `exit(1)`，
 * 用户看到的就是「打开就闪退」。90 分钟内 16 次，内存仅 60%。
 *
 * ## 判据必须「白名单式」：默认致命
 *
 * 宁可让真正严重的问题立刻退出（用户重开一次即可，且日志留痕），
 * 也不能把未知异常一律吞掉 —— 那会造出"界面还在、但功能已坏"的
 * 僵尸进程，比闪退更难排查。
 *
 * 只放行**能明确归因到网络/流、且已被中继层兜住**的错误码。
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',        // 对端重置
  'EPIPE',             // 写已关闭的管道
  'ECONNABORTED',      // 连接被本地中止
  'ETIMEDOUT',         // 超时
  'ERR_STREAM_WRITE_AFTER_END',  // writeAfterFIN，本次事故的直接元凶
  'ERR_STREAM_DESTROYED'
])

function isFatalError(error) {
  if (!error) return true
  // 启动期出错必须退出：继续跑只会留下一个残缺的窗口。
  const code = String(error.code || '')
  if (NETWORK_ERROR_CODES.has(code)) return false
  // 有些流错误不带 code，只有 message。按特征串兜一层，仍然是白名单。
  const message = String(error.message || '')
  if (/^(read |write )?(ECONNRESET|EPIPE)/.test(message)) return false
  if (/socket has been ended by the other party/i.test(message)) return false
  if (/This socket is closed/i.test(message)) return false
  return true
}

function attachProcessHandlers(proc, logger, options) {
  const opts = options || {}
  const exit = opts.exit || (code => proc.exit(code))
  const onUnhandled = opts.onUnhandled || (() => {})

  proc.on('uncaughtException', error => {
    logger.fatal('crash', '主进程未捕获异常：' + safeMessage(error))
    try {
      if (typeof opts.flush === 'function') opts.flush()
    } catch (e) {}
    // ★ 不能对所有未捕获异常一律 exit(1) ★
    //
    // 这里原本无条件退出。后果在 0.1.36/0.1.37 的真实上报里暴露出来：
    // 一次 `ECONNRESET` / `writeAfterFIN`（代理节点抖动、对端先关连接，
    // **全是常态**）就把整个软件打死，用户看到的就是「打开就闪退」。
    // 日志里 90 分钟内连崩 16 次，而内存只用了 60%。
    //
    // 失控的组件是**网络中继**，不是主进程本身 —— 让它拖垮整个 UI
    // 才是真正的故障。所以分两类：
    //   · 致命（启动期、模块缺失、明确标记 fatal）：必须退出，
    //     继续跑只会变成"界面在但什么都点不动"的僵尸进程。
    //   · 网络/IO 类（EPIPE/ECONNRESET/writeAfterFIN 等）：记账后继续，
    //     由具体的连接逻辑自行收尾。
    // 归到第二类的前提是 socket 层已经补齐 error 监听与安全写入
    // （见 socks-relay.js），否则会退化成"异常被吞、但功能已坏"。
    if (isFatalError(error)) exit(1)
  })

  proc.on('unhandledRejection', reason => {
    logger.error('crash', '未处理的 Promise 拒绝：' + safeMessage(reason))
    onUnhandled(reason)
  })
}

module.exports = {
  KEEP_DAYS,
  MAX_FILE_BYTES,
  MAX_LINE_CHARS,
  FILE_PREFIX,
  FILE_SUFFIX,
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
}
