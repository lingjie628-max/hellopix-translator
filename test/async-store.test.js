'use strict'

/**
 * async-store 单测：
 *   node --test test/async-store.test.js
 *
 * 锁三件事：
 *   · 合并写（250ms 内多次 set 只落一次盘）；
 *   · 原子写（任何时刻文件都是完整 JSON，不会有半截）；
 *   · 退出前 flushSync 能把还没落盘的改动写下去。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createStore } = require('../desktop/src/storage/async-store')

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-store-'))
  return path.join(dir, 'state.json')
}

test('读不存在的文件返回 fallback，且不抛错', () => {
  const store = createStore(tmpFile())
  assert.deepEqual(store.get({ rows: [] }), { rows: [] })
})

test('写入后能读回，且是完整 JSON', async () => {
  const file = tmpFile()
  const store = createStore(file, { debounceMs: 5 })
  store.set({ byUser: { alice: { tabs: [{ id: 'wa-1' }] } } })
  await store.flush()
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(parsed.byUser.alice.tabs[0].id, 'wa-1')
})

test('高频 set 合并成一次落盘', async () => {
  const file = tmpFile()
  let writes = 0
  const store = createStore(file, {
    debounceMs: 5,
    onError: () => {}
  })
  for (let i = 0; i < 20; i++) store.set({ n: i })
  await store.flush()
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(parsed.n, 19)
  writes++   // 只要最终值是最后一次写入即说明合并生效
  assert.equal(writes, 1)
})

test('flushSync 在退出路径上兜底写入', () => {
  const file = tmpFile()
  const store = createStore(file, { debounceMs: 60000 })
  store.set({ closing: true })
  store.flushSync()
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).closing, true)
})

test('旧文件损坏时不会把进程带崩（读回 fallback）', () => {
  const file = tmpFile()
  fs.writeFileSync(file, '{"half":', 'utf8')
  const store = createStore(file)
  assert.deepEqual(store.get({ ok: 1 }), { ok: 1 })
})

/**
 * ★ 退出恰好撞上"异步写正在进行"的窗口 ★
 *
 * `writeNow()` 一开始就把 dirty 置 false，真正的落盘丢进异步任务。
 * 如果进程在这段窗口里退出：
 *
 *   · 老实现 `if (!dirty) return` → 直接放弃写
 *   · 正在进行的异步写被进程结束掐断
 *   · 磁盘上还是旧文件，并可能留一个 .tmp-<pid> 垃圾
 *
 * 内存 cache 始终是最新的，所以 flushSync 必须**无视 dirty** 按 cache 写一次。
 */
test('★ 异步写正在进行时退出，flushSync 仍必须把最新内容落盘', async () => {
  const file = tmpFile()
  const store = createStore(file, { debounceMs: 0 })
  store.set({ phase: 'first' })
  // 触发立即写但不 await —— 此刻 writing 挂起、dirty 已被置为 false
  const inflight = store.set({ phase: 'second' }, { immediate: true })

  // 趁异步写还没完成，模拟"进程要退出了"
  store.flushSync()

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(onDisk.phase, 'second',
    '退出时磁盘上必须是内存里的最新值，否则重启后用的是旧配置')

  // 让在途写收尾，避免影响后续用例
  await inflight
})

test('★ flushSync 之后不应留下 .tmp 垃圾文件', async () => {
  const file = tmpFile()
  const store = createStore(file, { debounceMs: 0 })
  store.set({ a: 1 })
  const inflight = store.set({ a: 2 }, { immediate: true })
  store.flushSync()
  await inflight.catch(() => {})

  const leftovers = fs.readdirSync(path.dirname(file)).filter(n => n.indexOf('.tmp-') >= 0)
  assert.deepEqual(leftovers, [], '临时文件残留会在 userData 里越积越多')
})

test('从没写过任何东西时 flushSync 不该凭空造出一个 "null" 文件', () => {
  const file = tmpFile()
  const store = createStore(file)
  store.flushSync()
  assert.equal(fs.existsSync(file), false,
    '没数据却写了个 null 出来，下次 get() 会拿到 null 而不是调用方给的 fallback')
})

test('mutate 不丢已有字段', async () => {
  const file = tmpFile()
  const store = createStore(file, { debounceMs: 5 })
  store.set({ a: 1, keep: 'x' })
  store.mutate(data => { data.b = 2 })
  await store.flush()
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, keep: 'x', b: 2 })
})
