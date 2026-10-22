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
  const ATTEMPT_MAX = 4096
  const attempt = new Map()

  // 代数必须**跨进程存活**。
  //
  // 键 = 账号 + 内容指纹 + 代数。服务端一旦为某个键建过预留，这个键就用死了；
  // 命中"号用死了"时靠 bumpAttempt 换一代。如果代数只活在内存里，
  // 用户重启 App 后代数归零 → 又发回那个已进终态的键 →
  // 这句话从此**永远 REQUEST_FINALIZED**，直到他手动改一个字。
  // "重启就能好"是所有用户的第一反应，而重启恰好抹掉唯一的修复手段 ——
  // 这类故障最难查，所以必须落盘。
  const loadAttempts = typeof d.loadAttempts === 'function' ? d.loadAttempts : null
  const saveAttempts = typeof d.saveAttempts === 'function' ? d.saveAttempts : null
  if (loadAttempts) {
    try {
      const saved = loadAttempts()
      if (saved && typeof saved === 'object') {
        Object.keys(saved).forEach((key) => {
          const n = Number(saved[key])
          if (Number.isInteger(n) && n > 0) attempt.set(key, n)
        })
      }
    } catch (e) { /* 磁盘读坏了就当从头开始，不能因此起不来 */ }
  }

  /** 落盘。失败只影响"重启后能不能接着用"，不能影响本次翻译。 */
  let dirty = false
  let flushTimer = null
  function flushAttempts () {
    if (!saveAttempts || !dirty) return
    try {
      const out = {}
      attempt.forEach((value, key) => { out[key] = value })
      saveAttempts(out)
      dirty = false
    } catch (e) { /* 满盘 / 权限问题：保持 dirty，下次再试 */ }
  }
  /**
   * 标记待落盘。
   *
   * 不能每 bump 一次就同步写文件：换号发生在**翻译失败的路径**上，
   * 用户连点重试时可能一秒写几十次盘。这里合并成 1 秒一次，
   * 外加 `flushAttempts` 供退出时强制刷盘。
   */
  function persistAttempts () {
    dirty = true
    if (flushTimer || !saveAttempts) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushAttempts()
    }, 1000)
    if (flushTimer.unref) flushTimer.unref()
  }
  /** 强制立即落盘（退出前 / 测试里调用）。 */
  function flushNow () {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    flushAttempts()
  }

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
    // 立刻落盘：用户可能下一步就关掉 App 再开
    persistAttempts()
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
    flushAttempts: flushNow,
    get,
    put,
    get size () { return cache.size },
    get attemptSize () { return attempt.size },
    clear () { cache.clear(); attempt.clear(); dirty = true; flushNow() }
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
  // ★ 这份名单必须与 api-net.js 的 classify()「连接类」判据**保持一致** ★
  //
  // 踩过的坑（真机：一次抖动就弹「连不上服务器，消息未发送」）：
  // classify 把任何走不到响应头的失败都归成 NETWORK_UNREACHABLE，而这里
  // 只认 6 个 code —— `ECONNRESET` / `EPIPE` / `UND_ERR_SOCKET` 这些
  // **千真万确属于连接层**的失败被归了类却不重试，用户只看到一次失败。
  //
  // 新增连接类 code 时两边要一起改，否则就是"归了类却不救"。
  return ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
    'ETIMEDOUT', 'ECONNABORTED',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED',
    'ECONNRESET', 'EPIPE'].indexOf(cause) >= 0
}

/**
 * 这个 trigger 是不是"用户主动点的"。
 *
 * 用途只有一个：让他绕过连续失败退避（见 createRequestTranslate）。
 * 取值来源见 guest-inject.js 的 TRIGGER_*——新增 trigger 时要么加进这里、
 * 要么确认它确实是自动行为。
 */
const MANUAL_TRIGGERS = ['manual_click', 'manual_send', 'retranslate']
function isManualTrigger (trigger) {
  return MANUAL_TRIGGERS.indexOf(String(trigger || '').trim()) >= 0
}

/**
 * 连接失败后，重发前等多久。
 *
 * 为什么不能是 0：失败时 main.js 会 `apiNet.recycle()` 重建连接池，
 * 立刻重发等于在新池建好的瞬间又撞一次墙，那次重试基本白给。
 * 120ms 足以让 recycle 生效，用户也察觉不到。
 *
 * 测试可以注入 0 来跳过等待；生产默认 120ms。
 */
function translateRetryDelayMs (deps) {
  const raw = deps && deps.retryDelayMs
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 120
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
    // 用户手动触发（点译 / 按发送）时，绕过连续失败退避 ——
    // 他看见失败提示后主动点的重试，不该被"网络恢复中"挡回去。
    // 自动扫描 / 自动接收仍受退避约束，避免断网时刷爆日志。
    const skipBackoff = isManualTrigger(trigger)
    const call = () => api('/translate/run', {
      method: 'POST', form: body(), skipBackoff: skipBackoff,
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
      // ★ 必须等一下再重发 ★
      //
      // 上一次失败时 main.js 已经调了 `apiNet.recycle()` 把连接池整个重建。
      // 紧接着立刻重发，等于在**新池还没建好**的瞬间又撞一次同样的墙 ——
      // 那一次重试基本白给，用户看到的就是"重试了还是连不上"。
      // 120ms 足够让 recycle 生效，又不至于让用户觉得卡。
      await new Promise(resolve => setTimeout(resolve, translateRetryDelayMs(deps)))
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
  isManualTrigger,
  MANUAL_TRIGGERS,
  createRequestTranslate,
  DEAD_REQUEST_CODES
}
