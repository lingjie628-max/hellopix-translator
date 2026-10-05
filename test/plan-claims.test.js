'use strict'

/**
 * 「套餐承诺的端」与「在架安装包」必须对得上 —— 把这次的修法钉住。
 *
 * ## 背景
 *
 * 同一种事故已经发生过两次：
 *   · 「手机版」：三个套餐都承诺，`client_releases` 里没有任何 android/ios —— 迁移 035；
 *   · 「独立应用版」：三个套餐都承诺，`release_group='standalone'` 一条都没有 —— 迁移 036。
 *
 * 两次都是「写在套餐权益里、后面没有东西」，客户付完钱才发现，属于退款/拒付风险。
 *
 * ## 这个文件锁三件事
 *
 *   1. 迁移 036 存在、且确实把三个套餐的这条承诺摘掉了（摘不掉就等于没修）；
 *   2. 迁移 036 的 `down` 能把承诺还回来 —— 将来独立应用真上架时要能恢复；
 *   3. `check-plan-copy.js` 判定 standalone 的依据是 `release_group`，
 *      **不是**主客户端的 `os` —— 老规则 `/windows|macos/` 让这条事故长期通过校验。
 *
 * 为什么用源码断言而不是连库跑：`check-plan-copy.js` 需要一个真实库才能跑，
 * 而这两个性质本身是**静态可判**的（迁移里写了什么、守卫拿什么判定）。
 * 连库那一步由发布前的收口流程负责（见审计报告的最小任务集合）。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')

const MIGRATION = 'migrations/036_remove_unbacked_standalone_claim.js'
const CLAIM = '独立应用版'

test('迁移 036 存在且编号唯一（迁移必须单向前进）', () => {
  const files = fs.readdirSync(path.join(root, 'migrations')).filter(f => f.endsWith('.js'))
  assert.ok(files.includes('036_remove_unbacked_standalone_claim.js'),
    '找不到迁移 036 —— 「独立应用版」这个承诺就没有被摘掉')

  const numbered = files.map(f => Number(f.slice(0, 3))).filter(Number.isInteger).sort((a, b) => a - b)
  // 只锁"编号唯一"与"036 在链上"，**不锁**"036 是最大编号" ——
  // 否则每新增一个迁移都要回来改这个测试，测试会变成噪音。
  assert.equal(new Set(numbered).size, numbered.length, '迁移编号有重复')
  assert.ok(numbered.includes(36), '编号 036 不在迁移链上')
})

test('迁移 036 把三个套餐的「独立应用版」承诺摘掉，并把 clients.standalone 置为 false', () => {
  const src = read(MIGRATION)

  // 手术式删除：只移除相等的那个元素，不整段覆盖（保留管理员的其他编辑）。
  assert.match(src, /highlights\s*-\s*'独立应用版'/, '没有移除 highlights 里的「独立应用版」')
  assert.match(src, /"standalone":\s*false/, '没有把 clients.standalone 置为 false')

  // 三个在售套餐都要覆盖到，漏一个就还有一个套餐在承诺。
  assert.match(src, /\[\s*1\s*,\s*2\s*,\s*3\s*\]/,
    '迁移没有覆盖全部三个在售套餐（应为 [1, 2, 3]）')
})

test('迁移 036 的 down 能恢复承诺（独立应用将来上架时要能回滚）', () => {
  const src = read(MIGRATION)
  const down = src.slice(src.indexOf('exports.down'))
  assert.ok(down.length > 0, '没有 exports.down —— 无法回滚')
  assert.match(down, /highlights\s*\|\|\s*'\["独立应用版"\]'/, 'down 没有把「独立应用版」加回 highlights')
  assert.match(down, /"standalone":\s*true/, 'down 没有把 clients.standalone 置回 true')
})

test('★ check-plan-copy 判定 standalone 的依据是 release_group，不是主客户端的 os', () => {
  const src = read('scripts/check-plan-copy.js')

  // 老规则：把 windows/macos 主客户端安装包当成了独立应用的凭证。
  assert.doesNotMatch(src, /\[\s*'standalone'[^\]]*\/windows\|macos/i,
    'check-plan-copy 又用 windows/macos 判定 standalone 了 —— ' +
    '那会让「承诺独立应用版、却一条 standalone 记录都没有」重新通过校验')

  assert.match(src, /groupId\(row\.release_group\)\s*===\s*'standalone'/,
    'check-plan-copy 没有按 release_group 判定 standalone')

  // 判定依据得真的被查出来，否则 match(row) 永远拿到 undefined。
  assert.match(src, /release_group/, '查询 client_releases 时没有取 release_group 列')
})

test('开发用 mock 不再带着这条承诺（避免被当成种子样本抄回去）', () => {
  const src = read('mock/index.js')
  assert.doesNotMatch(src, /'独立应用版'/, 'mock 里还有「独立应用版」')
  assert.doesNotMatch(src, /standalone:\s*1/, 'mock 里还有 standalone: 1')
})
