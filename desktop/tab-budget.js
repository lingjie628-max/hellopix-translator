'use strict'

/**
 * 实例资源预算 —— 防止"开太多窗口把应用撑崩"。
 *
 * ## 真机现象（0.1.30 修）
 *
 * 一个账号在同一个窗口里开到 **18 个左右的实例**，再开第 19 个
 * **整个应用直接闪退**（不是提示、不是拒绝，是进程没了）。
 *
 * ## 根因（真 Electron 实测）
 *
 * 每开一个实例（`WebContentsView` + 独立 `persist:` 分区）会稳定占用
 * **约 24 个文件句柄**。实测（20 个实例）：
 *
 * ```
 *   基线 句柄=39
 *   #1  → 64     (+25)
 *   #2  → 88     (+24)
 *   #3  → 112    (+24)
 *   ...
 *   #20 → 520    (+24/个)
 * ```
 *
 * 而**句柄是进程级的硬上限**：
 *   · macOS / Linux：受 `ulimit -n`（软限制常见 256～10240）
 *   · Windows：受进程 HANDLE 配额 + Chromium 内部上限
 *   · 打包后的 Electron 应用拿到的软限制往往比开发时更低
 *
 * 于是第 19 个实例一创建，`socket()/open()` 就开始返回 `EMFILE`
 * （too many open files）。Chromium 在**渲染进程创建路径**上遇到 EMFILE
 * 不是抛错而是**直接终止进程** —— 这解释了"闪退而不是报错"。
 *
 * ## 为什么不能"提高 ulimit 就完事"
 *
 * 提上限只能在启动前、且每个平台方式不同，且**上限终究存在**。
 * 真正稳的做法是：**在触顶之前就拒绝，并明确告诉用户为什么**。
 * 崩溃时用户什么也看不到；主动拒绝时用户知道"该关几个了"。
 *
 * ## 另外：反复开关也会漏
 *
 * 实测每"开→关"一轮，**永久泄漏约 8 个句柄**（Electron 33 的原生行为，
 * 强制 GC 也回收不了）。所以长期使用中，**即使当前窗口数不多**，
 * 剩余额度也可能被历史开关吃掉。这里的检查基于**实时探测**，能与它兼容。
 */

const fs = require('node:fs')
const os = require('node:os')

/**
 * 每个实例的句柄预算。实测 24，留一点余量按 26 算 ——
 * 宁可早一点提醒用户，也不要晚一步闪退。
 */
const FDS_PER_INSTANCE = 26

/**
 * 句柄余量下限：低于这个数就认为"再开一个会出事"。
 *
 * 为什么不是 0：Chromium 开一个渲染进程除了保留句柄，还要**瞬时**拿到
 * socket / eventfd / shm 一批描述符。余量打在 0 附近时，创建过程中的
 * 瞬时峰值就会踩到上限，于是崩在"半途" —— 那时再想优雅收尾已经晚了。
 */
const FD_SAFETY_MARGIN = 96

// ---------------------------------------------------------------------------
// 内存水位（0.1.31 起的主判据）
// ---------------------------------------------------------------------------

/**
 * 系统内存使用率超过这个比例，就拒绝再开新实例。
 *
 * ## 为什么改用内存而不是固定窗口数
 *
 * 真机实测（重型页面，每个 8000 条消息 DOM + WebSocket + 定时器）：
 *
 * ```
 *             句柄      主进程RSS    整机内存
 *   48 个  →  1178      122MB       6443MB
 *   80 个  →  1886      150MB       8163MB
 * ```
 *
 * 两个结论：
 *   ① **句柄根本不是瓶颈** —— Electron 启动时会把软限制抬到硬限制，
 *      实测 `ulimit -n` = 1048575，80 个实例才用掉 1886 个。原先把
 *      "每实例 24 句柄"当主判据是**误判了瓶颈**（那是 macOS 上
 *      launchd 默认 maxfiles=256 的错觉）。
 *   ② **内存才是真瓶颈**，而且它与机器大小强相关：80 个实例约 8GB，
 *      在 8GB 机器上会开始换页、卡顿，在 32GB 机器上却毫无压力。
 *
 * 所以固定一个"最多 N 个"是错的：同一个数字在 8GB 机器上太冒险、
 * 在 32GB 机器上又太保守。**按内存水位判断能自适应所有机器。**
 */
const MEMORY_PRESSURE_RATIO = 0.9

/**
 * 单个实例的**保守**内存预留（字节）。
 *
 * 为什么留着"内存"这道判据仍要看单实例成本：内存水位是**当前**快照，
 * 而新实例一开就是几十到几百 MB。如果水位刚好在 89%，直接放行会立刻
 * 越过 90%。所以要预判"开完会不会超"，而不只是"现在有没有超"。
 *
 * 取值依据：实测 80 个重型实例吃掉约 8163MB，平均 **约 102MB/个**。
 * 这里按 120MB 预留（比实测略保守）。
 */
const BYTES_PER_INSTANCE = 120 * 1024 * 1024

/**
 * 当前系统内存水位。
 *
 * ## 为什么不能直接用 `os.freemem()`（实测踩过的坑）
 *
 * macOS 上 `os.freemem()` 只返回 **`Pages free`**，把 `Pages inactive`
 * （可被内核立即回收的内存）**全部算成"已用"**。实测本机：
 *
 * ```
 *   os.freemem()      → 0.12GB   → 算出"已用 98.6%"   ← 错得离谱
 *   memory_pressure   → 系统可用 41%                    ← 系统自己的权威口径
 * ```
 *
 * 用 `os.freemem()` 会导致**内存充足时疯狂误拒**（开着 3 个窗口就说"内存不足"），
 * 比不判断还糟。所以按平台分别取"真正可用"：
 *
 *   · **macOS**：`vm_stat` 的 free + inactive + speculative + purgeable
 *     （inactive 是内核随时可回收的，把这部分当"已用"会严重高估压力）
 *   · **Linux**：`/proc/meminfo` 的 `MemAvailable`（内核算好的，最准）
 *   · **Windows / 其它**：`os.freemem()`，并接受它的保守性
 *
 * 取不到时返回 `total: 0`，调用方据此**放行**（宁可让用户试，也不要误拦）。
 */
function memoryPressure(info) {
  const injected = info && info.memory
  if (injected && Number.isFinite(injected.total) && injected.total > 0) {
    const used = Number(injected.used) || 0
    return {
      total: injected.total,
      used,
      ratio: used / injected.total,
      source: 'injected'
    }
  }

  const total = os.totalmem()
  if (!Number.isFinite(total) || total <= 0) {
    return { total: 0, used: 0, ratio: 0, source: 'unavailable' }
  }

  const available = availableBytes(total)
  if (available === null) {
    return { total: 0, used: 0, ratio: 0, source: 'unavailable' }
  }

  const used = total - available
  return { total, used, ratio: total > 0 ? used / total : 0, source: availableSource() }
}

/** 当前平台用的口径（写进日志，便于真机排障时核对）。 */
function availableSource() {
  if (process.platform === 'darwin') return 'vm_stat'
  if (process.platform === 'linux') return 'meminfo'
  return 'os.freemem'
}

/**
 * 系统"真正可用"的内存字节数。测不出来返回 `null`。
 *
 * 这是整个内存判据的地基 —— 宁可返回 null（→ 放行），也不要返回一个
 * 偏小的数（→ 误拒）。误拒比漏判对用户更烦人：他会觉得"明明内存很空却不让开"。
 */
function availableBytes(total) {
  const platform = process.platform

  if (platform === 'linux') {
    try {
      const text = fs.readFileSync('/proc/meminfo', 'utf8')
      // 内核算好的 MemAvailable 最准（已考虑可回收的 page cache）。
      const m = /MemAvailable:\s+(\d+)\s+kB/.exec(text)
      if (m) return Math.min(Number(m[1]) * 1024, total)
      const free = /MemFree:\s+(\d+)\s+kB/.exec(text)
      if (free) {
        const buffers = /Buffers:\s+(\d+)\s+kB/.exec(text)
        const cached = /^Cached:\s+(\d+)\s+kB/m.exec(text)
        return Math.min(
          Number(free[1]) * 1024 +
          (buffers ? Number(buffers[1]) * 1024 : 0) +
          (cached ? Number(cached[1]) * 1024 : 0),
          total
        )
      }
    } catch (e) {
      // 落到下面的通用路径
    }
  }

  if (platform === 'darwin') {
    const fromVmStat = macAvailableBytes(total)
    if (fromVmStat !== null) return fromVmStat
  }

  // 通用兜底：os.freemem()。已知在 macOS 上偏小，但那一路已经先走了 vm_stat。
  try {
    const free = os.freemem()
    if (Number.isFinite(free) && free >= 0) return Math.min(free, total)
  } catch (e) {}
  return null
}

/**
 * macOS：从 `vm_stat` 算"真正可用"。
 *
 * 口径 = free + inactive + speculative + purgeable。
 *
 * 为什么要加 inactive：那是**内核随时可回收**的内存（文件缓存等），
 * macOS 把它留着是为了加速，不是"被占用了"。实测本机 inactive 有 96653 页
 * （约 1.5GB），不算进去就会把"可用 41%"报成"已用 98%"。
 *
 * 同步 `execSync` 有开销（约 5~15ms），但只在"用户点开新窗口"时调用一次，
 * 不在热路径上，可接受。
 */
function macAvailableBytes(total) {
  try {
    const out = require('node:child_process')
      .execSync('/usr/bin/vm_stat', { timeout: 3000, encoding: 'utf8' })
    let pageSize = 4096
    const ps = /page size of (\d+)/.exec(out)
    if (ps) pageSize = Number(ps[1])
    const pages = name => {
      const m = new RegExp(name + ':\\s+(\\d+)').exec(out)
      return m ? Number(m[1]) : 0
    }
    const free = pages('Pages free')
    const inactive = pages('Pages inactive')
    const speculative = pages('Pages speculative')
    const purgeable = pages('Pages purgeable')
    const totalPages = free + inactive + speculative + purgeable
    if (totalPages <= 0) return null   // vm_stat 输出不认识 → 交给上层兜底
    return Math.min(totalPages * pageSize, total)
  } catch (e) {
    return null
  }
}

/**
 * 当前进程已打开的句柄数。
 *
 * `process.report.getReport()` 是 Node 官方途径，但**开销不小**（会抓栈），
 * 所以优先走平台上的廉价途径：
 *   · Linux/macOS：数 /dev/fd（或 /proc/self/fd）
 *   · Windows：退回 `process.report`（没有 /dev/fd 可数）
 *
 * 返回 `null` 表示"测不出来" —— 调用方必须把 null 当成**不阻止**，
 * 而不是当成 0（否则在测不出来的平台上会永远拒绝开窗口）。
 */
function openHandleCount() {
  for (const dir of ['/dev/fd', '/proc/self/fd']) {
    try {
      return fs.readdirSync(dir).length
    } catch (e) {
      // 换个候选继续试
    }
  }
  try {
    const report = process.report && process.report.getReport && process.report.getReport()
    const fds = report && report.libuv && Array.isArray(report.libuv) ? report.libuv.length : null
    if (Number.isInteger(fds)) return fds
  } catch (e) {}
  return null
}

/**
 * 当前进程的句柄软上限。测不出来返回 `null`。
 *
 * Node 没有跨平台的 `getrlimit`。实测 Electron 启动时会把软限制**抬到硬限制**
 * （macOS 上实测 `ulimit -n` = 1048575），所以这里的默认值取一个宽松的数。
 *
 * 为什么不再用 1024（0.1.30 的取值）：那会把"句柄"误当成主瓶颈，
 * 于是在内存还很充裕的机器上过早拒绝。现在句柄只作为**极端兜底**
 * （真正的上限由 Electron/系统决定，测不准反而会误拦）。
 */
function handleLimit (env) {
  const e = env || process.env
  const fromEnv = Number(e.PIX_FD_LIMIT)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  return 65536
}

/**
 * 判断"还能不能再开一个实例"。
 *
 * ## 判据顺序（0.1.31 起）
 *
 *   1. **系统内存水位**（主判据）—— 已用超过 `MEMORY_PRESSURE_RATIO`
 *      或"开完这一个就会超过" → 拒绝。这一条自适应机器大小。
 *   2. **句柄水位**（兜底）—— 只在极端情况下触发（见 `handleLimit`）。
 *   3. `maxTabs` 若显式给出且 > 0，仍作为硬顶（默认不设）。
 *   4. 任何一项**测不出来** → 放行。宁可让用户试，也不要无故拦住。
 *
 * @param {{
 *   tabCount?: number,
 *   maxTabs?: number,
 *   used?: number|null,
 *   limit?: number|null,
 *   memory?: { total:number, used:number }|null
 * }} input
 */
function canOpenAnotherTab(input) {
  const tabCount = Number(input && input.tabCount) || 0
  const maxTabs = Number(input && input.maxTabs) || 0
  const used = input && Object.prototype.hasOwnProperty.call(input, 'used') ? input.used : null
  const limit = input && Object.prototype.hasOwnProperty.call(input, 'limit') ? input.limit : null
  const mem = memoryPressure(input)

  // ---- 第一道：系统内存水位（主判据）----
  //
  // 为什么按"水位"而不是"剩余字节"：用户能理解"内存快满了"，
  // 而且这个判据自动适配 8GB / 16GB / 32GB 各种机器。
  //
  // 为什么要预判"开完会不会超"：水位是**当前**快照。如果现在 89%、
  // 直接放行，新实例一起来就立刻越过 90% —— 那等于没保护。
  if (mem.total > 0) {
    const projected = (mem.used + BYTES_PER_INSTANCE) / mem.total
    if (mem.ratio >= MEMORY_PRESSURE_RATIO || projected > MEMORY_PRESSURE_RATIO) {
      return {
        ok: false,
        code: 'MEMORY_PRESSURE',
        reason: '系统运行内存已接近上限（当前已用 ' + Math.round(mem.ratio * 100) + '%），'
          + '再开新窗口可能导致卡顿或崩溃。'
          + '请先关掉几个不用的应用窗口，或关闭一些其他程序后再试。',
        used, limit,
        memory: { total: mem.total, used: mem.used, ratio: mem.ratio, source: mem.source },
        tabCount
      }
    }
  }

  // ---- 第二道：显式窗口数硬顶（默认不设，留给需要的人）----
  if (maxTabs > 0 && tabCount >= maxTabs) {
    return {
      ok: false,
      code: 'TOO_MANY_TABS',
      reason: '最多同时开 ' + maxTabs + ' 个应用窗口（当前 ' + tabCount + ' 个）。'
        + '请先关掉几个不用的，再开新的。',
      used, limit,
      memory: { total: mem.total, used: mem.used, ratio: mem.ratio, source: mem.source },
      tabCount
    }
  }

  // ---- 第三道：句柄水位（极端兜底）----
  //
  // 实测句柄不是瓶颈（80 个实例才 1886 个），所以这一条几乎不会触发。
  // 留着是因为它是"最后一道网"：万一某个平台上句柄真的被别的程序耗光，
  // 这里能拦住，而不是让用户看到闪退。
  if (Number.isInteger(used) && Number.isInteger(limit) && limit > 0) {
    const free = limit - used
    if (free < FDS_PER_INSTANCE + FD_SAFETY_MARGIN) {
      return {
        ok: false,
        code: 'FD_EXHAUSTED',
        reason: '系统可用句柄不足，再开一个窗口可能导致应用闪退。'
          + '请先关掉几个不用的应用窗口，或重启 Hello Pix 后再试。',
        used, limit,
        memory: { total: mem.total, used: mem.used, ratio: mem.ratio, source: mem.source },
        tabCount
      }
    }
  }

  return {
    ok: true,
    used, limit,
    memory: { total: mem.total, used: mem.used, ratio: mem.ratio, source: mem.source },
    tabCount
  }
}

module.exports = {
  canOpenAnotherTab,
  memoryPressure,
  openHandleCount,
  handleLimit,
  FDS_PER_INSTANCE,
  FD_SAFETY_MARGIN,
  MEMORY_PRESSURE_RATIO,
  BYTES_PER_INSTANCE
}
