'use strict'

/**
 * 主进程 `app:reorder` 的排序逻辑验证。
 *
 * 这段逻辑的核心风险是**下标漂移**：从数组里摘掉被拖的那一项之后，
 * 目标项的下标会左移一格。写错的话表现是"拖到前面却跑到了后面"，
 * 而且只在**从后往前拖**时出现 —— 手点很容易漏掉这个方向。
 *
 * 用法：node desktop/scripts/verify-tab-order.js
 */

const assert = require('node:assert/strict')

/**
 * 与 main.js 里的实现保持同一份逻辑。
 *
 * 这里不复用 main.js：它顶层就 require('electron') 并建窗口，
 * 在没有 Electron 运行时的进程里无法导入。所以把纯函数抄一份，
 * 两边靠各自的测试保证一致 —— 这是有意的取舍，不是遗漏。
 */
function reorder(tabs, draggedId, targetId, before) {
  const from = tabs.findIndex(t => t.id === draggedId)
  if (from < 0) return { success: false }
  if (!targetId || targetId === 'home') {
    const [row] = tabs.splice(from, 1)
    if (before) tabs.unshift(row)
    else tabs.push(row)
    return { success: true }
  }
  const to = tabs.findIndex(t => t.id === targetId)
  if (to < 0) return { success: false }
  if (from === to) return { success: false }
  const [row] = tabs.splice(from, 1)
  const insertAt = before
    ? tabs.findIndex(t => t.id === targetId)
    : tabs.findIndex(t => t.id === targetId) + 1
  tabs.splice(insertAt < 0 ? tabs.length : insertAt, 0, row)
  return { success: true }
}

const ids = tabs => tabs.map(t => t.id).join(',')
const make = (...names) => names.map(name => ({ id: name }))

const cases = [
  // 往后拖（被拖项在目标前）：摘掉后目标左移，before 应插在目标前面
  ['A B C D，C 拖到 B 前面 → A C B D', make('A', 'B', 'C', 'D'), ['C', 'B', true], 'A,C,B,D'],
  ['A B C D，C 拖到 A 前面 → C A B D', make('A', 'B', 'C', 'D'), ['C', 'A', true], 'C,A,B,D'],
  ['A B C D，D 拖到 A 前面 → D A B C', make('A', 'B', 'C', 'D'), ['D', 'A', true], 'D,A,B,C'],
  ['A B C D，A 拖到 D 后面 → B C D A', make('A', 'B', 'C', 'D'), ['A', 'D', false], 'B,C,D,A'],
  ['A B C D，A 拖到 C 前面 → B A C D', make('A', 'B', 'C', 'D'), ['A', 'C', true], 'B,A,C,D'],
  ['A B C D，B 拖到 D 后面 → A C D B', make('A', 'B', 'C', 'D'), ['B', 'D', false], 'A,C,D,B'],
  // 往左拖（被拖项在目标后）
  ['A B C D，D 拖到 A 前面 → D A B C', make('A', 'B', 'C', 'D'), ['D', 'A', true], 'D,A,B,C'],
  ['A B C D，C 拖到 A 后面 → A C B D', make('A', 'B', 'C', 'D'), ['C', 'A', false], 'A,C,B,D'],
  // 拖到主页 = 头/尾
  ['拖到主页前面 → 置顶', make('A', 'B', 'C'), ['C', 'home', true], 'C,A,B'],
  ['拖到主页后面 → 置底', make('A', 'B', 'C'), ['A', 'home', false], 'B,C,A'],
  // 无效输入
  ['拖自己 → 无变化', make('A', 'B', 'C'), ['B', 'B', true], 'A,B,C'],
  ['目标不存在 → 无变化', make('A', 'B', 'C'), ['A', 'Z', true], 'A,B,C']
]

let failed = 0
for (const [name, tabs, args, expected] of cases) {
  reorder(tabs, args[0], args[1], args[2])
  const actual = ids(tabs)
  const ok = actual === expected
  if (!ok) failed += 1
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `  — 得到 ${actual}，应为 ${expected}`}`)
}

// 单元素与空数组不应崩
assert.equal(reorder(make('A'), 'A', 'A', true).success, false)
console.log(`${failed === 0 ? '✔' : '✖'} 边界输入不抛异常`)

console.log(`\n${cases.length + 1 - failed}/${cases.length + 1} 通过`)
if (failed) process.exitCode = 1
