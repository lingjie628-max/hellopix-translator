'use strict'

/**
 * `app_settings` 的读写。
 *
 * ## 为什么必须抽出来
 *
 * 这套配置原本是 `admin.js` 里一个 100 行的 `readSettings()` 闭包函数，
 * 加上 `/admin/settings/save` 里 140 行的校验逻辑。问题在于：
 *
 * **`readSettings()` 不只后台在用。** `/userRecharge/create` 也要读它 ——
 * 下单前必须拿到已启用且有收款地址的渠道，否则商户会拿到一个空地址。
 *
 * 2026-10-21 拆分 `admin.js` 时，这个函数跟着后台路由一起搬走了，
 * 而 `production.js` 里的调用点留在了原地 —— 结果是
 * `/userRecharge/create` 一调用就 `ReferenceError`。
 * 静态检查与只验证"路由已注册"的冒烟测试都抓不到，
 * 因为它只在**真正执行 handler** 时才炸。
 *
 * 结论：被两个域共用的读取逻辑不能挂在任何一个域的文件里。
 *
 * ## 键的约定
 *
 * `app_settings.key` 在数据库里有**小写约束**（见 recharge-guards.test.js），
 * 所以所有键必须是小写。`SETTING_KEYS` 把"表单字段名"映射到"配置键"，
 * 两页各自提交自己的子集，缺省的字段表示"不动"。
 */

const { ApiError } = require('../lib/http')
const { validTronAddress, normalizeTronAddress } = require('../lib/tron-address')

/** 表单字段名 → app_settings.key */
const SETTING_KEYS = Object.freeze({
  siteName: 'site.name',
  announcement: 'site.announcement',
  clientDownloadUrl: 'downloads.client_url',
  officialUrl: 'links.official_url',
  guideUrl: 'links.guide_url',
  trialChars: 'registration.trial_chars',
  lines: 'service.lines',
  telegram: 'support.telegram',
  telegramUrl: 'support.telegram_url',
  supportNote: 'support.note',
  supportBtnText: 'support.button_text',
  supportShow: 'support.visible',
  notices: 'site.notices',
  // 货币单位：官网价格显示要用，做成设置项而不是页面写死。
  // 刻意**没有**计费周期项 —— 本站按字符计费，没有按月/按年这回事，
  // 加一个周期设置等于凭空造出一个不存在的商业条款。
  currency: 'billing.currency',
  // 收款渠道。当前用 TRC20 USDT（跨境、无拒付、手续费低）。
  // 地址必须过 base58check 校验：填错 = 资金永久丢失、无法追回。
  paymentChannels: 'payment.channels'
})

const CURRENCIES = Object.freeze({
  USD: { symbol: '$', label: '美元 USD' },
  CNY: { symbol: '¥', label: '人民币 CNY' },
  HKD: { symbol: 'HK$', label: '港币 HKD' },
  JPY: { symbol: '¥', label: '日元 JPY' },
  EUR: { symbol: '€', label: '欧元 EUR' }
})

const DEFAULT_CURRENCY = 'USD'

/** 收款渠道默认值。只支持 TRC20 USDT：跨境客户用不了微信/支付宝。 */
const PAYMENT_NETWORKS = Object.freeze({ TRC20: 'TRC20（波场）' })

/**
 * TRC20 USDT 官方合约地址。
 *
 * **故意写成常量而不是后台配置项**：链上叫 "USDT" 的仿盘合约有很多，
 * 转进来同样数量但一文不值。把它做成可编辑的输入框，
 * 等于给"手滑改成仿盘合约"留了一扇门，而那种错误要到对账时才会发现。
 * 真需要换合约时改代码、走一次评审，比在后台点一下安全得多。
 */
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

const PAYMENT_DEFAULTS = Object.freeze([
  { id: 'usdt-trc20', name: 'USDT', network: 'TRC20', address: '', note: '', enabled: 0 }
])

/** 常见的解析失败：与路由层原有的 safeParse 用同一个错误码 */
function parseJson(value) {
  try {
    return JSON.parse(value)
  } catch (e) {
    throw new ApiError(400, '提交的数据不是合法 JSON', 'BAD_JSON')
  }
}

/**
 * 只放行 https，以及本机回环的 http。
 * 与客户端 `validateApiUrl` 同一策略 —— 本地联调需要 http://127.0.0.1。
 */
function httpsOrLoopback(value) {
  const text = String(value || '').trim()
  if (!text) return true
  if (/^https:\/\//.test(text)) return true
  return /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/.test(text)
}

class SettingsService {
  constructor(repo) {
    this.repo = repo
  }

  /** 读全部配置，补上默认值后返回给前端 */
  async read() {
    const rows = (await this.repo.query('SELECT key,value FROM app_settings')).rows
    const byKey = rows.reduce((out, row) => { out[row.key] = row.value; return out }, {})
    const discounts = byKey['billing.discounts'] || {}
    const savedChannels = Array.isArray(byKey['payment.channels']) ? byKey['payment.channels'] : []

    return {
      siteName: byKey['site.name'] || '',
      announcement: byKey['site.announcement'] || '',
      clientDownloadUrl: byKey['downloads.client_url'] || '',
      officialUrl: byKey['links.official_url'] || '',
      guideUrl: byKey['links.guide_url'] || '',
      trialChars: Number(byKey['registration.trial_chars'] || 0),
      discount1: Number(discounts['1'] || 0.9),
      discount10: Number(discounts['10'] || 0.8),
      discount50: Number(discounts['50'] || 0.75),
      telegram: byKey['support.telegram'] || '',
      telegramUrl: byKey['support.telegram_url'] || '',
      supportNote: byKey['support.note'] || '',
      supportBtnText: byKey['support.button_text'] || '联系客服',
      supportShow: byKey['support.visible'] === false ? 0 : 1,
      notices: Array.isArray(byKey['site.notices']) ? byKey['site.notices'] : [],
      lines: Array.isArray(byKey['service.lines']) ? byKey['service.lines'] : [],
      currency: CURRENCIES[byKey['billing.currency']] ? byKey['billing.currency'] : DEFAULT_CURRENCY,
      currencyOptions: Object.keys(CURRENCIES).map(code => ({ code, label: CURRENCIES[code].label })),
      // 收款渠道：把默认值和已保存的合并，保证新增字段能补上
      paymentChannels: PAYMENT_DEFAULTS.map(item => {
        const saved = savedChannels.find(row => row && row.id === item.id) || {}
        return Object.assign({}, item, {
          name: String(saved.name || item.name),
          network: 'TRC20',
          address: normalizeTronAddress(saved.address),
          // 合约地址跟着渠道一起下发，下单时快照进订单 —— 只认这一个合约
          tokenContract: USDT_TRC20_CONTRACT,
          note: String(saved.note || ''),
          enabled: Number(saved.enabled) ? 1 : 0
        })
      }),
      paymentNetworks: Object.keys(PAYMENT_NETWORKS).map(code => ({ code, label: PAYMENT_NETWORKS[code] }))
    }
  }

  /**
   * 下单前取可用的收款渠道。
   *
   * 这个方法是 `/userRecharge/create` 的入口 —— 它原本直接调 `readSettings()`，
   * 而那正是上面说的 `ReferenceError` 的来源。抽出来后两处共用同一份实现。
   *
   * @returns {Promise<Array<{id:string,name:string,address:string,tokenContract:string}>>}
   */
  async paymentChannels() {
    const current = await this.read()
    return current.paymentChannels.filter(item => item.enabled && item.address)
  }

  /**
   * 校验并归一化一次保存请求。
   *
   * @param {object} data 请求体
   * @returns {Promise<Array<[string, string]>>} [key, JSON 字符串] 列表
   */
  async normalizeUpdates(data) {
    const updates = []

    for (const [field, key] of Object.entries(SETTING_KEYS)) {
      if (data[field] === undefined) continue // 两页各自提交子集，缺省即不动
      let value = data[field]

      if (field === 'trialChars') value = Math.max(0, Math.floor(Number(value) || 0))
      if (field === 'supportShow') value = Number(value) ? true : false

      if (field === 'currency') {
        const text = String(value || '').trim().toUpperCase()
        if (!CURRENCIES[text]) throw new ApiError(400, `不支持的货币单位：${text}`, 'BAD_CURRENCY')
        value = text
      }

      if (field === 'notices') {
        const parsed = typeof value === 'string' ? parseJson(value) : value
        if (!Array.isArray(parsed)) throw new ApiError(400, '公告必须是数组', 'BAD_NOTICES')
        const gone = Array.isArray(data.goneNoticeIds) ? data.goneNoticeIds.map(String) : []
        value = parsed
          .filter(item => item && item.title !== undefined)
          .filter(item => !gone.includes(String(item.id)))
          .slice(0, 200)
          .map((item, index) => ({
            id: item.id ? String(item.id) : `n${Date.now()}${index}`,
            title: String(item.title || '').slice(0, 200),
            content: String(item.content || '').slice(0, 5000),
            enabled: Number(item.enabled) ? 1 : 0,
            createTime: String(item.createTime || new Date().toISOString().slice(0, 19).replace('T', ' '))
          }))
      }

      if (field === 'lines') {
        const parsed = typeof value === 'string' ? parseJson(value) : value
        if (!Array.isArray(parsed)) throw new ApiError(400, '线路必须是数组', 'BAD_LINES')
        value = parsed.map((line, index) => {
          const url = String(line.url || '').trim()
          if (!httpsOrLoopback(url)) {
            throw new ApiError(400, `第 ${index + 1} 条线路地址必须是 https://（本机回环可 http）`, 'BAD_LINE_URL')
          }
          return {
            id: line.id ? Number(line.id) : index + 1,
            name: String(line.name || '').trim() || `线路${index + 1}`,
            url,
            region: String(line.region || '').trim(),
            enabled: Number(line.enabled) ? 1 : 0
          }
        })
      }

      if (field === 'paymentChannels') {
        const parsed = typeof value === 'string' ? parseJson(value) : value
        if (!Array.isArray(parsed)) throw new ApiError(400, '收款渠道必须是数组', 'BAD_PAYMENT_CHANNELS')
        value = parsed.map((item, index) => {
          const id = String((item && item.id) || `ch${index + 1}`)
          const address = normalizeTronAddress(item && item.address)
          const enabled = Number(item && item.enabled) ? 1 : 0
          // 地址一旦填了就必须能过校验和 —— 这是资金安全底线，不做"先存后改"
          if (address && !validTronAddress(address)) {
            throw new ApiError(400,
              `第 ${index + 1} 个收款地址不是合法的 TRC20 地址（校验和不匹配，请核对是否复制错字符）`,
              'BAD_PAYMENT_ADDRESS')
          }
          // 启用但没填地址 = 商户看到空地址，属于必然出事故的配置，直接拦下
          if (enabled && !address) {
            throw new ApiError(400, `第 ${index + 1} 个渠道已启用但没填收款地址`, 'PAYMENT_ADDRESS_REQUIRED')
          }
          return {
            id,
            name: String((item && item.name) || 'USDT').trim().slice(0, 40) || 'USDT',
            network: 'TRC20',
            address,
            note: String((item && item.note) || '').slice(0, 500),
            enabled
          }
        }).slice(0, 10)
      }

      if (['clientDownloadUrl', 'officialUrl', 'guideUrl', 'telegramUrl'].includes(field)) {
        const text = String(value || '').trim()
        if (text && !/^https:\/\//.test(text)) {
          throw new ApiError(400, `${field} 必须是 https:// 地址`, 'BAD_SETTING_URL')
        }
      }

      updates.push([key, JSON.stringify(value)])
    }

    // 折扣是**三档一起存**的：它们存在同一个键 `billing.discounts` 里，
    // 只提交其中一档时必须把另外两档的当前值带上，否则会被覆盖成默认值。
    const discounts = ['discount1', 'discount10', 'discount50'].filter(field => data[field] !== undefined)
    if (discounts.length) {
      const current = await this.read()
      const pick = (field, fallback) => {
        const value = Number(data[field] === undefined ? fallback : data[field])
        if (!Number.isFinite(value) || value <= 0 || value > 1) {
          throw new ApiError(400, '折扣必须在 0 与 1 之间', 'BAD_DISCOUNT')
        }
        return value
      }
      updates.push(['billing.discounts', JSON.stringify({
        1: pick('discount1', current.discount1),
        10: pick('discount10', current.discount10),
        50: pick('discount50', current.discount50)
      })])
    }

    if (!updates.length) throw new ApiError(400, '没有需要保存的设置项', 'NOTHING_TO_SAVE')
    return updates
  }

  /**
   * 保存设置。
   *
   * @param {object} data  请求体
   * @param {object} actor req.pixAdmin
   * @param {string} ip    req.ip
   */
  async save(data, actor, ip) {
    const updates = await this.normalizeUpdates(data)
    await this.repo.transaction(async client => {
      for (const [key, value] of updates) {
        await this.repo.query(
          `INSERT INTO app_settings(key,value,description) VALUES($1,$2::jsonb,$3)
           ON CONFLICT (key) DO UPDATE SET value=$2::jsonb`,
          [key, value, key], client
        )
      }
      await this.repo.audit(client, actor, '修改系统设置',
        updates.map(item => item[0]).join(','), ip, { type: 'settings' })
    })
    return updates
  }
}

module.exports = {
  SettingsService,
  SETTING_KEYS,
  CURRENCIES,
  DEFAULT_CURRENCY,
  PAYMENT_NETWORKS,
  PAYMENT_DEFAULTS,
  USDT_TRC20_CONTRACT,
  SETTING_KEY_LABELS: SETTING_KEYS
}
