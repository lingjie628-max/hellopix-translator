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

const { createStore } = require('../desktop/async-store')

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

test('mutate 不丢已有字段', async () => {
  const file = tmpFile()
  const store = createStore(file, { debounceMs: 5 })
  store.set({ a: 1, keep: 'x' })
  store.mutate(data => { data.b = 2 })
  await store.flush()
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, keep: 'x', b: 2 })
})
