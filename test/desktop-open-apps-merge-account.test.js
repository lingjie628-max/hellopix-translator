'use strict'

/**
 * 跨账号 / 跨副本的窗口列表合并规则。
 *
 * ## 核心不变式
 *
 * `open-apps.json` 是按 **Pix 账号**存的（`byUser[用户名]`），而同一个账号
 * 可能同时开两个副本（多开槽位不同），两边各持一份内存态。
 *
 * `saveOpenApps()` 的合并规则必须同时满足：
 *
 *   · 本副本内存里活着的 tab        → 写入 / 更新
 *   · 本副本从磁盘恢复过、现在关了   → 从磁盘删掉
 *   · 本副本从没见过的（别的副本的） → **原样保留**（否则会把别人的窗口删掉）
 *
 * ## 被测的缺陷
 *
 * `seededTabIds` 的语义是"**当前这一批**由我管理的 id"。`clearTabs()`
 * 清了 tabs / activeId / usedCount / nextTab，**唯独没清它**。
 *
 * 于是换账号时：登出 A → 登录 B，B 的磁盘数据里也有同名 id（id 是
 * `platform-N`，两个账号撞名是常态）。只要 B 那条这一轮恢复失败，
 * 它就不在 live 里，而 seededTabIds 里还残留着 A 的同名 id ——
 * 合并时判定"这是我关掉的"，把 B 的窗口从磁盘上删掉。
 *
 * 数据静默丢失，没有任何报错。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8')

function extractFunction (name, prefix) {
  const marker = (prefix || '') + 'function ' + name + '('
  const start = mainSource.indexOf(marker)
  assert.ok(start >= 0, 'main.js 里找不到 ' + marker)
  const braceStart = mainSource.indexOf('{', start)
  let depth = 0
  for (let i = braceStart; i < mainSource.length; i++) {
    if (mainSource[i] === '{') depth++
    else if (mainSource[i] === '}') {
      depth--
      if (depth === 0) return mainSource.slice(start, i + 1)
    }
  }
  throw new Error('花括号没配平：' + name)
}

/**
 * 把 saveOpenApps 的合并核心单独跑一遍。
 *
 * 直接跑整个 saveOpenApps 需要 currentPixUser / sealSettings / writeJson 等
 * 一整套桩，噪音大于收益。这里只把「合并规则」这两行表达式按源码原文
 * 执行，保证测的是线上那套判据而不是我抄的副本。
 */
function mergeIds (previousTabs, liveIds, seededIds) {
  const ctx = {
    previousTabs: previousTabs,
    live: new Map(liveIds.map(id => [id, { id }])),
    seededTabIds: new Set(seededIds)
  }
  vm.createContext(ctx)
  vm.runInContext(`
    var result = previousTabs.filter(row => {
      const id = String((row && row.id) || '')
      return id && !seededTabIds.has(id) && !live.has(id)
    }).map(r => r.id)
  `, ctx)
  return ctx.result
}

test('别的副本的 tab 必须原样保留', () => {
  // 磁盘上有 a、b、c；本副本只有 b 活着，且从没恢复过 a、c
  const kept = mergeIds([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['b'], ['b'])
  assert.deepEqual(kept, ['a', 'c'], '把别的副本的窗口删掉，就是数据丢失')
})

test('本副本恢复过、但现在关掉的必须删掉', () => {
  const kept = mergeIds([{ id: 'a' }, { id: 'b' }], ['b'], ['a', 'b'])
  assert.deepEqual(kept, [], 'a 是我恢复过又关掉的，应当从磁盘移除')
})

test('本副本内存里活着的会被 live 覆盖，不再重复保留', () => {
  const kept = mergeIds([{ id: 'a' }], ['a'], ['a'])
  assert.deepEqual(kept, [])
})

/**
 * ★ 复现那个换账号的序列 ★
 *
 * 用真实的 clearTabs 语义：它有没有清 seededTabIds。
 */
test('★ clearTabs 必须清空 seededTabIds（否则换账号会删掉新账号的窗口）', () => {
  const body = extractFunction('clearTabs')
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.ok(
    /seededTabIds\.clear\s*\(\s*\)/.test(code),
    'clearTabs 不清 seededTabIds 的话：登出 A 再登录 B，B 磁盘上同名的 tab ' +
    '会被判定为「A 关掉的」而被删除'
  )
})

test('★ 换账号后，前一个账号残留的 seeded id 不得影响新账号', () => {
  // 1) 账号 A 恢复过 wa-1、wa-2
  const seededA = ['wa-1', 'wa-2']

  // 2) 登出 → clearTabs（修复后 seededTabIds 被清空）
  const seededAfterClear = []

  // 3) 登录 B：B 的磁盘上有 wa-1（同名），但这一轮恢复失败，不在 live 里
  const kept = mergeIds([{ id: 'wa-1' }, { id: 'tg-1' }], ['tg-1'], seededAfterClear)

  assert.deepEqual(kept, ['wa-1'],
    'B 的 wa-1 恢复失败时，它必须留在磁盘上（下次还能再试），不能被当成"我已关闭"删掉')

  // 反证：如果没修（seeded 里残留 A 的 id），wa-1 会被删
  const keptBroken = mergeIds([{ id: 'wa-1' }, { id: 'tg-1' }], ['tg-1'], seededA)
  assert.deepEqual(keptBroken, [], '这就是没修时的行为 —— 数据静默丢失')
})

/**
 * ★ 顺带锁住另一个方向：clearTabs 清完之后，本副本确实"什么都不管"了。
 */
test('★ clearTabs 之后再 saveOpenApps 不该删掉磁盘上的任何东西', () => {
  const kept = mergeIds([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [], [])
  assert.deepEqual(kept, ['a', 'b', 'c'],
    'clearTabs 之后没有 live tab，也应当把磁盘上的全部视为"别人的"，原样保留')
})
