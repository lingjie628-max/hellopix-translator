'use strict'

/**
 * 多开实例槽位分配。
 *
 * ## 要解决什么
 *
 * 分区名原本是 `persist:pix-<PIXS用户名>-<平台>-<序号>`，而**序号来自进程内的
 * 内存计数器**（`usedCount`），`Partitions/` 目录却是所有进程共享的。于是：
 *
 *   进程 A 启动 → usedCount{telegram-z: 1} → 打开 Telegram → index = 2
 *   进程 B 启动 → usedCount{telegram-z: 1} → 打开 Telegram → index = 2
 *
 * 两个进程拿到**同一个分区名** → 共享 Cookie / LocalStorage / 登录态，
 * 而且会并发读写同一个 Chromium 分区目录。这正好破坏"多开"这个核心卖点：
 * 用户开第二个窗口想登另一个账号，结果看到的是第一个账号已经登录的界面。
 *
 * ## 怎么解决
 *
 * 每个进程在启动时**独占一个槽位**，槽位号参与分区命名。槽位用锁文件分配：
 *
 *   - 用 `wx`（独占创建）抢锁 —— 文件系统保证只有一个进程能成功
 *   - 锁文件里记 PID；持有者进程已经死了就接管（崩溃不会永久占着槽位）
 *
 * ## 向后兼容（关键）
 *
 * **槽位 1 沿用历史命名**，不加任何前缀：
 *
 *   槽位 1  → `persist:pix-alice-telegram-z-1`   ← 与升级前完全一致
 *   槽位 2+ → `persist:pix-alice-s2-telegram-z-1`
 *
 * 单实例用户（绝大多数）永远拿槽位 1，**升级后不会丢 Telegram / WhatsApp
 * 登录态**。只有真正开了第二个窗口的用户才会用到新命名 —— 而那部分人本来就
 * 还没有可用的隔离，属于修复而非回归。
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SLOT_MIN = 1
const SLOT_MAX = 20
/**
 * 锁文件超过这个时长就无条件视为陈旧。
 *
 * 为什么需要它：PID 会被操作系统复用。如果某个锁的持有者进程早已退出、
 * 而它的 PID 恰好被一个无关进程用上了，`process.kill(pid, 0)` 会一直说
 * "还活着"，这个槽位就永远收不回来。用时间兜底比只信 PID 稳。
 */
const STALE_MS = 7 * 24 * 60 * 60 * 1000

function slotFile(dir, slot) {
  return path.join(dir, '.instance-' + slot + '.lock')
}

function readLock(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (e) {
    return null
  }
}

/**
 * 进程是否还活着。
 *
 * `EPERM` 要当成"活着"：那表示进程存在但当前用户没权限给它发信号，
 * 当成"死了"会导致两个进程抢同一个槽位 —— 正是我们要避免的事。
 */
function processAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (e) {
    return e && e.code === 'EPERM'
  }
}

/**
 * 锁是否已陈旧（持有者没了，或占得太久）。
 *
 * `isAlive` 可注入 —— 测试里不可能真的去 spawn 一堆进程来占槽位，
 * 而拿假 PID 又会被判为"死了"，反而测不到"槽位被活着的人占着"这种情况。
 */
function lockIsStale(record, now, isAlive) {
  if (!record) return true
  const alive = typeof isAlive === 'function' ? isAlive : processAlive
  if (!alive(record.pid)) return true
  const startedAt = Number(record.startedAt)
  if (Number.isFinite(startedAt) && now - startedAt > STALE_MS) return true
  return false
}

/**
 * 抢一个槽位。
 *
 * 返回 `{ slot, file }`。`slot` 为 1..SLOT_MAX 的整数；
 * 全部被占满时退化为 `'x<hex>'` 这种一次性槽位（file 为 null）。
 *
 * **为什么满了还要退化而不是复用**：复用意味着两个实例又共享分区，
 * 那正是这个模块要消灭的问题。宁可让第 21 个窗口拿一个全新的空分区
 * （用户需要重新登录），也不要让两个窗口互相踢下线。
 */
function acquireSlot(dir, options) {
  const opts = options || {}
  const max = Number.isInteger(opts.max) ? opts.max : SLOT_MAX
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const pid = Number.isInteger(opts.pid) ? opts.pid : process.pid
  const isAlive = typeof opts.isAlive === 'function' ? opts.isAlive : processAlive

  fs.mkdirSync(dir, { recursive: true })
  const record = JSON.stringify({ pid, startedAt: now, host: os.hostname() })

  for (let slot = SLOT_MIN; slot <= max; slot++) {
    const file = slotFile(dir, slot)

    // 最多试两轮：第一轮直接抢，第二轮在清掉陈旧锁之后抢。
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(file, record, { flag: 'wx' })
        return { slot, file }
      } catch (e) {
        if (!e || e.code !== 'EEXIST') throw e
      }
      // 已存在：活着就换下一个槽位，死了就清掉再来一次。
      if (!lockIsStale(readLock(file), now, isAlive)) break
      try { fs.unlinkSync(file) } catch (e) { /* 别人抢先删了也无妨 */ }
    }
  }

  return { slot: 'x' + crypto.randomBytes(3).toString('hex'), file: null }
}

/** 归还槽位。退出时调用；抢不到锁的情况（file 为 null）什么也不用做。 */
function releaseSlot(handle) {
  if (!handle || !handle.file) return false
  try {
    const held = readLock(handle.file)
    // 只删自己的锁：万一因为超时被别的进程接管了，不能把别人的锁删掉。
    if (held && Number(held.pid) !== process.pid) return false
    fs.unlinkSync(handle.file)
    return true
  } catch (e) {
    return false
  }
}

/**
 * 分区名中代表槽位的那一段。
 *
 * 槽位 1 返回空串 —— 这是向后兼容的全部秘密：单实例用户的目录名一个字符都不变。
 */
function slotInfix(slot) {
  if (slot === 1) return ''
  if (typeof slot === 'string' && slot) return slot + '-'
  const n = Number(slot)
  return Number.isInteger(n) && n > 1 ? 's' + n + '-' : ''
}

/**
 * 判断一个分区目录名属于哪个平台。
 *
 * 目录名形如 `pix-<用户名>-<平台>-<序号>`（槽位 2+ 还会多一段 `s2-`）。
 * 用户名本身可能含 `-`，平台 ID 也含 `-`（`telegram-z`、`whatsapp-green`），
 * 所以**不能靠前缀匹配** —— 原来的 `name.indexOf('pix-' + id + '-') === 0`
 * 假设名字以平台开头，而实际是以用户名开头，于是永远不命中。
 * 这里改成匹配 `-<平台>-` 整段，两种命名都能认出来。
 */
function partitionBelongsTo(name, platformId) {
  const raw = String(name || '')
  const id = String(platformId || '')
  if (!raw || !id) return false
  return raw.indexOf('-') === 0 ? false : raw.includes('-' + id + '-')
}

module.exports = {
  SLOT_MIN,
  SLOT_MAX,
  STALE_MS,
  acquireSlot,
  releaseSlot,
  slotInfix,
  slotFile,
  processAlive,
  lockIsStale,
  partitionBelongsTo
}
