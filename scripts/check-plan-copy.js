#!/usr/bin/env node
'use strict'

/**
 * 校验「套餐卡片的宣传渠道」与「后台实际授权」是否一致。
 *
 * ## 为什么需要这个脚本
 *
 * 这类事故已经出现过不止一次，而且每次都很贵：
 *
 *   · 官网基础版宣传「百度翻译 / 小牛翻译」，但百度在 engines 表里根本不存在、
 *     小牛早已停用（见迁移 034）；
 *   · 高级版把「谷歌翻译」写成卖点，而谷歌只授给了专业版 —— 客户为它买高级版，
 *     一翻译就撞上「当前套餐未包含此通道」；
 *   · 专业版标着 DeepL 与亚马逊 AWS，两条都已退役。
 *
 * 卖点与权益对不上，客户是**付了钱才发现**的。而 `highlights` 是一段自由文本，
 * 改权益时没人会想起来同步它 —— 所以只能靠机器每次核对。
 *
 * ## 判定规则
 *
 * 对每个在售套餐，从 `highlights` 里提取所有「渠道声明」，逐条要求它能落到
 * **该套餐可获得**的通道集合里。可获得 = 本档授权 ∪ 更低档位授权
 * （因为文案用「+上一版各翻译通道」表达继承关系）。
 *
 * 一条渠道声明算「违规」需满足其一：
 *   1. 能解析到某个 engine，但该 engine 不在可获得集合里（含已停用/未启用）；
 *   2. 解析不到 engine，但形如「XX翻译」—— 那是在宣传一个不存在的通道。
 *
 * 另外核对**客户端权益**：`clients` 里标了 true 的端，必须真有对应的在架安装包
 * （见 CLIENT_CLAIMS）。同一种病：`clients.mobile` 曾三个套餐都是 true，
 * 而 `client_releases` 里只有 Windows 与 macOS —— 手机版没有任何东西在它后面。
 *
 * 用法：
 *   DATABASE_URL=... node scripts/check-plan-copy.js
 * 退出码 1 表示发现不一致，可直接当 CI 门禁。
 */

const { pool } = require('../server/db/postgres')
const catalog = require('../server/lib/client-catalog')

/** 与 Landing.vue 的 cardHighlights() 保持一致：纯额度项不算渠道。 */
const QUOTA_ITEM = /^[\d.,]+\s*万?\s*(翻译)?字符$/
/** 「+基础版各翻译通道」这类继承说明，不是具体渠道名。 */
const INHERIT_ITEM = /^\+.*各翻译通道$/
/** 一看就是渠道声明的形态。 */
const LOOKS_LIKE_CHANNEL = /翻译$/
/** 渠道声明之间可能用的分隔符。 */
const SPLIT = /[、,，/／·]+/

/**
 * 「额度声明」的数字捕获（带 `万` 与否都要认）。
 *
 * 单独写一个带捕获组的正则，是因为 `QUOTA_ITEM` 只判"是不是额度项"、
 * 拿不到数字，而下面的额度一致性校验需要那个数字。
 */
const QUOTA_CAPTURE = /^([\d.,]+)\s*(万)?\s*(?:翻译)?字符$/

/**
 * 从 `highlights` 里取出承诺的字符额度。
 *
 * 「300万字符」→ 3000000，「150字符」→ 150（没写"万"就是字面量）。
 * 取不到返回 null —— 不能拿 0 代替：0 会让"文案与额度不符"的判定失效。
 */
function quotaFromHighlights(highlights) {
  for (const raw of highlights || []) {
    const hit = QUOTA_CAPTURE.exec(String(raw).trim())
    if (hit) return Math.round(Number(String(hit[1]).replace(/,/g, '')) * (hit[2] ? 10000 : 1))
  }
  return null
}

/** 单位价（每百万字符）。价格或额度缺失返回 null —— 不可能比。 */
function unitPricePerMillion(price, chars) {
  const p = Number(price)
  const c = Number(chars)
  if (!(p > 0) || !(c > 0)) return null
  return p / c * 1e6
}

/**
 * 套餐权益里承诺的"端"，以及它必须对应到的在架安装包。
 *
 * 这里是**同一个病**的另一个面：`clients.mobile` 曾经三个套餐都是 true，
 * 而 `client_releases` 里 15 条记录只有 Windows 与 macOS —— 手机版被当作权益
 * 卖给客户，却没有任何东西在它后面（迁移 035）。
 *
 * 映射依据：
 *   · `standalone` = **每平台单应用壳**（`client-catalog` 的 `STANDALONE_APPS`），
 *     只有 `client_releases.release_group='standalone'` 的在架记录才算数；
 *   · `mobile` = 手机应用（android/ios）。
 *   `clients.counter`（柜台版）不在其列 —— 它没有对应的发布渠道，映射未知，
 *   不敢靠猜断言。
 *
 * ⚠️ standalone 这条曾经写成 `/windows|macos/` —— 把**主客户端安装包**当成了
 * 独立应用的凭证（主客户端走的是 windows / macos 分组）。于是"套餐承诺独立应用版、
 * 而 client_releases 里一条 standalone 记录都没有"这个状态**长期通过了校验**：
 * 守卫对最该拦的那类事故是瞎的（迁移 036 摘掉该承诺之前一直如此）。
 * 现改为按 `release_group` 判定。
 */
const CLIENT_CLAIMS = [
  ['standalone', '独立应用版', row => catalog.groupId(row.release_group) === 'standalone'],
  ['mobile', '手机版', row => /android|ios|harmony/i.test(String(row.os || ''))]
]

function normalize(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/翻译$/, '')
    .toLowerCase()
}

/** 把一条 highlights 拆成候选的渠道声明。 */
function channelClaims(highlights) {
  const claims = []
  for (const raw of highlights || []) {
    const item = String(raw).trim()
    if (!item) continue
    if (QUOTA_ITEM.test(item) || INHERIT_ITEM.test(item)) continue
    for (const part of item.split(SPLIT)) {
      const claim = part.trim()
      if (claim && claim !== '各翻译通道') claims.push(claim)
    }
  }
  return claims
}

async function main() {
  // 全部 engine（含已停用）：既用来解析声明，也用来识别"退役但被宣传"的情况。
  const engines = (await pool.query(
    'SELECT id,name,enabled,retired_at FROM engines ORDER BY id'
  )).rows

  const byAlias = new Map()
  for (const e of engines) {
    byAlias.set(normalize(e.name), e)
    byAlias.set(normalize(e.id), e)
  }

  // 在架的客户端安装包：用来核对"套餐承诺了某个端，是否真有对应的东西在架"。
  // release_group 是判定 standalone 的唯一依据（见 CLIENT_CLAIMS）。
  const releases = (await pool.query(
    'SELECT os, release_group FROM client_releases WHERE enabled=true'
  )).rows

  const packages = (await pool.query(
    `SELECT id,title,sort_order,price,included_chars,highlights,clients,catalog_version
       FROM packages WHERE active=true ORDER BY sort_order,id`
  )).rows

  const violations = []
  // 递进累积：低档位的通道会被高档位的「+上一版各翻译通道」一并授出。
  const obtainable = new Map()

  for (const pkg of packages) {
    const entitled = (await pool.query(
      `SELECT e.id,e.name
         FROM engines e
         JOIN package_engine_versions v ON v.engine_id=e.id
        WHERE v.package_id=$1 AND v.version=$2
          AND e.enabled AND e.retired_at IS NULL`,
      [pkg.id, pkg.catalog_version]
    )).rows

    for (const e of entitled) obtainable.set(e.id, e.name)
    const allowed = new Set(obtainable.keys())

    const names = entitled.map(e => e.name).join('、') || '(无)'
    console.log(`\n  ${pkg.title}（catalog_version=${pkg.catalog_version}）`)
    console.log(`    可获得的通道：${names}`)

    for (const claim of channelClaims(pkg.highlights)) {
      const hit = byAlias.get(normalize(claim))
      if (hit) {
        if (!allowed.has(hit.id)) {
          const why = hit.retiredAt ? '已停用' : (hit.enabled ? '未授权给本套餐' : '未启用')
          violations.push({ pkg: pkg.title, claim, detail: `命中通道「${hit.name}」，但它${why}` })
          console.log(`    ✗ 宣传「${claim}」→ ${why}`)
        } else {
          console.log(`    ✓ 宣传「${claim}」`)
        }
      } else if (LOOKS_LIKE_CHANNEL.test(claim)) {
        violations.push({ pkg: pkg.title, claim, detail: 'engines 表里没有这个通道' })
        console.log(`    ✗ 宣传「${claim}」→ engines 表里没有这个通道`)
      } else {
        // 独立应用版 / 手机版 这类非渠道卖点，不参与渠道核对。
        console.log(`    · 「${claim}」不是渠道项，跳过渠道核对`)
      }
    }

    // 客户端权益：承诺了某个端，必须真有对应的在架安装包。
    for (const [flag, label, match] of CLIENT_CLAIMS) {
      if (!pkg.clients || !pkg.clients[flag]) continue
      if (releases.some(row => match(row))) {
        console.log(`    ✓ 权益「${label}」有对应的在架安装包`)
      } else {
        violations.push({
          pkg: pkg.title,
          claim: label,
          detail: `权益列表里承诺了「${label}」，但 client_releases 里没有任何对应的在架安装包`
        })
        console.log(`    ✗ 权益「${label}」→ 没有对应的在架安装包`)
      }
    }

    /**
     * 额度一致性：卡片上写的字符数必须等于 `included_chars`。
     *
     * 这一项以前**完全没有被校验** —— `QUOTA_ITEM` 匹配到就直接 `continue`
     * 跳过了。后果是生产上高级版实际给 250 万、专业版 600 万，
     * 而三档卡片都写着「150万字符」，长期无人发现（2026-10-11 修复）。
     * 和渠道声明是同一个病：**卖点与权益对不上，客户是付了钱才发现的**。
     */
    const claimed = quotaFromHighlights(pkg.highlights)
    if (claimed === null) {
      violations.push({
        pkg: pkg.title,
        claim: '字符额度',
        detail: '卡片文案里没有任何「N万字符」的额度声明 —— 客户看不出这一档给多少字符'
      })
      console.log('    ✗ 文案里没有额度声明')
    } else if (claimed !== Number(pkg.included_chars)) {
      violations.push({
        pkg: pkg.title,
        claim: `${claimed / 10000}万字符`,
        detail: `文案承诺 ${claimed} 字符，实际 included_chars=${pkg.included_chars}`
      })
      console.log(`    ✗ 额度文案写 ${claimed}，实际 ${pkg.included_chars}`)
    } else {
      console.log(`    ✓ 额度文案 ${claimed} 与实际一致`)
    }
  }

  /**
   * 阶梯单调性：档次越高，单位价（每百万字符）必须越便宜。
   *
   * 生产上曾经是 23.33 / 26.00 / 20.83 —— 高级版比基础版还贵 11.4%。
   * 客户把三张卡片一比就知道"升级反而更亏"，"高级版"名不副实。
   * 这类错误纯靠人眼看三组数字对不出来，必须机器算了才拦得住。
   */
  const priced = packages
    .map(p => ({ title: p.title, price: Number(p.price), chars: Number(p.included_chars) }))
    .filter(p => unitPricePerMillion(p.price, p.chars) !== null)
    .sort((a, b) => a.price - b.price)

  console.log('\n  阶梯单位价（每百万字符，应随档位严格下降）：')
  for (const p of priced) {
    console.log(`    ${p.title}：$${unitPricePerMillion(p.price, p.chars).toFixed(2)}/百万字符`)
  }
  for (let i = 1; i < priced.length; i++) {
    const prev = unitPricePerMillion(priced[i - 1].price, priced[i - 1].chars)
    const curr = unitPricePerMillion(priced[i].price, priced[i].chars)
    if (curr >= prev) {
      violations.push({
        pkg: priced[i].title,
        claim: `$${curr.toFixed(2)}/百万字符`,
        detail: `不比低一档的 ${priced[i - 1].title}（$${prev.toFixed(2)}/百万字符）便宜，`
          + '升级这一档反而更亏。应调高这一档的字符额度，或调低它的价格'
      })
      console.log(`    ✗ ${priced[i].title} 不比 ${priced[i - 1].title} 便宜（${curr.toFixed(2)} ≥ ${prev.toFixed(2)}）`)
    }
  }

  console.log()
  if (violations.length) {
    console.error('  ❌ 宣传与权益不一致：')
    for (const v of violations) console.error(`     · ${v.pkg}：「${v.claim}」—— ${v.detail}`)
    console.error('\n     三类都必须对齐：渠道声明 ↔ 实际授权、额度文案 ↔ included_chars、')
    console.error('     以及单位价随档位严格下降。改文案或改权益，让两者一致。')
    return 1
  }
  console.log('  ✅ 渠道声明、字符额度文案、阶梯单位价 —— 三项都与实际一致')
  return 0
}

// 只有直接运行时才连库执行；被 require 时只暴露纯函数给测试。
if (require.main === module) {
  main()
    .then(code => pool.end().then(() => process.exit(code)))
    .catch(err => {
      console.error('  校验失败：', err.message)
      pool.end().finally(() => process.exit(2))
    })
}

module.exports = { channelClaims, quotaFromHighlights, unitPricePerMillion, QUOTA_ITEM }
