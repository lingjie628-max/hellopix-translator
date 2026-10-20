'use strict'

/**
 * 翻译缓存与幂等键。
 *
 * ## 为什么单独成模块
 *
 * 这段逻辑原先内联在 main.js 里，与窗口、IPC、代理混在一起。但它的依赖其实很小：
 * 只需要 `crypto`、当前账号、设备号。抽出来之后它**不再需要加载 electron**，
 * 因此可以被普通 Node 直接单测 —— 而它恰恰是最需要用测试锁住的地方：
 * 幂等键算错一次，用户就被重复扣一次费。
 *
 * ## 幂等键的三个组成部分
 *
 * 键 = **账号** + **内容指纹** + **尝试代数**。
 *
 * - 带账号：服务端按「账号 + 通道 + 语向 + 正文」判重。客户端不带账号的话，
 *   同机切子账号翻同一句会撞上 `409 IDEMPOTENCY_KEY_REUSED`，那条文本永久翻不出来。
 * - 带代数：服务端一旦为某个键建过预留，这个键就用死了；失败过一次后必须换号，
 *   否则以后永远只拿到 409。
 * - 代数**只在**服务端明确回"这个号已经用死了"时才 +1。其余失败（余额不足、
 *   通道未接通、网络错误）保持原号 —— 这样"服务端已成功但响应读丢"仍命中同一个号，
 *   服务端返回已存译文，**不会重复扣费**。
 *
 * @param {object} deps
 * @param {() => string} deps.currentUser   当前账号名（参与指纹）
 * @param {() => string} deps.deviceId      设备号（参与 requestId）
 * @param {object} [deps.crypto]            默认真 crypto，测试可注入
 */
function createTranslationCache (deps) {
  const d = deps || {}
  const nodeCrypto = d.crypto || require('crypto')
  const currentUser = d.currentUser || (() => '')
  const deviceId = d.deviceId || (() => '')

  /** 译文缓存：key = 内容指纹，value = 译文。命中后移到最后（LRU）。 */
  const cache = new Map()
  const CACHE_MAX = 1000

  /** 指纹 → 尝试代数。无限增长会漏内存，给个上限整体清空即可。 */
  const attempt = new Map()
  const ATTEMPT_MAX = 4096

  function cacheKey (from, to, engine, text) {
    return nodeCrypto.createHash('sha256')
      .update([engine || '', from || 'auto', to || '', text].join('\u0001'))
      .digest('hex')
  }

  function get (from, to, engine, text) {
    const key = cacheKey(from, to, engine, text)
    const row = cache.get(key)
    if (!row) return ''
    // 命中后挪到队尾：Map 的迭代顺序就是 LRU 顺序
    cache.delete(key)
    cache.set(key, row)
    return row
  }

  function put (from, to, engine, text, translation) {
    const out = String(translation || '').trim()
    // 空译文不入缓存：否则一次空响应会把这条文本"锁死"成空，用户永远翻不出来
    if (!out) return
    const key = cacheKey(from, to, engine, text)
    cache.delete(key)
    cache.set(key, out)
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  }

  /**
   * 内容指纹：账号 + 引擎 + 语向 + 正文。
   *
   * 注意它是**纯函数**（同一输入永远同一输出）—— 变化由代数负责，
   * 否则"服务端已成功但响应读丢"会被判成新请求，导致重复扣费。
   */
  function fingerprint (text, from, to, engine) {
    return nodeCrypto.createHash('sha256')
      .update([
        currentUser(),
        String(engine || ''),
        String(from || ''),
        String(to || ''),
        String(text || '')
      ].join('\u0001'))
      .digest('hex')
      .slice(0, 40)
  }

  /** 服务端幂等键（Idempotency-Key）。 */
  function requestId (text, from, to, engine) {
    const fp = fingerprint(text, from, to, engine)
    const generation = attempt.get(fp) || 0
    return `desktop:${deviceId()}:${fp}:${generation}`
  }

  /** 换一代：让下一次重试拿到全新的幂等键。 */
  function bumpAttempt (text, from, to, engine) {
    const fp = fingerprint(text, from, to, engine)
    if (attempt.size > ATTEMPT_MAX) attempt.clear()
    attempt.set(fp, (attempt.get(fp) || 0) + 1)
  }

  function attemptOf (text, from, to, engine) {
    return attempt.get(fingerprint(text, from, to, engine)) || 0
  }

  return {
    cacheKey,
    fingerprint,
    requestId,
    bumpAttempt,
    attemptOf,
    get,
    put,
    get size () { return cache.size },
    get attemptSize () { return attempt.size },
    clear () { cache.clear(); attempt.clear() }
  }
}

/**
 * 服务端明确表示"这个幂等键已经用死了，换一个再来"的错误码。
 *
 * 前三个是"预留已终结/已过期/被别的请求体占用"；最后一个是服务端**故意**要求
 * 客户端换号重发的（换通道重译要重新计费），必须一起换，否则换通道后也翻不出来。
 */
const DEAD_REQUEST_CODES = [
  'REQUEST_FINALIZED',
  'RESERVATION_EXPIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'ENGINE_SWITCH_REQUIRES_NEW_REQUEST'
]

/** 这个响应是不是"号用死了"，必须换号重发。 */
function isDeadRequest (data) {
  return !!(data && data.success === false &&
    DEAD_REQUEST_CODES.indexOf(String(data.code || '')) >= 0)
}

/**
 * 这个错误能不能安全地"原样重发一次"。
 *
 * 只在**连接建立失败**时返回 true：那种情况请求根本没发出去，重发不产生新计费。
 * `ECONNRESET` 之类发生在连接之后，请求可能已到达服务端，属于"不确定"，不许重发。
 */
function isRetryableNetworkError (err) {
  const pix = err && err.pix
  if (!err || err.code !== 'NETWORK_UNREACHABLE' || !pix || pix.gotResponse) return false
  const cause = String(pix.causeCode || '')
  return ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT'].indexOf(cause) >= 0
}

/**
 * 发一次 /translate/run；两类失败各自**原地重发一次**。
 *
 * ## 一类：连接建立失败（网络传输层，**不换号**）
 *
 * 明确的 DNS / TCP 连接失败时，请求**没有发出去**，可以安全地原样重发一次：
 * 复用同一个 requestId（= 服务端幂等键），所以即使第一次其实到达了服务端，
 * 服务端也只会返回已存结果，不会重复扣费。
 *
 * ## 二类：命中"号用死了"（业务层，**必须换号**）
 *
 * 这类失败与"翻译服务坏了"完全无关（上一轮的预留被退款而已）。只重发**一次**：
 * 连换两个号都不行，说明不是号的问题，那就如实上报。
 *
 * @param {object} deps
 * @param {(pathname, opts) => Promise<any>} deps.api
 * @param {object} deps.cache     createTranslationCache(...) 的返回值
 * @param {(err) => boolean} [deps.isRetryableNetworkError]
 * @param {object} [deps.clientLog]  有则记录重试日志
 */
function createRequestTranslate (deps) {
  const { api, cache } = deps
  const retryable = deps.isRetryableNetworkError || isRetryableNetworkError
  // 用 getter 而不是值：clientLog 在启动早期是 null，之后才被赋值。
  // 每次调用现取，才不会把"启动那一刻的 null"永久缓存下来。
  const getLog = deps.getLog || (() => deps.clientLog || null)

  return async function requestTranslate (text, from, to, engine, trigger) {
    const body = () => ({
      text: text, from: from, to: to, engine: engine, trigger: trigger,
      requestId: cache.requestId(text, from, to, engine)
    })
    const call = () => api('/translate/run', {
      method: 'POST', form: body(),
      requestId: cache.requestId(text, from, to, engine)
    })

    let data
    try {
      data = await call()
    } catch (err) {
      // 只在"连接建立失败、请求根本没发出去"时重发一次，且不换号。
      if (!retryable(err)) throw err
      const log = getLog()
      if (log) {
        try {
          log.warn('translate', '连接失败，复用同一幂等号重试一次 · requestId='
            + cache.requestId(text, from, to, engine)
            + ' · cause=' + String((err.pix && err.pix.causeCode) || ''))
        } catch (e) {}
      }
      data = await call()
    }

    if (!isDeadRequest(data)) return data
    // 换号重发一次。注意 `body()` 是在**换号之后**才求值的，
    // 否则 requestId 还是旧的，重发等于白发一次。
    cache.bumpAttempt(text, from, to, engine)
    data = await call()
    // 连换两个号都还是"号用死了"：说明不是号的问题，下一轮别再无谓地原地打转。
    if (isDeadRequest(data)) cache.bumpAttempt(text, from, to, engine)
    return data
  }
}

module.exports = {
  createTranslationCache,
  isDeadRequest,
  isRetryableNetworkError,
  createRequestTranslate,
  DEAD_REQUEST_CODES
}
