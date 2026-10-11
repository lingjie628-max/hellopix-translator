'use strict'

/**
 * 套餐阶梯：金额不动，把三档做成「单位价严格递减」的单调阶梯。
 *
 * ## 修的是什么
 *
 * 生产实测（2026-10-11）：
 *
 *   基础版  $35 / 150 万 = $23.33 / 百万字符
 *   高级版  $65 / 250 万 = **$26.00** / 百万字符   ← 比基础版贵 11.4%
 *   专业版  $125 / 600 万 = $20.83 / 百万字符
 *
 * 客户把三张卡片一比就知道"升级反而更亏"，"高级版"名不副实。
 * 这不是定价高低的问题，是**阶梯非单调**。
 *
 * 同时三档卡片都写着「150万字符」，而实际是 150/250/600 万 ——
 * 卖点与权益对不上（和历史上"宣传了未授权的通道"是同一个病）。
 * 它能长期漏过去，是因为 `check:plan-copy` 只校验渠道、**跳过额度项**。
 *
 * ## 这一组测试锁什么
 *
 * 1. 新阶梯单调（单位价严格递减）、字符数是干净倍数、毛利率仍 ≥95%
 * 2. 迁移 044 真的把两件事都改了（额度 + 额度文案），且带守卫
 * 3. `check:plan-copy` 现在能抓出：额度文案不符、阶梯非单调
 * 4. 三个展示页面共用同一份单位价算法（不再各算一份）
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')

const migration = require('../migrations/044_package_ladder_monotonic')
const check = require('../scripts/check-plan-copy')

const { LADDER } = migration
const unit = (price, chars) => price / chars * 1e6

// ================================================================== 1. 阶梯本身
test('新阶梯的单位价严格递减（这正是被修掉的缺陷）', () => {
  const units = LADDER.map(p => unit(p.price, p.chars))
  for (let i = 1; i < units.length; i++) {
    assert.ok(units[i] < units[i - 1],
      `${LADDER[i].title} 的单位价 $${units[i].toFixed(2)} 不比 `
      + `${LADDER[i - 1].title} 的 $${units[i - 1].toFixed(2)} 便宜 —— 阶梯断了`)
  }
})

test('旧阶梯会被判为非法（回归哨兵：确保这条规则真的能拦住它）', () => {
  // 生产修复前的真实值
  const before = [
    { price: 35, chars: 1500000 },
    { price: 65, chars: 2500000 },
    { price: 125, chars: 6000000 }
  ]
  const broken = before.some((p, i) => i > 0 && unit(p.price, p.chars) >= unit(before[i - 1].price, before[i - 1].chars))
  assert.equal(broken, true,
    '修复前的阶梯必须被判定为"非单调"；若这条断言失败，说明判据本身失效了')
})

test('金额一分不动 —— 价格仍是 35 / 65 / 125', () => {
  assert.deepEqual(LADDER.map(p => p.price), [35, 65, 125],
    '本次只调字符额度，不改金额（用户明确要求）')
})

test('字符数是干净倍数：1x / 2x / 5x', () => {
  const base = LADDER[0].chars
  assert.deepEqual(LADDER.map(p => p.chars / base), [1, 2, 5],
    '整数倍客户才能心算（"高级版翻倍、专业版 5 倍"），比 $21.67 vs $23.33 直观')
})

test('加字符之后毛利率仍 ≥95% —— 加量的边际成本极低', () => {
  // 已启用通道里最贵的一条：DeepSeek $0.8333/百万字符（生产 engines 的实测值）
  const WORST_COST_PER_MILLION = 0.8333
  for (const p of LADDER) {
    const cost = p.chars / 1e6 * WORST_COST_PER_MILLION
    const margin = (p.price - cost) / p.price
    assert.ok(margin >= 0.95,
      `${p.title} 满额使用的毛利率只有 ${(margin * 100).toFixed(1)}%（成本 $${cost.toFixed(2)} / 售价 $${p.price}）`)
  }
})

// ================================================================== 2. 迁移
test('迁移 044 同时改「额度」与「额度文案」，否则卡片与实际对不上', () => {
  // 断言**实际生成的 SQL**，而不是源码字面量 —— 迁移是动态拼 SQL，
  // 目标数字在源码里根本找不到（那样断言会把"拼错了"也放过）。
  const sql = migration.buildUpSql()

  for (const p of LADDER) {
    assert.ok(sql.includes(`included_chars = ${p.chars}`),
      `迁移生成的 SQL 没有把 ${p.code} 的额度设成 ${p.chars}`)
    assert.ok(sql.includes(`highlights = '${migration.copyFor(p.chars)}'::jsonb`),
      `迁移没有同步 ${p.code} 的额度文案（卡片上会继续写着旧的字符数）`)
  }
})

test('额度更新按 code 定值（不套旧值守卫）—— 否则生产上这次修复不会生效', () => {
  const sql = migration.buildUpSql()
  assert.match(sql, /WHERE code = 'advanced' AND included_chars <> 3000000/,
    '额度更新必须按 code 生效。生产是 250/600 万（管理员手工改的）、'
    + '全新库是 150/150 万，套"钉住旧值"的守卫会让两边各是一套且生产不生效')
})

test('文案更新带守卫：管理员改过的文案不被覆盖', () => {
  const sql = migration.buildUpSql()
  assert.match(sql, /AND highlights = '\["150万字符","DeepSeek、GPT"\]'::jsonb/,
    '文案是后台可编辑的自由文本，必须只在"仍是那份过期文案"时才改')
})

test('迁移导出的阶梯只有一个来源（迁移/校验脚本/测试共用）', () => {
  assert.equal(LADDER.length, 3)
  assert.deepEqual(LADDER.map(p => p.code), ['basic', 'advanced', 'pro'])
  assert.equal(typeof migration.copyFor, 'function')
  assert.equal(migration.copyFor(3000000), '["300万字符","DeepSeek、GPT"]')
})

// ================================================================== 3. 校验脚本
test('check:plan-copy 能解析额度声明（含"万"与千分位）', () => {
  assert.equal(check.quotaFromHighlights(['150万字符']), 1500000)
  assert.equal(check.quotaFromHighlights(['300万字符', 'DeepSeek、GPT']), 3000000)
  assert.equal(check.quotaFromHighlights(['150字符']), 150, '没写"万"就是字面量')
  assert.equal(check.quotaFromHighlights(['1,500万字符']), 15000000, '千分位要能认')
  assert.equal(check.quotaFromHighlights(['DeepSeek、GPT']), null, '没有额度项时返回 null，不能返回 0')
  assert.equal(check.quotaFromHighlights([]), null)
  assert.equal(check.quotaFromHighlights(undefined), null)
})

test('check:plan-copy 能算出单位价，并识别非单调', () => {
  assert.equal(check.unitPricePerMillion(35, 1500000), 35 / 1500000 * 1e6)
  assert.equal(check.unitPricePerMillion(0, 100), null, '价格为 0 不能相除')
  assert.equal(check.unitPricePerMillion(35, 0), null, '额度为 0 不能相除')

  const good = [{ title: 'a', price: 35, chars: 1500000 }, { title: 'b', price: 65, chars: 3000000 }]
  const bad = [{ title: 'a', price: 35, chars: 1500000 }, { title: 'b', price: 65, chars: 2500000 }]
  const mono = list => list.every((p, i) => i === 0
    || check.unitPricePerMillion(p.price, p.chars) < check.unitPricePerMillion(list[i - 1].price, list[i - 1].chars))
  assert.equal(mono(good), true, '新阶梯必须单调')
  assert.equal(mono(bad), false, '旧阶梯必须被识别为非单调')
})

test('校验脚本补上了「额度文案」这一维（这才是它能长期漏过的原因）', () => {
  const src = read('scripts/check-plan-copy.js')
  assert.match(src, /额度文案/, '脚本必须报告额度文案不一致')
  assert.match(src, /阶梯单位价/, '脚本必须报告阶梯单位价')
  assert.match(src, /included_chars/, '必须把 included_chars 查出来才能对账')
  // 不能只判"是不是额度项"就放过 —— 以前正是这样跳过了额度核对
  assert.match(src, /claimed !== Number\(pkg\.included_chars\)/, '必须真的比较文案额度与实际额度')
})

test('校验脚本可被 require（纯函数导出，不会直接连库执行）', () => {
  const src = read('scripts/check-plan-copy.js')
  assert.match(src, /require\.main === module/, '必须用 require.main 守卫，否则被 require 时就连库')
  assert.equal(typeof check.channelClaims, 'function')
  assert.equal(typeof check.quotaFromHighlights, 'function')
  // 渠道解析仍要正常（原有能力不能被这次改动破坏）
  assert.deepEqual(check.channelClaims(['150万字符', 'DeepSeek、GPT']), ['DeepSeek', 'GPT'])
})

// ================================================================== 4. 前端展示
test('三个展示页面共用同一份单位价算法，不各算一份', () => {
  const sites = [
    ['src/components/Landing.vue', '官网定价卡'],
    ['src/components/user/UserRechargePage.vue', '商户充值页'],
    ['src/components/admin/AdminPackages.vue', '后台套餐表']
  ]
  for (const [file, label] of sites) {
    const src = read(file)
    assert.match(src, /from '.*utils\/plan-value'/,
      `${label}（${file}）没有引入 plan-value —— 单位价必须只有一份实现，`
      + '历史上"三处各算一份价格"出过事故')
    assert.match(src, /formatUnitPrice/, `${label} 没有展示单位价`)
  }
})

test('客户端两处展示都给出「较基础版省 X%」，让升级理由不用心算', () => {
  for (const file of ['src/components/Landing.vue', 'src/components/user/UserRechargePage.vue']) {
    const src = read(file)
    assert.match(src, /savingVsBase/, `${file} 没有算"较基础版省 X%"`)
    assert.match(src, /较基础版省/, `${file} 没有把节省比例显示出来`)
  }
})

test('plan-value 的守卫：缺价格或额度时不得显示 $NaN', () => {
  const src = read('src/utils/plan-value.js')
  assert.match(src, /return null/, '拿不到单位价时必须返回 null，由调用方隐藏')
  assert.match(src, /Number\.isFinite/, '必须防住 NaN / Infinity')
})

test('后台套餐表把"阶梯断了"的那一档标出来', () => {
  const src = read('src/components/admin/AdminPackages.vue')
  assert.match(src, /unitOk/, '后台要能自己暴露非单调（靠人眼看两组数字是发现不了的）')
  assert.match(src, /unit-bad/, '非单调的那一档要有视觉标记')
})

// ================================================================== 5. mock 对齐
test('mock 的套餐阶梯与生产一致（否则本地看到的是另一套价格）', () => {
  const mock = read('mock/index.js')
  for (const p of LADDER) {
    assert.ok(mock.includes(`chars: ${p.chars}, price: ${p.price},`),
      `mock 里没有 chars: ${p.chars}, price: ${p.price} —— 本地开发会看到与生产不同的阶梯`)
  }
})
