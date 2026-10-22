'use strict'

/**
 * 上游厂商请求的 HTTP 连接池。
 *
 * ## 要解决什么
 *
 * 原来所有翻译请求都用裸 `globalThis.fetch`。Node 内置的 undici 对**未指定
 * dispatcher** 的请求用的是全局 agent —— 它确实带一点 keep-alive，但有两处问题：
 *
 *   1. **连接数不设上限，也不预热**。冷启动后第一次翻译必然要完整做一次
 *      TCP + TLS 握手（GPT 实测 7.9s 的 P95 就是这类冷连接的产物）；
 *   2. 翻译是"同一批域名、极小请求、极高频率"的负载，和 undici 默认面向的
 *      通用场景不匹配 —— 需要**少量长连接反复复用**，而不是按需新建。
 *
 * 所以这里建一个专用 dispatcher：每个域名保留少量长连接，空闲不立刻关，
 * 并允许在启动时**预热**（提前握手，把握手的钱花在用户看不见的时候）。
 *
 * ## 为什么不直接 `setGlobalDispatcher`
 *
 * 全局 dispatcher 会影响进程里所有出站请求（下载、webhook、健康检查……），
 * 调参数伤了别的链路很难查。这里只把 dispatcher 传给翻译适配层，
 * 影响面严格限定在翻译这一条路上。
 *
 * ## 失败时怎么办
 *
 * 任何一步出错都**回退到 `globalThis.fetch`** —— 连接池是性能优化，
 * 不能变成"翻译功能挂了"的新理由。
 */

let undici = null
try {
  // Node 18+ 内置；老环境或被打包裁剪掉时下面会走回退路径。
  undici = require('undici')
} catch (e) {
  undici = null
}

const AGENTS = new Map()

/** 按域名懒建 agent —— 只给真正用到的厂商建，不预先占资源。 */
function agentFor (origin) {
  if (!undici || !undici.Agent) return null
  let agent = AGENTS.get(origin)
  if (agent) return agent
  agent = new undici.Agent({
    // 翻译是"一串短请求打同一个域名"。8 条连接足够扛住并发，
    // 再多只是多开握手、并不会更快。
    connections: 8,
    // 空闲连接留 60s：翻译请求是阵发的（用户连续发几条），
    // 关太早等于每次都要重新握手。
    pipelining: 1
  })
  AGENTS.set(origin, agent)
  return agent
}

/**
 * 带连接复用的 fetch。
 *
 * 语义与 `globalThis.fetch` 完全一致，只是在能建池的时候挂上 dispatcher。
 * **绝不抛"池建不出来"的错** —— 那种情况直接退化成裸 fetch。
 */
function pooledFetch (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url)
  if (!url) return globalThis.fetch(input, init)
  let agent = null
  try {
    agent = agentFor(new URL(url).origin)
  } catch (e) {
    agent = null
  }
  if (!agent) return globalThis.fetch(input, init)
  const opts = Object.assign({}, init || {}, { dispatcher: agent })
  return globalThis.fetch(input, opts)
}

/**
 * 预热：提前对常用域名做一次握手，并让连接停在池里等真请求。
 *
 * 只发 `HEAD` / 极短的 `GET`，**不带任何凭据、不带业务参数** —— 目的是
 * 建立 TLS 连接，不是调接口。失败静默忽略（厂商域名不通时，
 * 反正真请求也会失败并走正常的错误提示）。
 *
 * @param {string[]} origins 例如 ['https://api.deepseek.com', 'https://api.openai.com']
 * @returns {Promise<void>}
 */
async function warmUp (origins) {
  const list = Array.isArray(origins) ? origins.filter(Boolean) : []
  await Promise.all(list.map(async origin => {
    try {
      const agent = agentFor(origin)
      if (!agent) return
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 3000)
      try {
        await globalThis.fetch(origin + '/', {
          method: 'HEAD',
          dispatcher: agent,
          signal: ac.signal,
          // 预热请求不该被缓存层当成业务响应
          headers: { 'User-Agent': 'hello-pix/warmup' }
        })
      } finally {
        clearTimeout(timer)
      }
    } catch (e) {
      // 预热失败无所谓：真请求会自己建连。
    }
  }))
}

/** 进程退出前关掉池，别留下悬空的 socket。 */
async function closeAgents () {
  const all = Array.from(AGENTS.values())
  AGENTS.clear()
  await Promise.all(all.map(a => a.close().catch(() => {})))
}

module.exports = {
  pooledFetch,
  warmUp,
  closeAgents,
  /** 测试用：当前建了几个池 */
  _agentCount: () => AGENTS.size
}
