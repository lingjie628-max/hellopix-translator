const { coversFile } = require('./helpers/whitelist')
'use strict'

/**
 * 实例资源预算（`desktop/tab-budget.js`）—— 防止"开太多窗口把应用撑崩"。
 *
 * ## 判据的演进（重要，别退回旧结论）
 *
 * **0.1.30 的判断**：真机"一个账号开到 18 个左右就闪退"，当时归因为
 * **句柄耗尽**（每实例 24 个句柄），于是设了固定上限 20。
 *
 * **0.1.31 的实测推翻了这个归因**：
 *
 * ```
 *             句柄      主进程RSS    整机内存
 *   48 个  →  1178      122MB       6443MB
 *   80 个  →  1886      150MB       8163MB
 * ```
 *
 * ① Electron 启动时会把软限制**抬到硬限制**（macOS 实测 `ulimit -n` = 1048575），
 *    80 个实例才用掉 1886 个句柄 —— **句柄根本不是瓶颈**。原先看到的
 *    "`launchd maxfiles=256`" 是个**假象**。
 * ② **内存才是真瓶颈**，且与机器大小强相关：80 个约 8GB ——
 *    在 8GB 机器上是灾难，在 32GB 机器上毫无压力。
 *
 * 所以固定"最多 N 个"是错的（同一个数字在 8GB 上太冒险、在 32GB 上太保守），
 * 改为**按系统内存水位动态判断**。
 *
 * ## 内存口径的坑（也踩过）
 *
 * macOS 上 `os.freemem()` **只算 `Pages free`**，把可回收的 `inactive`
 * 全当"已用"。实测本机：
 *
 * ```
 *   os.freemem()     → 0.12GB  → "已用 98.6%"   ← 错得离谱，会疯狂误拒
 *   vm_stat 口径     → 6.41GB  → "已用 80%"     ← 可用
 *   system 权威口径  → 可用 41%
 * ```
 *
 * 所以 macOS 走 `vm_stat`（free + inactive + speculative + purgeable），
 * Linux 走 `/proc/meminfo` 的 `MemAvailable`。这一组测试把两者都钉死。
 */

const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const fs = require('node:fs')

const {
  canOpenAnotherTab,
  memoryPressure,
  openHandleCount,
  handleLimit,
  FDS_PER_INSTANCE,
  FD_SAFETY_MARGIN,
  MEMORY_PRESSURE_RATIO,
  BYTES_PER_INSTANCE
} = require(path.join(__dirname, '..', 'desktop', 'src/window/tab-budget.js'))

const root = path.join(__dirname, '..')
const GB = 1024 * 1024 * 1024

// ---------------------------------------------------------------- 打包白名单

test('tab-budget.js 在打包白名单里（漏了会让安装包启动即崩）', () => {
  // main.js 顶部 require('./tab-budget')。打包后 app.asar 里若没有这个文件，
  // require 会直接抛 MODULE_NOT_FOUND —— 窗口都建不出来。
  // instance-slot.js / background-mode.js 都踩过同一个坑，这条是护栏。
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'))
  const files = (pkg.build && pkg.build.files) || []
  assert.ok(coversFile(files, 'src/window/tab-budget.js'), 'tab-budget.js 不在 build.files 覆盖范围内')
})

// ---------------------------------------------------------------- 内存水位（主判据）

test('内存水位充足 → 放行', () => {
  const r = canOpenAnotherTab({
    tabCount: 5,
    memory: { total: 16 * GB, used: 4 * GB }
  })
  assert.equal(r.ok, true)
})

test('内存已用超过阈值 → 拒绝，且说明是内存问题', () => {
  const r = canOpenAnotherTab({
    tabCount: 5,
    memory: { total: 16 * GB, used: 0.95 * 16 * GB }
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'MEMORY_PRESSURE')
  assert.match(r.reason, /内存/, '必须点名"内存"，否则用户无从下手')
  assert.match(r.reason, /关掉几个/, '必须给出可执行动作')
  assert.match(r.reason, /95%/, '带上当前水位，便于用户核对')
})

test('刚好到阈值 → 拒绝（阈值是"上限"不是"警告线"）', () => {
  const total = 16 * GB
  const r = canOpenAnotherTab({ tabCount: 5, memory: { total, used: MEMORY_PRESSURE_RATIO * total } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'MEMORY_PRESSURE')
})

test('略低于阈值但"开完这一个就会超" → 也要拒绝（预判，不只看当前快照）', () => {
  const total = 16 * GB
  // 当前 89%，加上一个实例的预留正好越过 90%
  const used = MEMORY_PRESSURE_RATIO * total - BYTES_PER_INSTANCE * 0.5
  const r = canOpenAnotherTab({ tabCount: 5, memory: { total, used } })
  assert.equal(r.ok, false, '水位是当前快照，必须预判"开完之后"')
  assert.equal(r.code, 'MEMORY_PRESSURE')
})

test('水位够低、留足一个实例的空间 → 放行', () => {
  const total = 16 * GB
  // 留出一个实例两倍的余量
  const used = MEMORY_PRESSURE_RATIO * total - BYTES_PER_INSTANCE * 2
  const r = canOpenAnotherTab({ tabCount: 5, memory: { total, used } })
  assert.equal(r.ok, true)
})

test('内存测不出来（total=0）→ 放行，绝不误拦', () => {
  const r = canOpenAnotherTab({ tabCount: 5, memory: { total: 0, used: 0 } })
  assert.equal(r.ok, true)
})

test('大内存机器能开更多（同样水位下，32GB 比 8GB 宽松）', () => {
  // 两者都开到约 89.5%（仍未越线），但 8GB 机器加一个实例就越线，32GB 不会：
  //   8GB  × 89.5% = 7.16GB + 0.12GB = 7.28GB → 91.0%  > 90%  → 拒绝
  //   32GB × 89.5% = 28.6GB + 0.12GB = 28.8GB → 89.9%  < 90%  → 放行
  const small = canOpenAnotherTab({ tabCount: 5, memory: { total: 8 * GB, used: 0.895 * 8 * GB } })
  const big = canOpenAnotherTab({ tabCount: 5, memory: { total: 32 * GB, used: 0.895 * 32 * GB } })
  assert.equal(small.ok, false, '8GB 机器在 89.5% 时不该再开（加一个就越线）')
  assert.equal(big.ok, true, '32GB 机器在同样水位仍可再开（余量够）')
})

// ---------------------------------------------------------------- 内存探测

test('memoryPressure 在本机返回可用的总内存与水位数', () => {
  const m = memoryPressure()
  assert.ok(m.total > 0, '总内存必须 > 0')
  assert.ok(m.used >= 0 && m.used <= m.total, 'used 必须在 [0, total]')
  assert.ok(m.ratio >= 0 && m.ratio <= 1, 'ratio 必须在 [0, 1]')
  assert.ok(['vm_stat', 'meminfo', 'os.freemem', 'injected', 'unavailable'].includes(m.source), '来源应可识别')
})

test('★ macOS：内存口径不能用 os.freemem（那样会把 98% 误报成已满）', () => {
  if (process.platform !== 'darwin') return
  const os = require('node:os')
  const m = memoryPressure()
  const naiveUsed = os.totalmem() - os.freemem()
  // os.freemem 口径算出的"已用"必然 >= 真实已用（它把可回收的 inactive 也算进去了）
  assert.ok(naiveUsed >= m.used, 'vm_stat 口径算出的已用不该超过 os.freemem 口径')
  // 且有明显差距时才说明我们真的绕开了那个坑（机器空闲时不强求差距）
  if (m.ratio < 0.85) {
    assert.ok(
      naiveUsed / os.totalmem() > m.ratio,
      'os.freemem 口径应明显更悲观（这正是要绕开它的原因）'
    )
  }
})

test('内存来源标注正确（macOS=vm_stat, Linux=meminfo）', () => {
  const m = memoryPressure()
  if (process.platform === 'darwin') assert.equal(m.source, 'vm_stat')
  else if (process.platform === 'linux') assert.equal(m.source, 'meminfo')
  else assert.ok(m.source === 'os.freemem' || m.source === 'unavailable')
})

test('injected 内存优先（便于真机模拟各种水位）', () => {
  const m = memoryPressure({ memory: { total: 8 * GB, used: 7 * GB } })
  assert.equal(m.source, 'injected')
  assert.equal(m.total, 8 * GB)
  assert.equal(m.used, 7 * GB)
})

// ---------------------------------------------------------------- 窗口数硬顶（默认不设）

test('maxTabs 默认 0 → 不因窗口数拒绝（改由内存决定）', () => {
  const r = canOpenAnotherTab({ tabCount: 60, maxTabs: 0, memory: { total: 32 * GB, used: 4 * GB } })
  assert.equal(r.ok, true, '内存充足时不该因窗口数被拦')
})

test('显式给出 maxTabs > 0 → 仍作为硬顶生效', () => {
  const r = canOpenAnotherTab({ tabCount: 60, maxTabs: 60, memory: { total: 32 * GB, used: 4 * GB } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'TOO_MANY_TABS')
})

test('内存不足优先于窗口数报出（内存是更常见的真实原因）', () => {
  const r = canOpenAnotherTab({
    tabCount: 60,
    maxTabs: 60,
    memory: { total: 8 * GB, used: 0.95 * 8 * GB }
  })
  assert.equal(r.code, 'MEMORY_PRESSURE')
})

// ---------------------------------------------------------------- 句柄（极端兜底）

test('句柄余量不足 → 作为最后一道网仍能拦住', () => {
  const r = canOpenAnotherTab({
    tabCount: 5,
    memory: { total: 32 * GB, used: 4 * GB },   // 内存充足
    used: 65536 - 10,                            // 但句柄见底
    limit: 65536
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'FD_EXHAUSTED')
})

test('句柄测不出来 → 不因句柄拒绝', () => {
  const r = canOpenAnotherTab({ tabCount: 5, memory: { total: 16 * GB, used: 2 * GB }, used: null, limit: null })
  assert.equal(r.ok, true)
})

test('handleLimit 默认足够宽松（实测 80 实例才用 1886 个句柄）', () => {
  assert.ok(handleLimit({}) >= 65536, '旧的 1024 会把句柄误当瓶颈，导致过早拒绝')
})

test('handleLimit 支持环境变量覆盖（便于真机复现）', () => {
  assert.equal(handleLimit({ PIX_FD_LIMIT: '512' }), 512)
  assert.equal(handleLimit({ PIX_FD_LIMIT: 'abc' }), 65536, '非法值退回默认')
})

test('openHandleCount 在本平台能测出正数（测不出才允许 null）', () => {
  const n = openHandleCount()
  if (n === null) return
  assert.ok(Number.isInteger(n) && n > 0)
})

// ---------------------------------------------------------------- 常量合理性

test('内存阈值是 0.9（用户明确要求"超过 90% 提示"）', () => {
  assert.equal(MEMORY_PRESSURE_RATIO, 0.9)
})

test('每实例内存预留不低于实测均值（实测约 102MB/个）', () => {
  assert.ok(BYTES_PER_INSTANCE >= 100 * 1024 * 1024, '低于实测会低估用量')
})

test('句柄相关常量保留（作为最后一道网）', () => {
  assert.ok(FDS_PER_INSTANCE >= 24)
  assert.ok(FD_SAFETY_MARGIN > 0)
})
