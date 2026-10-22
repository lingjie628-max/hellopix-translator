'use strict'

/**
 * 异步 + 原子化的 JSON 状态存储。
 *
 * ## 为什么需要它（现状事实）
 *
 * `main.js` 里的 `writeJson()` 是 `fs.writeFileSync`。它的调用点全在**热路径**上：
 *
 * ```
 *   saveOpenApps()   ← did-stop-loading / switchTab / goHome / updateTabSettings
 *   scheduleSaveWindowBounds() ← 拖动窗口（500ms 防抖）
 * ```
 *
 * 而 `saveOpenApps()` 本身要先 `readJson()`（又一次同步读）、再合并所有标签、
 * 最后整份重写。实例多、配置多的时候，这些都是**主进程主线程上的同步 IO** ——
 * 主线程一卡，菜单、拖拽、标签点击全部跟着卡，用户看到的就是「点了没反应」。
 *
 * ## 它还顺手修掉一个数据风险
 *
 * `writeFileSync` 直接覆盖原文件：写到一半断电 / 被杀进程 → 文件变成半截 JSON，
 * 下次启动 `readJson` 返回 fallback，**用户的窗口列表与设置静默丢失**。
 * 这里改成「写临时文件 → rename」：rename 在同一分区上是原子的，
 * 结果只有「旧的完整文件」或「新的完整文件」两种。
 *
 * ## 用法
 *
 * ```js
 * const { createStore } = require('./async-store')
 * const openApps = createStore(path.join(userData, 'open-apps.json'))
 * const data = openApps.get({})          // 读（内存缓存）
 * openApps.set(next)                     // 写（250ms 合并，异步落盘）
 * openApps.set(next, { immediate: true })// 关键路径立刻落盘
 * await openApps.flush()                 // 退出前等它写完
 * ```
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

const DEFAULT_DEBOUNCE_MS = 250

function createStore(file, options) {
  const opts = options || {}
  const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : DEFAULT_DEBOUNCE_MS
  const pretty = opts.pretty !== false
  const onError = opts.onError || (() => {})

  let cache = null
  let loaded = false
  let timer = null
  let writing = null
  let pending = null
  let dirty = false

  function load(fallback) {
    if (loaded) return cache
    loaded = true
    try {
      cache = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      cache = fallback === undefined ? null : fallback
    }
    return cache
  }

  /** 读内存态；首次调用会同步读一次盘（单次、启动期，可接受）。 */
  function get(fallback) {
    if (!loaded) load(fallback)
    return cache
  }

  function schedule() {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      const job = writeNow()
      if (job && typeof job.catch === 'function') job.catch(onError)
    }, debounceMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  async function writeNow() {
    if (!dirty) return
    // 串行化：前一次还没写完就排队，避免两个写交错把文件写坏。
    if (writing) { pending = true; return writing }
    dirty = false
    // 序列化失败（BigInt / 循环引用）时不能让 Promise 直接 reject 掉，
    // 否则这个 rejection 会穿过 set() 的所有调用点变成 unhandledRejection。
    let snapshot
    try {
      snapshot = JSON.stringify(cache, null, pretty ? 2 : 0)
    } catch (error) {
      onError(error)
      return
    }
    const tmp = file + '.tmp-' + process.pid
    writing = (async () => {
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true })
        await fsp.writeFile(tmp, snapshot, 'utf8')
        await fsp.rename(tmp, file)
      } catch (error) {
        // rename 跨设备会失败（极少见）；退化成就地覆盖，至少不丢数据。
        try { await fsp.writeFile(file, snapshot, 'utf8') } catch (e) { onError(e) }
        try { await fsp.unlink(tmp) } catch (e) {}
        onError(error)
      } finally {
        writing = null
        if (pending) { pending = false; await writeNow() }
      }
    })()
    return writing
  }

  function set(next, options2) {
    cache = next
    loaded = true
    dirty = true
    if (options2 && options2.immediate) return writeNow()
    schedule()
    return Promise.resolve()
  }

  /** 改动当前对象（免去整份重建）。 */
  function mutate(fn, options2) {
    const data = get(null) || {}
    const result = fn(data)
    return set(result === undefined ? data : result, options2)
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null }
    if (writing) return writing.then(() => writeNow())
    return writeNow()
  }

  /**
   * 退出前的同步兜底。
   *
   * 只在 `will-quit` / 致命错误里用：那时异步写不一定来得及，
   * 而这份文件关系到用户下次打开看到什么。它不在热路径上。
   *
   * ★ 不能靠 dirty 判断要不要写 ★
   *
   * `writeNow()` 一开始就把 `dirty` 置 false，然后把真正的写盘丢进
   * 异步任务（`fsp.writeFile` + `fsp.rename`）。如果进程恰好在
   * **那一小段异步窗口里**退出：
   *
   *   dirty === false  →  老实现直接 return  →  什么都没写
   *   writing 还挂着   →  进程结束，异步写被掐断
   *   磁盘上仍是旧文件，还可能留一个 `.tmp-<pid>` 垃圾文件
   *
   * 而内存里的 `cache` 始终是最新的（`set()` 同步更新它），所以这里
   * **无条件按 cache 写一次**就是安全的：内容要么和已经落盘的一致
   * （多写一次是幂等的），要么正好补上那块丢失的窗口。
   */
  function flushSync() {
    if (timer) { clearTimeout(timer); timer = null }
    dirty = false
    // 即使 cache 还是 null（从没读过也没写过），也不该写一个 "null" 出来。
    if (cache === null || cache === undefined) return
    // ★ 序列化必须放在 try 里 ★
    //
    // 原来 `JSON.stringify(cache)` 在 try 外面：cache 里只要混进一个 BigInt
    // 或者被意外挂了循环引用，stringify 直接抛 TypeError，而这个函数是在
    // `will-quit` 里调用的 —— 抛出去就是退出流程中断，用户看到的是
    // "关不掉的窗口" 加一份没写完的配置。序列化失败本来是可以兜住的，
    // 没理由让它把退出流程一起带走。
    let snapshot
    try {
      snapshot = JSON.stringify(cache, null, pretty ? 2 : 0)
    } catch (e) {
      onError(e)
      return
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp-' + process.pid
      fs.writeFileSync(tmp, snapshot, 'utf8')
      fs.renameSync(tmp, file)
    } catch (e) {
      try { fs.writeFileSync(file, snapshot, 'utf8') } catch (e2) { onError(e2) }
      onError(e)
    }
  }

  return { get, set, mutate, flush, flushSync, file }
}

module.exports = { createStore, DEFAULT_DEBOUNCE_MS }
