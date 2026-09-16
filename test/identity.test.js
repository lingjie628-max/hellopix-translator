/**
 * 身份归一化与指纹测试。
 *
 * 这是整个客户身份系统的准确率关口，所以测试重点不在"正常情况能跑"，
 * 而在两个方向的错误：
 *   · 漏匹配（同一人被算成两个）—— 功能失效
 *   · 错匹配（两个真人被合并）—— **不可逆的数据污染**
 * 后者更危险，所以"拿不准就失败"的分支必须逐条覆盖。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

process.env.PIX_IDENTITY_KEY = process.env.PIX_IDENTITY_KEY || 'x'.repeat(48)

const identity = require('../server/lib/identity')

// ---------------------------------------------------------------------------
// 手机号归一化
// ---------------------------------------------------------------------------

test('同一手机号的不同写法必须归一成同一个值', () => {
  const forms = [
    '+86 138 0013 8000',
    '+8613800138000',
    '8613800138000',
    '+86-138-0013-8000',
    '+86 (138) 0013-8000',
    '008613800138000'
  ]
  const results = forms.map(f => identity.normalizePhone(f))
  results.forEach((r, i) => {
    assert.equal(r.ok, true, `${forms[i]} 应能归一，实际失败：${r.reason}`)
    assert.equal(r.e164, '8613800138000', `${forms[i]} 归一结果不对`)
  })
})

test('不带国家码但前缀无歧义时，按推断结果归一', () => {
  // 86 / 44 这类 2 位国家码出现在开头是强信号，可以推断
  assert.equal(identity.normalizePhone('8613800138000').e164, '8613800138000')
  assert.equal(identity.normalizePhone('447911123456').e164, '447911123456')
  assert.equal(identity.normalizePhone('819012345678').e164, '819012345678')
})

test('1 开头的 11 位号码**必须失败** —— 中美结构相同，猜错就是错合并', () => {
  // `13800138000` 既可以读成中国手机（1 是号码的一部分）
  // 也可以读成「美国 1 + 3800138000」（1 是国家码）。
  // 结构完全一样，无从区分 —— 所以只能失败，由调用方补 countryCode。
  const cn = identity.normalizePhone('13800138000')
  assert.equal(cn.ok, false, '1 开头的 11 位号码不得靠猜归一')
  assert.equal(cn.reason, 'country_code_unknown')

  const us = identity.normalizePhone('14155552671')
  assert.equal(us.ok, false, '同理，美国号不带 + 时也不能猜')

  // 带上 + 就能确定 —— 实际数据（WhatsApp）都是这种格式
  assert.equal(identity.normalizePhone('+14155552671').e164, '14155552671')
  assert.equal(identity.normalizePhone('+8613800138000').e164, '8613800138000')
})

test('拿不准时**必须失败**，不能猜 —— 错合并不可逆', () => {
  // 7 位本地号：可能是任何国家
  const r = identity.normalizePhone('1234567')
  assert.equal(r.ok, false, '无法判断归属的短号不应归一')
  assert.match(r.reason, /country_code_unknown|length_out_of_range/)
})

test('调用方给了国家码时，本地号按该国家码补齐', () => {
  // 有调用方提供的归属地，歧义就消解了
  const r = identity.normalizePhone('13800138000', { countryCode: '86' })
  assert.equal(r.ok, true)
  assert.equal(r.e164, '8613800138000')

  // 前导 0 要去掉：英国本地写法 07911... → 447911...
  const uk = identity.normalizePhone('07911123456', { countryCode: '44' })
  assert.equal(uk.ok, true)
  assert.equal(uk.e164, '447911123456')
})

test('中国手机号不得被误判成美国号（曾经的真实 bug）', () => {
  // 修复前：`13800138000` 被 len=1 的规则吃成「1 + 3800138000」，
  // 于是一个中国客户被建档成了美国号码，永远匹配不上他带 +86 的另一条线索。
  const r = identity.normalizePhone('13800138000')
  assert.equal(r.ok, false, '不能猜；猜错会导致同一客户被算成两个')
})

test('长度越界的号码一律拒绝', () => {
  assert.equal(identity.normalizePhone('+123456').ok, false, '过短应拒绝')
  assert.equal(identity.normalizePhone('+' + '9'.repeat(20)).ok, false, '过长应拒绝')
  assert.equal(identity.normalizePhone('').ok, false)
  assert.equal(identity.normalizePhone('不是号码').ok, false)
})

// ---------------------------------------------------------------------------
// 用户名 / 邮箱
// ---------------------------------------------------------------------------

test('用户名归一化：去 @、转小写', () => {
  assert.equal(identity.normalizeUsername('@Alice_01').value, 'alice_01')
  assert.equal(identity.normalizeUsername('  ALICE_01 ').value, 'alice_01')
})

test('用户名非法字符集要拒绝（避免把昵称当用户名）', () => {
  assert.equal(identity.normalizeUsername('张三').ok, false, '中文昵称不是合法用户名')
  assert.equal(identity.normalizeUsername('a b').ok, false, '含空格应拒绝')
  assert.equal(identity.normalizeUsername('ab').ok, false, '过短应拒绝')
})

test('Gmail 的 + 别名与点号要归一 —— 否则同一个人会有多个身份', () => {
  const a = identity.normalizeEmail('John.Doe+shop@gmail.com')
  const b = identity.normalizeEmail('johndoe@gmail.com')
  assert.equal(a.value, 'johndoe@gmail.com')
  assert.equal(b.value, 'johndoe@gmail.com')
  assert.equal(a.value, b.value, 'Gmail 别名未归一')

  // 非 Gmail 不能动本地部分 —— 别家的 + 是真的不同地址
  const c = identity.normalizeEmail('john+shop@outlook.com')
  assert.equal(c.value, 'john+shop@outlook.com', '非 Gmail 邮箱不应做别名折叠')
})

// ---------------------------------------------------------------------------
// 平台标识
// ---------------------------------------------------------------------------

test('Telegram 的 URL hash 能解析出稳定标识', () => {
  const peer = identity.normalizePlatformUid('telegram', '#123456789')
  assert.equal(peer.ok, true)
  assert.equal(peer.value, 'tg:123456789')
  assert.equal(peer.note, 'peer_id')

  const named = identity.normalizePlatformUid('telegram', '#@Alice_01')
  assert.equal(named.ok, true)
  assert.equal(named.value, 'tg:@alice_01')
  assert.equal(named.note, 'username_as_uid', '用户名不是稳定 ID，必须标记出来')
})

test('WhatsApp 没有稳定 ID，应当走手机号而不是伪造一个', () => {
  const r = identity.normalizePlatformUid('whatsapp-green', '8613800138000')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'use_phone')
})

// ---------------------------------------------------------------------------
// 指纹
// ---------------------------------------------------------------------------

test('同一身份永远得到同一指纹，不同类型不互相撞', () => {
  const a1 = identity.fingerprint('phone', '8613800138000')
  const a2 = identity.fingerprint('phone', '8613800138000')
  assert.deepEqual(a1, a2)

  const b = identity.fingerprint('username', '8613800138000')
  assert.notDeepEqual(a1, b, '不同类型的同值不能算出同一指纹')
})

test('指纹是 HMAC 而不是裸 SHA256 —— 防止外部撞库', () => {
  const crypto = require('crypto')
  const fp = identity.fingerprint('phone', '8613800138000')
  const naive = crypto.createHash('sha256').update('phone\u00008613800138000').digest()
  assert.notDeepEqual(fp, naive, '指纹不得等于裸 SHA256（否则知道号码的人能自己算出来撞库）')
})

test('未配置密钥时给出明确错误，而不是静默算出可预测的哈希', () => {
  const saved = process.env.PIX_IDENTITY_KEY
  delete process.env.PIX_IDENTITY_KEY
  try {
    assert.equal(identity.identityEnabled(), false)
    assert.throws(() => identity.fingerprint('phone', '8613800138000'), /PIX_IDENTITY_KEY/)
  } finally {
    process.env.PIX_IDENTITY_KEY = saved
  }
})

// ---------------------------------------------------------------------------
// 候选收集
// ---------------------------------------------------------------------------

test('候选按可信度排序：手机号 > 平台 ID > 邮箱 > 用户名', () => {
  const list = identity.collectIdentities({
    phone: '+8613800138000',
    platform: 'telegram',
    platformUid: '#123456789',
    email: 'a@b.com',
    username: 'alice'
  })
  assert.deepEqual(list.map(x => x.type), ['phone', 'platform_uid', 'email', 'username'])
  assert.equal(list[0].confidence, 'high')
  assert.equal(list[3].confidence, 'medium')
})

test('姓名不进候选 —— 同名太常见，仅凭姓名合并会污染数据', () => {
  const list = identity.collectIdentities({ name: '张伟', nickname: '张伟' })
  assert.equal(list.length, 0, '姓名不得作为身份候选')
})

test('非法线索被跳过而不是让整批失败', () => {
  const list = identity.collectIdentities({
    phone: '不是号码',
    platform: 'telegram',
    platformUid: '#123456789'
  })
  assert.deepEqual(list.map(x => x.type), ['platform_uid'], '一条线索非法不应影响其他线索')
})
