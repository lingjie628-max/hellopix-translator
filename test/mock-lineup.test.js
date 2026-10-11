'use strict'

/**
 * 开发用 mock 必须与**生产实况**一致。
 *
 * ## 为什么值得单独守一道
 *
 * `mock/index.js` 是本地开发的"生产模拟器"：`vue.config.js` 在没有真后端时
 * 用它接管 `/apis/*`。它一旦漂移，本地就会看到**和线上不是同一个产品**，
 * 而这种错觉只有部署之后才暴露 —— 排查成本极高。
 *
 * 实际漂移（2026-10-11 修）：
 *   · 通道清单里躺着一个**生产上根本不存在的 `baidu`**（`providers` 里没有它的适配器）；
 *   · 所有通道都写成 `enabled: 1, wired: 0`（"在架但没接通"），
 *     而生产是 `deepseek` + `gpt` 两条在架**且已接通**、其余全部退役 —— 完全相反；
 *   · 套餐卡片还在宣传已下架的通道（谷歌 / DeepL / AWS / 百度 / 小牛）；
 *   · FAQ 里写着 200 / 350 / 850 元的过期价格与 150 万字符的旧额度。
 *
 * ## 判据
 *
 * 1. mock 里每个通道 id 都必须在**真实适配器注册表**里有实现
 *    （"登记了但调不通"正是百度那类占位通道的问题）；
 * 2. mock 里 `enabled` 的通道集合 = 生产在架集合 `{deepseek, gpt}`；
 * 3. 套餐宣传/授权的通道，必须在 mock 里是 enabled 的；
 * 4. 套餐额度文案的数字 = `chars`，且与迁移 044 的阶梯一致。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const mock = fs.readFileSync(path.join(root, 'mock/index.js'), 'utf8')

const { providers } = require('../server/services/translation-provider')
const { LADDER } = require('../migrations/044_package_ladder_monotonic')

/** 生产在架且已接通的通道（2026-10-11 复核 engines 表得出）。 */
const PRODUCTION_LIVE = ['deepseek', 'gpt']

/**
 * 取出 mock 里**顶层**的 `engines: [ ... ]` 这一段。
 *
 * ⚠️ 不能用 `indexOf('engines: [')`：套餐行里也有 `engines: ['deepseek', 'gpt']`，
 * 而那几行位于 `versions:` 数组内、位置更靠前 —— 会先命中套餐的，切错块。
 * 顶层这条是 4 空格缩进的独立属性，用行首锚定才准。
 */
function enginesBlock() {
  const m = /\n {4}engines: \[/.exec(mock)
  assert.ok(m, 'mock 里找不到顶层的 engines 数组（结构变了？）')
  const start = m.index
  const end = mock.indexOf('\n    ],', start)
  assert.ok(end > start, 'engines 数组没有正常收尾')
  return mock.slice(start, end)
}

/** 取出 `versions: [ ... ]`（套餐数组）这一段。 */
function packagesBlock() {
  const start = mock.indexOf('versions: [')
  assert.ok(start > 0, 'mock 里找不到 versions 数组')
  const end = /\n {4}engines: \[/.exec(mock.slice(start))
  assert.ok(end, 'packages 块没有正常收尾')
  return mock.slice(start, start + end.index)
}

/** 解析 mock 的通道行：`{ id: 'x', name: '...', ... enabled: N, wired: M ... }` */
function mockEngines() {
  const rows = []
  const re = /\{\s*id:\s*'([a-z0-9]+)',[\s\S]*?enabled:\s*(\d),\s*wired:\s*(\d)/g
  let m
  while ((m = re.exec(enginesBlock())) !== null) {
    rows.push({ id: m[1], enabled: Number(m[2]), wired: Number(m[3]) })
  }
  return rows
}

test('mock 的每个通道都有真实适配器实现（不允许占位通道）', () => {
  const rows = mockEngines()
  assert.ok(rows.length > 0, '没解析出任何通道 —— 正则或 mock 结构变了')

  for (const row of rows) {
    assert.ok(providers[row.id],
      `mock 里的通道「${row.id}」在 providers 注册表里没有适配器。`
      + '这正是"登记了但调不通"的占位通道 —— 百度当年就是这么混进来的')
  }
})

test('mock 里"在架"的通道集合与生产一致（只有 DeepSeek 与 GPT）', () => {
  const live = mockEngines().filter(e => e.enabled === 1).map(e => e.id).sort()
  assert.deepEqual(live, [...PRODUCTION_LIVE].sort(),
    'mock 的在架通道与生产不一致 —— 本地会看到线上没有（或没有的）通道。'
    + '生产实况：只有 deepseek 与 gpt 在架且已接通')
})

test('mock 里在架的通道必须是"已接通"（wired: 1）', () => {
  for (const row of mockEngines()) {
    if (row.enabled === 1) {
      assert.equal(row.wired, 1,
        `mock 的「${row.id}」标成在架却没接通（wired: 0）—— 生产上在架的两条都是接通的，`
        + '本地不该看到"选得中但翻不了"的通道')
    }
  }
})

test('mock 里不得出现生产上不存在的通道（例如已删除的 baidu）', () => {
  assert.doesNotMatch(mock, /'baidu'/, 'mock 里又有 baidu 了 —— 生产 engines 表里没有这条')
})

test('mock 套餐只宣传/授权在架的通道', () => {
  const live = new Set(mockEngines().filter(e => e.enabled === 1).map(e => e.id))

  // 每个套餐的 engines 数组
  const pkgRe = /engines:\s*\[([^\]]*)\]/g
  const scan = packagesBlock()
  let m
  let checked = 0
  while ((m = pkgRe.exec(scan)) !== null) {
    const ids = m[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean)
    for (const id of ids) {
      assert.ok(live.has(id),
        `mock 的套餐授权了「${id}」，但它不在 mock 的在架通道里（更不在生产里）`)
    }
    checked += 1
  }
  assert.ok(checked >= 3, `只检查到 ${checked} 个套餐的 engines，应有 3 档`)
})

test('mock 套餐不再宣传已下架的通道名', () => {
  // 这九个名字都随迁移 039 一起下架了，不得再出现在套餐文案里
  for (const name of ['谷歌', '百度', '小牛', 'DEEPL', 'DeepL', '亚马逊', 'AWS', '通义千问', '豆包', 'GLM', 'MiniMax', 'Mistral', 'Claude', 'Grok', 'Kimi']) {
    // 只在 packages 的文案里查（engines 清单里保留退役通道是对的）
    const block = packagesBlock()
    assert.ok(!block.includes(name),
      `mock 的套餐文案里还在宣传已下架的「${name}」—— 客户会为它买套餐然后翻译失败`)
  }
})

test('mock 套餐的额度文案与阶梯一致（数字 = chars）', () => {
  const block = packagesBlock()
  for (const p of LADDER) {
    assert.ok(block.includes(`chars: ${p.chars}, price: ${p.price},`),
      `mock 缺少 chars: ${p.chars}, price: ${p.price} —— 与迁移 044 的阶梯对不上`)
    assert.ok(block.includes(`${p.chars / 10000}万字符`),
      `mock 的 ${p.code} 额度文案没写对（应为 ${p.chars / 10000}万字符）`)
  }
})

test('mock 的 FAQ 价格不再是过期的 200/350/850 元', () => {
  assert.doesNotMatch(mock, /基础\s*200\s*元/, 'mock 的 FAQ 还写着"基础 200 元"的过期价格')
  assert.doesNotMatch(mock, /专业\s*850\s*元/, 'mock 的 FAQ 还写着"专业 850 元"的过期价格')
})
