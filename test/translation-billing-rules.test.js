/**
 * V1.0.x 前期计费规则的固化测试（2026-10-06）。
 *
 * 规则原文：
 *   1. 仅开放 DeepSeek / GPT
 *   2. 两个通道共用同一个 char_balance
 *   3. 扣费倍率：DeepSeek = 1.0x，GPT = 1.0x
 *   4. 翻译多少计费字符就扣多少（1000 计费字符 → 扣 1000）
 *   5. 不建立独立 GPT 余额
 *   6. 不建立独立 DeepSeek 余额
 *   7. translate_logs 继续记录 engine / chars / cost / latency / cached
 *   8. engine multiplier 推迟到 V1.1
 *
 * 为什么规则 2–8 用「扫源码」而不是跑库断言：
 *   它们是**结构不变量**（没有倍率、只有一本账、扣费与通道无关）。
 *   用固定输入断言输出，很难覆盖「有人在扣费那行偷偷乘了 0.8」这类回归；
 *   直接钉住计费那一行的形状，才防得住这种改动。
 *   规则 1 另有一次真机迁移验证（见提交说明），这里钉的是迁移导出的断言面。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

const CORE = read('server/services/core-service.js')
const REPO = read('server/repositories/production-repository.js')

const MIGRATION_039 = require('../migrations/039_translation_lineup_v3_gpt_deepseek')
const provider = require('../server/services/translation-provider')

// ---------------------------------------------------------------------------
// 规则 1：仅开放 DeepSeek / GPT
// ---------------------------------------------------------------------------

test('规则1：只开放 DeepSeek 与 GPT，其余通道一律下架', () => {
  assert.deepEqual(MIGRATION_039.targetEngineIds, ['gpt', 'deepseek'])

  // 下架集合由 031 的阵容算出来，不手抄 —— 但恰好就是这 9 个（032–038 未动通道）。
  assert.deepEqual(
    [...MIGRATION_039.retiredEngineIds].sort(),
    ['claude', 'doubao', 'glm', 'google', 'grok', 'kimi', 'minimax', 'mistral', 'qwen'],
    '除 gpt / deepseek 外的通道都应下架'
  )
})

test('规则1：下架用的是通用判据，不是手抄清单', () => {
  const src = read('migrations/039_translation_lineup_v3_gpt_deepseek.js')
  // 「凡不在目标名单里、且当前未下架」的一律下架 —— 写死一份旧通道清单会漏下架。
  assert.match(
    src,
    /id NOT IN \(\$\{idList\(TARGET_ENGINE_IDS\)\}\)[\s\S]{0,80}?retired_at IS NULL/,
    '下架 SQL 必须按「不在目标名单里」判定'
  )
})

test('规则1：三档套餐在 v3 里都只含 {gpt, deepseek}', () => {
  const ids = new Set(MIGRATION_039.packageEnginesV3.map(([, id]) => id))
  assert.deepEqual([...ids].sort(), ['deepseek', 'gpt'])
  for (const code of ['basic', 'advanced', 'pro']) {
    assert.ok(
      MIGRATION_039.packageEnginesV3.some(([c]) => c === code),
      `${code} 档必须有 v3 组合，否则升级后该档无处可归`
    )
  }
})

test('规则1：下架不删实现 —— 适配层仍保留全部通道', () => {
  // 下架是「对客户隐藏、可随时重新上架」，不是「删掉代码」。
  for (const id of MIGRATION_039.retiredEngineIds) {
    assert.ok(provider.providers[id], `${id} 的适配器不该被删除（下架 ≠ 删实现）`)
  }
})

// ---------------------------------------------------------------------------
// 规则 2 / 5 / 6：只有一本 char_balance
// ---------------------------------------------------------------------------

test('规则2/5/6：只有一本 char_balance，没有按通道拆分的余额', () => {
  // 调账只按账号维度（主账号 / 子账号），签名里没有 engine。
  assert.match(
    REPO,
    /async adjustChars\(client, kind, id, delta\)/,
    'adjustChars 签名里不该出现 engine —— 余额不按通道分账'
  )
  // 不存在 GPT / DeepSeek 的独立余额列。
  assert.doesNotMatch(
    REPO + CORE,
    /gpt_balance|deepseek_balance|engine_balance/i,
    '不得为某个通道单独建余额'
  )
})

// ---------------------------------------------------------------------------
// 规则 3 / 4 / 8：严格 1:1，没有倍率
// ---------------------------------------------------------------------------

test('规则3/4：扣费严格 1:1 —— 扣的就是计费字符数，与通道无关', () => {
  // 计费字符只由原文决定（中文按 2、其余按 1），不掺通道系数。
  //
  // 不钉死变量名：translate 已拆成多个阶段方法，原文变量现在叫 parsed.text。
  // 这里守的是"计费字符必须来自 countBillableChars"，而不是"那个变量叫什么"。
  assert.match(
    CORE,
    /const chars = this\.translator\.countBillableChars\(\w+(?:\.\w+)?\)/,
    '计费字符必须来自 countBillableChars(text)'
  )

  // 扣费是"记账"不是"再算一次"：结算时把 chars 原样累加，没有任何乘除。
  //
  // 注意别写成搜 `-chars` —— 那个写法在 transferChars（主子账号分字符）里也有，
  // 拿去当"翻译扣费"的证据会**永久假绿**：不管翻译扣费改成什么样它都能蒙对。
  // 这条断言曾经就是这么骗了半年。
  assert.match(
    CORE,
    /char_used=char_used\+\$2,translate_count=translate_count\+1/,
    '结算扣费必须是 char_used + chars 的原样累加'
  )
  // 累加进去的那个参数必须就是 chars 本身，不是 chars*倍数
  const settle = CORE.slice(CORE.indexOf('async settleTranslate('), CORE.indexOf('async settleTranslate(') + 6000)
  assert.match(settle, /\[session\.account\.id, chars\], client/,
    '结算事务传给 UPDATE 的必须是 chars 本身')

  // 只查**扣客户字符**的那几行。
  // 不能全文搜 `chars * N` —— costAmount 那里是 `costPerMillion * chars / 1e6`，
  // 那是给厂商的**成本估算**，跟扣客户几个字符是两回事。
  // 曾经我在这里写了个粗糙的 /chars\s*[*\/]/，结果拦住了正常的成本计算。
  const chargeLines = settle.split('\n').filter(line =>
    /char_used=char_used\+|adjustChars\(/.test(line) && !/^\s*(\/\/|\*)/.test(line))
  assert.ok(chargeLines.length > 0, '找不到扣客户字符的那几行')
  for (const line of chargeLines) {
    assert.doesNotMatch(line, /[*\/]\s*\d|Math\.(round|floor|ceil)/,
      `扣客户字符的地方出现了乘除 —— 那就是倍率，V1.0.x 不允许：${line.trim()}`)
  }

  // 退款也是原样 +chars（不是按别的口径退）。
  assert.match(
    CORE,
    /if \(refundable\) await this\.repo\.adjustChars\(client, session\.kind, session\.account\.id, chars\)/,
    '退款必须原样退回计费字符数'
  )
})

test('规则8：服务端当前没有任何 engine multiplier（倍率留到 V1.1）', () => {
  for (const rel of [
    'server/services/core-service.js',
    'server/repositories/production-repository.js',
    'server/services/translation-provider.js',
    'server/services/translation-adapters.js'
  ]) {
    assert.doesNotMatch(
      read(rel),
      /multiplier|倍率/i,
      `${rel} 出现了倍率 —— V1.0.x 是 1.0x，倍率必须留到 V1.1 显式加入`
    )
  }
})

// ---------------------------------------------------------------------------
// 规则 7：translate_logs 审计字段
// ---------------------------------------------------------------------------

test('规则7：translate_logs 记录 engine / chars / cost / latency / cached', () => {
  const insert = CORE.match(/INSERT INTO translate_logs\(([\s\S]*?)\)\s*VALUES/)
  assert.ok(insert, '必须能在 core-service 找到 translate_logs 插入语句')
  const columns = insert[1]
  const required = ['engine_id', 'chars', 'cost_amount', 'cached', 'duration_ms']
  for (const column of required) {
    assert.ok(
      columns.includes(column),
      `translate_logs 必须记录 ${column}（engine/chars/cost/latency/cached 一个都不能少）`
    )
  }
})

// ---------------------------------------------------------------------------
// 计费字符语义：中文按 2、其余按 1（这条被改掉会直接改变"扣多少"，必须钉死）
// ---------------------------------------------------------------------------

test('计费字符：中文按 2、其余按 1，与通道无关', () => {
  assert.equal(provider.countBillableChars('你好ab'), 6)
  assert.equal(provider.countBillableChars('hello'), 5)
  assert.equal(provider.countBillableChars(''), 0)
})
