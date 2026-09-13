'use strict'

/**
 * 翻译通道解析。
 *
 * 为什么单独成一个模块：这段逻辑决定桥接文件里写哪个通道，而写错的后果是
 * **静默的** —— 魔改电报的 Provider 按设计"失败就不写译文、不弹错、不崩电报"，
 * 所以写进一个没接通的通道，现象和"编译没成功"完全一样。
 *
 * 抽出来的真正理由是可验证性：端到端脚本 `scripts/verify-telegram-bridge-e2e.js`
 * 必须 require 这一份实现，而不是自己抄一份 —— 否则脚本验的是它假想的启动器，
 * 启动器改坏了也一样全绿。
 *
 * 规则：
 *   只在 wired && enabled 的通道里挑（其它必然 503 ENGINE_NOT_CONFIGURED）；
 *   优先用户存的那个，其次后台的 activeEngine，最后第一个已接通的。
 * 注意**不能**直接采信后台的 activeEngine：它是账号上持久化的值，可能指向一个
 * 早就没接通的通道（真实库里 demo 账号就是 active_engine_id='youdao' 而 youdao
 * 没接通），所以它只能作为候选之一，不能作为结果。
 *
 * 一个已接通通道都没有时：问过了就写空串（C++ 侧会原样发 engine= 空值，服务端
 * `String(data.engine || session.account.activeEngineId || ...)` 里空串是 falsy，
 * 会回退到账号当前通道 —— 比硬编码一个已知的死通道安全）；没问到就保留用户存的值。
 */

function usableEngines(engines) {
  const rows = (engines && engines.rows) || []
  return rows.filter(row => row && row.wired && row.enabled)
}

function resolveEngine(engines, saved) {
  const rows = usableEngines(engines)
  if (rows.length) {
    const active = String((engines && engines.activeEngine) || '')
    const keep = rows.find(row => String(row.id) === String(saved))
    const pick = keep || rows.find(row => String(row.id) === active) || rows[0]
    return String(pick.id)
  }
  // 两种"没有可用通道"要分开处理，不能都回落到 saved：
  //   - 问到了后台、确认套餐里一个已接通的都没有 -> 写空串。此时 saved 大概率
  //     已经失效（通道被下架 / 凭据被清），把已知的死通道写进桥接文件只会让
  //     服务端 503，不如交给服务端按 falsy 回退到账号当前通道。
  //   - 根本没问到（离线 / 后台挂了）-> 保留用户存的值，别把他的偏好清掉；
  //     等下次问到了再纠正。
  return Array.isArray(engines && engines.rows) ? '' : String(saved || '')
}

/** 给渲染进程用的通道状态：只暴露能选的通道，外加"是否问过后台"。 */
function engineState(engines) {
  const rows = usableEngines(engines).map(row => ({
    id: String(row.id),
    name: String(row.name || row.id)
  }))
  return {
    known: Boolean(engines),
    wired: rows.length > 0,
    rows
  }
}

module.exports = { usableEngines, resolveEngine, engineState }
