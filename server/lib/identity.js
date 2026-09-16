/**
 * 客户身份归一化与指纹。
 *
 * 这是整个统一客户系统的**准确率第一道关口**：
 * 归一化不一致 = 同一个客户被算成两个；归一化过宽 = 两个不同的人被合并。
 * 后者更危险，因为误合并是不可逆的数据污染（虽然 customers.merged_into 留了回滚余地）。
 *
 * 两条铁律：
 *
 * 1. **拿不准就不生成指纹**。宁可漏匹配（当成新客户），也不要错匹配（合并两个真人）。
 *    手机号缺国家码时无法判断归属，硬猜会把 +1 和 +86 的不同人算成同一个。
 *
 * 2. **指纹用 HMAC 而不是 SHA256**。SHA256 的话，任何知道某个手机号的人
 *    都能自己算出哈希来撞库，从而确认"这个人是不是本平台的客户"。
 *    HMAC 用平台密钥，外部无法构造查询。
 */

const crypto = require('crypto')

/**
 * 身份密钥。**绝不可更换** —— 换了之后所有历史指纹全部失效，
 * 每个老客户都会被当成新客户重新建档，合并关系全断。
 *
 * 故意与 PIX_CREDENTIAL_KEY 分开：轮换通道凭据密钥不应该影响客户身份。
 */
function identityKey() {
  const key = process.env.PIX_IDENTITY_KEY
  if (!key || key.length < 32) {
    throw new Error('PIX_IDENTITY_KEY 未配置或长度不足 32（身份指纹密钥，配置后不可更换）')
  }
  return key
}

/** 是否已配置身份密钥。未配置时相关功能整体降级为"不识别"，而不是报错中断。 */
function identityEnabled() {
  const key = process.env.PIX_IDENTITY_KEY
  return !!(key && key.length >= 32)
}

/**
 * 生成指纹。同一 (类型, 归一化值) 永远得到同一指纹。
 * 加类型前缀是为了避免"手机号 123"与"用户名 123"撞成同一个指纹。
 */
function fingerprint(type, normalizedValue) {
  return crypto
    .createHmac('sha256', identityKey())
    .update(String(type) + '\u0000' + String(normalizedValue))
    .digest()
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

// 常见国家码前缀。用于判断"这串数字里是否已经包含国家码"。
// 不追求穷举 —— 拿不准时返回失败，由调用方补充 countryCode。
const COUNTRY_CODES = [
  '1', '7', '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45',
  '46', '47', '48', '49', '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63',
  '64', '65', '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98',
  '212', '213', '216', '218', '220', '221', '233', '234', '254', '255', '256', '260', '263', '264',
  '265', '267', '268', '351', '352', '353', '354', '355', '356', '357', '358', '359', '370', '371',
  '372', '373', '374', '375', '376', '377', '378', '380', '381', '382', '383', '385', '386', '387',
  '389', '420', '421', '423', '501', '502', '503', '504', '505', '506', '507', '509', '590', '591',
  '592', '593', '594', '595', '596', '597', '598', '599', '670', '673', '674', '675', '676', '677',
  '678', '679', '680', '681', '682', '683', '685', '686', '687', '688', '689', '690', '691', '692',
  '850', '852', '853', '855', '856', '880', '886', '960', '961', '962', '963', '964', '965', '966',
  '967', '968', '970', '971', '972', '973', '974', '975', '976', '977', '992', '993', '994', '995',
  '996', '998'
]

/**
 * 手机号归一化为 E.164（不带 + 的纯数字 + 国家码）。
 *
 * @param {string} raw            原始号码
 * @param {object} [opts]
 * @param {string} [opts.countryCode] 号码**不含**国家码时使用的默认国家码（如 '86'）
 * @returns {{ok:true, e164:string, note:string} | {ok:false, reason:string}}
 *
 * 为什么不少见地返回失败：号码不带国家码时，"13800138000" 既可能是中国手机，
 * 也可能是别国号码。硬猜等于把两个不同的人合并。**宁可漏，不可错。**
 */
function normalizePhone(raw, opts = {}) {
  const input = String(raw == null ? '' : raw).trim()
  if (!input) return { ok: false, reason: 'empty' }

  const hasPlus = input.startsWith('+')
  const hasIntlPrefix = /^00\d/.test(input.replace(/[\s\-().]/g, ''))

  let digits = input.replace(/\D/g, '')
  if (!digits) return { ok: false, reason: 'no_digits' }

  // 00 开头是国际冠码，等价于 +
  if (!hasPlus && hasIntlPrefix) digits = digits.replace(/^00/, '')

  // 显式带 + 或 00：信任调用方给的号码已含国家码
  if (hasPlus || hasIntlPrefix) {
    if (digits.length < 7 || digits.length > 15) return { ok: false, reason: 'length_out_of_range' }
    return { ok: true, e164: digits, note: 'explicit_country_code' }
  }

  // 没有国家码。看它是否"自带"国家码。
  const withoutLeadingZero = digits.replace(/^0+/, '')
  const matched = matchCountryCode(withoutLeadingZero)
  if (matched) {
    const rest = withoutLeadingZero.slice(matched.length)
    // 国家码之后的本地号码长度：太短基本是误判
    if (rest.length >= 6 && rest.length <= 12) {
      return { ok: true, e164: withoutLeadingZero, note: 'inferred_country_code:' + matched }
    }
  }

  // 推不出来 —— 只有调用方明确给了国家码才归一
  const cc = String(opts.countryCode || '').replace(/\D/g, '')
  if (!cc) return { ok: false, reason: 'country_code_unknown' }

  const local = digits.replace(/^0+/, '')
  const combined = cc + local
  if (combined.length < 7 || combined.length > 15) return { ok: false, reason: 'length_out_of_range' }
  return { ok: true, e164: combined, note: 'default_country_code:' + cc }
}

/**
 * 尝试从号码本身推断国家码。
 *
 * **故意只推断 2-3 位国家码，不推断 1 位的（1 和 7）。**
 *
 * 原因：中国手机号是 11 位、以 1 开头（1 是号码本身的一部分）；
 * 美国号码加国家码也是 11 位、以 1 开头（1 是国家码）。
 * 两者结构完全相同，`13800138000` 既可以读成中国手机，
 * 也可以读成「美国 1 + 3800138000」。**无法区分。**
 *
 * 这种情况下必须失败 —— 猜错就是把两个不同的人合并，不可逆。
 * 调用方若知道归属地，应显式传 countryCode，或在号码里带 + / 00。
 */
function matchCountryCode(digits) {
  for (const len of [3, 2]) {
    const head = digits.slice(0, len)
    if (head.length === len && COUNTRY_CODES.includes(head)) {
      const rest = digits.slice(len)
      // 国家码之后的本地号码长度要合理，否则基本是误判
      if (rest.length >= 6 && rest.length <= 12) return head
    }
  }
  return ''
}

/** 用户名归一化：去 @、去空白、转小写。 */
function normalizeUsername(raw) {
  const v = String(raw == null ? '' : raw).trim().replace(/^@+/, '').toLowerCase()
  if (!v || v.length > 64) return { ok: false, reason: 'invalid' }
  // 只保留平台用户名的合法字符集
  if (!/^[a-z0-9_.]{3,64}$/.test(v)) return { ok: false, reason: 'invalid_charset' }
  return { ok: true, value: v, note: 'username' }
}

/** 邮箱归一化：转小写、去空白。 */
function normalizeEmail(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase()
  if (!v || v.length > 254) return { ok: false, reason: 'invalid' }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, reason: 'invalid_format' }
  // Gmail 的 + 别名与点号等价，不归一的话同一个人会有多个身份
  const at = v.lastIndexOf('@')
  let local = v.slice(0, at)
  let domain = v.slice(at + 1)
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.split('+')[0].replace(/\./g, '')
    domain = 'gmail.com'
  }
  return { ok: true, value: local + '@' + domain, note: 'email' }
}

/**
 * 平台内用户标识归一化。
 *
 * Telegram Web A 的 URL 形如 #<peerId> 或 #@username；
 * WhatsApp 没有稳定 ID，只有手机号。
 */
function normalizePlatformUid(platform, raw) {
  const p = String(platform || '').toLowerCase()
  let v = String(raw == null ? '' : raw).trim()
  if (!v) return { ok: false, reason: 'empty' }

  // Telegram：URL hash 里带 @ 的是用户名，纯数字是 peer id
  if (p === 'telegram' || p === 'telegram-z') {
    v = v.replace(/^#/, '').replace(/^@/, '')
    const numeric = v.match(/^-?\d+$/)
    if (numeric) return { ok: true, value: 'tg:' + v.replace(/^-/, ''), note: 'peer_id' }
    return normalizeUsername(v).ok
      ? { ok: true, value: 'tg:@' + normalizeUsername(v).value, note: 'username_as_uid' }
      : { ok: false, reason: 'invalid' }
  }

  if (p.startsWith('whatsapp')) {
    // WhatsApp 的唯一标识就是手机号，交给手机号归一化处理
    return { ok: false, reason: 'use_phone' }
  }

  // 其他平台：保守处理，只做长度与字符集校验，不做语义猜测
  if (v.length > 128) return { ok: false, reason: 'too_long' }
  return { ok: true, value: p + ':' + v, note: 'opaque' }
}

/**
 * 收集一条线索能提供的全部身份候选，**按可信度从高到低**排列。
 *
 * 优先级（设计文档 §4.1）：手机号 > 平台稳定 ID > 邮箱 > 用户名
 * 姓名/公司**不进入候选** —— 同名太常见，仅凭姓名合并会污染数据。
 *
 * @returns {Array<{type, value, confidence, note}>}
 */
function collectIdentities(clue = {}) {
  const out = []

  if (clue.phone) {
    const r = normalizePhone(clue.phone, { countryCode: clue.countryCode })
    if (r.ok) out.push({ type: 'phone', value: r.e164, confidence: 'high', note: r.note })
  }

  if (clue.platformUid && clue.platform) {
    const r = normalizePlatformUid(clue.platform, clue.platformUid)
    if (r.ok) {
      // peer_id 稳定，username 可改 —— 可信度不同
      out.push({
        type: 'platform_uid',
        value: r.value,
        confidence: r.note === 'peer_id' ? 'high' : 'medium',
        note: r.note
      })
    }
  }

  if (clue.email) {
    const r = normalizeEmail(clue.email)
    if (r.ok) out.push({ type: 'email', value: r.value, confidence: 'high', note: r.note })
  }

  if (clue.username) {
    const r = normalizeUsername(clue.username)
    if (r.ok) out.push({ type: 'username', value: r.value, confidence: 'medium', note: r.note })
  }

  return out
}

module.exports = {
  identityEnabled,
  fingerprint,
  normalizePhone,
  normalizeUsername,
  normalizeEmail,
  normalizePlatformUid,
  collectIdentities,
  COUNTRY_CODES
}
