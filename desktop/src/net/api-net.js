'use strict'

/**
 * 出站 HTTP 传输层：连接池、超时预算、失败分类。
 *
 * ## 为什么单独成模块
 *
 * 这段原先内联在 main.js 里，一 require 就得加载 electron，于是「连接超时算哪类
 * 错误」这种最需要反复验证的判断，只能靠切片源码 + 手拼依赖去测 —— 一旦行号或
 * 写法变了就误报。
 *
 * 抽出来之后它是纯 Node 模块，测试直接 require 真身。
 *
 * ## 两个 Agent 的原因
 *
 * `connect.timeout` 在构造时定死、没法按请求改。而"冷启动首次请求"必须给更宽的
 * 预算（DNS 未预热、TLS 握手首次协商），热路径则要快点失败。两个 Agent 各维护
 * 自己的连接池，互不干扰。
 *
 * ## 错误分类的核心约束
 *
 * `UND_ERR_CONNECT_TIMEOUT` **必须**归成"连不上"（可安全重试），不能因为它带
 * `Timeout` 字样就被当成"响应超时"而放弃重试 —— 后者发生在连接建立之后，
 * 请求可能已经到服务端，盲目重发会导致重复计费。
 */

const DEFAULTS = {
  /** 冷启动首次请求的连接预算：要覆盖 DNS + TLS 首次协商。 */
  connectFirstMs: 8000,
  /** 热路径连接预算。 */
  connectMs: 4000,
  /** 整体预算上限（连接 + 传输）。 */
  totalMs: 30000
}

function createApiNet (deps) {
  const d = deps || {}
  const timeout = Object.assign({}, DEFAULTS, d.timeouts || {})
  const getLog = d.getLog || (() => d.clientLog || null)
  // 注入点：测试用假 undici / 假 fetch；生产不传，走真实全局。
  const requireUndici = d.requireUndici || (() => require('undici'))
  const globalFetch = d.fetch || ((...a) => fetch(...a))

  // 连接池与 undici 的加载状态都是本模块私有 —— 外部不该关心
  let libTried = false
  let lib = null
  let agents = null
  let warm = false

  /** 优先用自带的 undici（连接超时可控），装不上退回全局 fetch。 */
  function transport () {
    if (!libTried) {
      libTried = true
      try { lib = requireUndici() } catch (e) { lib = null }
    }
    return lib
  }

  /** 本进程共用的 dispatcher（冷 / 热两个 Agent）。 */
  function dispatcher () {
    const l = transport()
    if (!l || !l.Agent) return undefined
    if (!agents) {
      agents = {
        cold: new l.Agent({
          connect: { timeout: timeout.connectFirstMs },
          headersTimeout: timeout.totalMs,
          bodyTimeout: timeout.totalMs
        }),
        warm: new l.Agent({
          connect: { timeout: timeout.connectMs },
          headersTimeout: timeout.totalMs,
          bodyTimeout: timeout.totalMs
        })
      }
    }
    return warm ? agents.warm : agents.cold
  }

  /** 退出时收掉连接池，别把 keep-alive 的 socket 留在进程里。 */
  function close () {
    const current = agents
    agents = null
    if (!current) return
    for (const key of ['cold', 'warm']) {
      try { if (current[key] && current[key].close) current[key].close() } catch (e) {}
    }
  }

  /** 真正发一次请求。 */
  function raw (url, init) {
    const l = transport()
    const disp = dispatcher()
    if (l && l.fetch && disp) {
      return l.fetch(url, Object.assign({ dispatcher: disp }, init))
    }
    return globalFetch(url, init)
  }

  /** 造一个带错误码 + 取证信息的异常，并落一条日志（只含非敏感字段）。 */
  function failure (code, message, info) {
    const log = getLog()
    if (log) {
      try { log.warn('api', code + ' ' + JSON.stringify(info)) } catch (e) {}
    }
    const err = new Error(message)
    err.code = code
    err.pix = info
    return err
  }

  /** 分类一次**没拿到 HTTP 响应**的传输失败：整体超时 vs 连接不可达。 */
  function classify (err, baseInfo) {
    const cause = err && err.cause
    const causeCode = String((cause && cause.code) || err.code || '')
    const causeMessage = String((cause && cause.message) || err.message || '')
    // 连接超时**必须**归成"连不上"（可安全重试），不能被 Timeout 字样带偏。
    const isConnectTimeout = causeCode === 'UND_ERR_CONNECT_TIMEOUT'
    const isResponseTimeout = !isConnectTimeout && (
      causeCode === 'UND_ERR_HEADERS_TIMEOUT' ||
      causeCode === 'UND_ERR_BODY_TIMEOUT' ||
      (err && err.name === 'TimeoutError'))
    const connectLike = isConnectTimeout ||
      ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
        'ETIMEDOUT', 'ECONNABORTED'].indexOf(causeCode) >= 0
    const info = Object.assign({}, baseInfo, {
      phase: connectLike ? 'connect' : 'response',
      gotResponse: false,
      errName: (err && err.name) || '',
      causeCode: causeCode,
      causeMessage: causeMessage
    })
    if (isResponseTimeout) {
      return failure('NETWORK_TIMEOUT', '服务器响应超时，请稍后重试', info)
    }
    return failure('NETWORK_UNREACHABLE',
      '连不上服务器（' + (causeCode || (err && err.name) || '连接失败') + '）', info)
  }

  return {
    transport,
    dispatcher,
    close,
    raw,
    failure,
    classify,
    isWarm: () => warm,
    markWarm: () => { warm = true },
    // 测试与排障用
    __reset () { close(); libTried = false; lib = null; warm = false },
    __agents: () => agents
  }
}

module.exports = { createApiNet, DEFAULTS }
