const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const verifyCode = require('./verifyCode')
const translateApi = require('./translateApi')
const { createSecurity, rateLimit } = require('../server/security')
const translateMemo = Object.create(null)

function now() {
  const d = new Date()
  const p = n => (n < 10 ? '0' + n : '' + n)
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  )
}

function later(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * 表单里的「无限期」开关解析。
 * 前端 el-switch 送的是数字 0/1，encodeForm 会把它变成字符串 '0'/'1'，
 * 而 COALESCE 语义要求"没传"必须是 null（保持原值）—— 所以只认明确的真值。
 */
function isUnlimited(value) {
  return value === 1 || value === '1' || value === true || value === 'true'
}

function q(req) {
  return Object.assign(Object.create(null), req.query || {}, req.body || {})
}

function page(list, query) {
  const pageNo = Math.max(1, Math.min(1_000_000, Number(query.page || 1) || 1))
  const rows = Math.max(1, Math.min(100, Number(query.rows || 10) || 10))
  const start = (pageNo - 1) * rows
  return { rows: list.slice(start, start + rows), total: list.length }
}

function csvHosts(value) {
  return String(value || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
}

function safeLineUrl(value, production) {
  try {
    const parsed = new URL(String(value || ''))
    const host = parsed.hostname.toLowerCase()
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return ''
    if (parsed.protocol !== 'https:' && !(loopback && !production && parsed.protocol === 'http:')) return ''
    const allowed = csvHosts(process.env.PIX_ALLOWED_API_HOSTS)
    if (!loopback && (!allowed.length || !allowed.some(domain => host === domain || host.endsWith('.' + domain)))) return ''
    return parsed.toString().replace(/\/+$/, '')
  } catch (e) {
    return ''
  }
}

function okMsg(res, msg) {
  res.json({ success: 'success', msg: msg || '操作成功' })
}

const settingsFile = path.join(__dirname, 'data', 'settings.json')
const defaultSettings = {
  siteName: 'Hello Pix',
  announcement: '购买即可成为企业用户，每买 1 组增加 1 个子账户名额。子账号里 Telegram / WhatsApp 等不限号。',
  clientDownloadUrl: '',
  officialUrl: '',
  guideUrl: '',
  activeEngine: 'deepseek',
  trialChars: 10000,
  enterpriseMinPacks: 2,
  discount1: 0.9,
  discount10: 0.8,
  discount50: 0.75,
  telegram: '',
  telegramUrl: '',
  supportBtnText: '联系客服',
  supportShow: 1,
  supportNote: '',
  lines: [
    { id: 'cn', name: '国内线路', url: 'http://127.0.0.1:8080', region: '国内', enabled: 1 },
    { id: 'hk', name: '香港线路', url: 'http://127.0.0.1:8080', region: '香港', enabled: 1 },
    { id: 'sg', name: '新加坡线路', url: 'http://127.0.0.1:8080', region: '新加坡', enabled: 1 },
    { id: 'jp', name: '日本线路', url: 'http://127.0.0.1:8080', region: '日本', enabled: 1 },
    { id: 'us', name: '美国线路', url: 'http://127.0.0.1:8080', region: '美国', enabled: 1 }
  ]
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    const merged = Object.assign(clone(defaultSettings), saved)
    if (!Array.isArray(merged.lines) || !merged.lines.length) merged.lines = clone(defaultSettings.lines)
    return merged
  } catch (e) {
    return clone(defaultSettings)
  }
}

module.exports = function registerMock(app, options) {
  const production = process.env.NODE_ENV === 'production'
  const testMode = !!(options && options.testMode)
  const demoDataEnabled = !production && (testMode || process.env.PIX_ENABLE_DEMO_DATA === '1')
  const demoPaymentEnabled = !production && !!(options && options.enableDemoPayment)
  const security = (options && options.security) || createSecurity({
    production
  })
  app.use(security.headers)
  app.use('/apis', rateLimit({ windowMs: 60_000, max: 300 }))
  app.use(
    ['/apis/login', '/apis/client/login', '/apis/admin/login'],
    rateLimit({ windowMs: 15 * 60_000, max: 20, key: req => req.ip })
  )
  app.use(
    ['/apis/login', '/apis/client/login', '/apis/admin/login'],
    rateLimit({
      windowMs: 15 * 60_000,
      max: 8,
      key: req => `${req.ip}:${String(q(req).username || '').toLowerCase()}`
    })
  )
  app.use(
    ['/apis/user/emailCode', '/apis/user/register', '/apis/user/forgot'],
    rateLimit({ windowMs: 10 * 60_000, max: 5 })
  )
  app.use(
    ['/apis/order/selectOrderBySerialNumber', '/apis/order/checkSharePwd'],
    rateLimit({
      windowMs: 15 * 60_000,
      max: 6,
      key: req => `${req.ip}:${String(q(req).serialNumber || '')}`
    })
  )
  const accountLimitKey = req => {
    const session = security.resolveSession(req, 'user')
    return session ? `user:${session.subjectId}` : `ip:${req.ip}`
  }
  app.use('/apis/translate/run', rateLimit({ windowMs: 60_000, max: 60, key: accountLimitKey }))
  app.use(['/apis/export', '/apis/export2'], rateLimit({ windowMs: 60 * 60_000, max: 10, key: accountLimitKey }))
  app.use('/apis', security.originGuard)

  const db = {
    users: [
      { id: 10001, username: 'pix', password: '123456', nickname: '皮克斯商户', status: 1, basename: 'Hello Pix 专业版', versionId: 3, port: 0, userPorts: 2, expireTime: later(90), createTime: now(), charBalance: 186000, autoReply: 1, phone: '13800000001', remarks: '主力商户', activeEngine: 'deepseek', enterprise: 1, boundDevice: '', email: 'pix@hello.pix', subQuota: 5, autoAllocMaster: 0, translateCount: 128, charUsed: 42000 },
      { id: 10002, username: 'demo', password: '123456', nickname: '演示商户', status: 1, basename: 'Hello Pix 基础版', versionId: 1, port: 0, userPorts: 0, expireTime: later(30), createTime: now(), charBalance: 45000, autoReply: 0, phone: '', remarks: '', activeEngine: 'deepseek', enterprise: 0, boundDevice: '', email: 'demo@hello.pix', subQuota: 0, autoAllocMaster: 0, translateCount: 0, charUsed: 0 }
    ],
    admins: [
      { id: 1, username: 'admin', password: 'admin123', nickname: '超级管理员', role: 'superadmin' }
    ],
    versions: [
      { id: 1, title: 'Hello Pix 基础版', subtitle: '基本功能，适合小型企业', port: 0, portUnlimited: 1, chars: 1500000, price: 35, engines: ['deepseek', 'baidu', 'niutrans'], clients: { standalone: 0, mobile: 1, counter: 0 }, highlights: ['150万字符', 'DeepSeek 翻译', '百度翻译', '小牛翻译', '语种全，性价比高', '手机版'], features: { autoFill: 1, export: 1, moveMaster: 1, fanStats: 1, autoReply: 1, assistant: 1, repeatFan: 1, rotate: 1, keepChat: 0, counterRepeat: 1, ssl: 1, aws: 0, support: 0, feedback: 1 } },
      { id: 2, title: 'Hello Pix 高级版', subtitle: '高级功能，适合中大型企业', port: 0, portUnlimited: 1, chars: 3000000, price: 65, engines: ['deepseek', 'baidu', 'niutrans', 'google'], clients: { standalone: 0, mobile: 1, counter: 0 }, highlights: ['300万字符', '谷歌翻译', '+基础版各翻译通道', '语种全，翻译准确性高', '手机版'], features: { autoFill: 1, export: 1, moveMaster: 1, fanStats: 1, autoReply: 1, assistant: 1, repeatFan: 1, rotate: 1, keepChat: 1, counterRepeat: 1, ssl: 1, aws: 0, support: 1, feedback: 1 } },
      { id: 3, title: 'Hello Pix 专业版', subtitle: '定制化解决方案', port: 0, portUnlimited: 1, chars: 7500000, price: 125, engines: ['deepseek', 'baidu', 'niutrans', 'google', 'deepl', 'aws'], clients: { standalone: 0, mobile: 1, counter: 1 }, highlights: ['750万字符', 'DEEPL翻译', '亚马逊AWS翻译', '+高级版各翻译通道', '语种全，通道多，翻译准确性高', '手机版'], features: { autoFill: 1, export: 1, moveMaster: 1, fanStats: 1, autoReply: 1, assistant: 1, repeatFan: 1, rotate: 1, keepChat: 1, counterRepeat: 1, ssl: 1, aws: 1, support: 1, feedback: 1 } }
    ],
    settings: loadSettings(),
    // costPerMillion 的单位是**美元/百万字符**（与 packages.price 同币种，见迁移 032）。
    // 这里有历史遗留的旧通道（baidu / niutrans）与缺失的新通道 —— 那是另一件事，
    // 但币种必须与生产一致，否则本地开发会看到"表头写美元、数值是人民币"。
    engines: [
      { id: 'deepseek', name: 'DeepSeek 翻译', provider: 'DeepSeek', tier: 'pro', enabled: 1, wired: 0, costPerMillion: 0.83, model: 'deepseek-flash', apiKey: '', secret: '', endpoint: '', note: '需要 API Key 与模型名。' },
      { id: 'baidu', name: '百度翻译', provider: '百度', tier: 'basic', enabled: 1, wired: 0, costPerMillion: 6.81, model: '', apiKey: '', secret: '', endpoint: '', note: '成本超管手填。接口板块已就位，未接厂商。' },
      { id: 'niutrans', name: '小牛翻译', provider: '小牛', tier: 'basic', enabled: 1, wired: 0, costPerMillion: 6.94, model: '', apiKey: '', secret: '', endpoint: '', note: '成本超管手填。接口板块已就位，未接厂商。' },
      { id: 'google', name: '谷歌翻译', provider: 'Google', tier: 'advanced', enabled: 1, wired: 0, costPerMillion: 18.61, model: 'google-translate-v2', apiKey: '', secret: '', endpoint: '', note: '成本超管手填。接口板块已就位，未接厂商。' },
      { id: 'deepl', name: 'DeepL 翻译', provider: 'DeepL', tier: 'pro', enabled: 1, wired: 0, costPerMillion: 23.33, model: '', apiKey: '', secret: '', endpoint: '', note: '成本超管手填。接口板块已就位，未接厂商。' },
      { id: 'aws', name: '亚马逊 AWS 翻译', provider: 'Amazon', tier: 'pro', enabled: 1, wired: 0, costPerMillion: 13.89, model: '', apiKey: '', secret: '', endpoint: '', note: '成本超管手填。接口板块已就位，未接厂商。' },
      { id: 'gpt', name: 'GPT 翻译', provider: 'OpenAI', tier: 'pro', enabled: 1, wired: 0, costPerMillion: 0.69, model: 'gpt-4o-mini', apiKey: '', secret: '', endpoint: '', note: 'Hello Pix 增补。成本超管手填，按 token 估算。未接厂商。' },
      { id: 'grok', name: 'Grok 翻译', provider: 'xAI', tier: 'pro', enabled: 1, wired: 0, costPerMillion: 4.03, model: 'grok-4.3', apiKey: '', secret: '', endpoint: '', note: 'Hello Pix 增补。成本超管手填，按 token 估算。未接厂商。' }
    ],
    translateLogs: [
      { id: 1, userId: 10001, username: 'pix', engine: 'deepseek', direction: 'en→zh', chars: 86, cost: 0.0041, sell: 0.0487, snippet: 'Hello, I want to know the price', createTime: now() },
      { id: 2, userId: 10001, username: 'pix', engine: 'deepseek', direction: 'zh→en', chars: 42, cost: 0.002, sell: 0.0238, snippet: '您好，这是我们的套餐说明', createTime: later(-0.05) },
      { id: 3, userId: 10002, username: 'demo', engine: 'deepseek', direction: 'en→zh', chars: 120, cost: 0.0058, sell: 0.016, snippet: 'Can you send the catalog?', createTime: later(-1) }
    ],
    audits: [
      { id: 1, admin: 'admin', action: '登录超管后台', detail: '', createTime: now(), ip: '127.0.0.1' }
    ],
    notices: [
      { id: 1, title: '企业用户说明', content: '购买即可成为企业用户，每买 1 组增加 1 个子账户名额。子账号里 Telegram / WhatsApp 等不限号。', enabled: 1, createTime: now() }
    ],
    faqs: [
      { id: 1, question: '新用户有试用字符吗？', answer: '超管新建商户时默认赠送 10000 试用字符，可在系统设置里改数量。', sort: 1, enabled: 1 },
      { id: 2, question: '翻译接口接好了吗？', answer: '通道列表已就位，真实 API 尚未接入，选择通道只记账不翻译。', sort: 2, enabled: 1 },
      { id: 3, question: '端口还限吗？', answer: '子账号里 WhatsApp / Telegram 等聊天号不限。同一账号同时只能在一台电脑登录，新电脑登录会把旧电脑踢下线。', sort: 3, enabled: 1 },
      { id: 4, question: '怎么开子账号？', answer: '购买字符即可成为企业用户，每买 1 组增加 1 个子账户名额，主账户在网站里开子账号并分配字符。', sort: 4, enabled: 1 },
      { id: 6, question: '字符怎么计费？', answer: '和官网一样按套餐整包买：基础 200 元 / 150 万、高级 350 元 / 150 万、专业 850 元 / 150 万。1 组 9 折、10 组 8 折、50 组 7.5 折。计字按国际标准，英文 1 个字符、汉字 2 个字符。翻译时扣余额，不另按 1500 字计价。', sort: 6, enabled: 1 }
    ],
    clients: [
      { id: 1, group: 'Windows', title: '跨境电商助手', os: 'Windows 10/11', arch: '64位', app: '', version: '1.0.0', url: '', enabled: 1, note: '官网对应项，安装包后补' },
      { id: 2, group: 'Windows', title: '跨境电商助手', os: 'Windows 10/11', arch: '32位', app: '', version: '1.0.0', url: '', enabled: 1, note: '' },
      { id: 3, group: 'Windows', title: '跨境电商助手', os: 'Windows 7', arch: '64位', app: '', version: '1.0.0', url: '', enabled: 1, note: '' },
      { id: 4, group: 'Windows', title: '跨境电商助手', os: 'Windows 7', arch: '32位', app: '', version: '1.0.0', url: '', enabled: 1, note: '' },
      { id: 5, group: 'Windows', title: '精简版', os: 'Windows', arch: '', app: '', version: '1.0.0', url: '', enabled: 1, note: '' },
      { id: 6, group: 'macOS', title: '跨境电商助手', os: 'macOS', arch: 'Apple 芯片', app: '', version: '1.0.0', url: '', enabled: 1, note: '' },
      { id: 7, group: 'macOS', title: '跨境电商助手', os: 'macOS', arch: 'Intel', app: '', version: '1.0.0', url: '', enabled: 1, note: '' },
      { id: 8, group: 'Android', title: '跨境电商助手', os: 'Android', arch: '', app: 'KakaoTalk', version: '1.0.0', url: '', enabled: 1, note: '' },
      { id: 9, group: 'Android', title: '跨境电商助手', os: 'Android', arch: '', app: 'WhatsApp', version: '1.0.0', url: '', enabled: 1, note: '' },
      { id: 10, group: 'Android', title: '跨境电商助手', os: 'Android', arch: '', app: 'Viber', version: '1.0.0', url: '', enabled: 1, note: '' },
      { id: 11, group: 'Android', title: '跨境电商助手', os: 'Android', arch: '', app: 'Telegram', version: '1.0.0', url: '', enabled: 1, note: '' },
      { id: 12, group: 'Android', title: '跨境电商助手', os: 'Android', arch: '', app: 'Snapchat', version: '1.0.0', url: '', enabled: 1, note: '' },
      { id: 13, group: '独立应用', title: 'Signal 翻译客户端', os: '桌面', arch: '', app: 'Signal', version: '1.0.0', url: '', enabled: 1, note: '' },
      { id: 14, group: '独立应用', title: 'Telegram 翻译桌面版', os: '桌面', arch: '', app: 'Telegram', version: '1.0.0', url: '', enabled: 1, note: '' },
      { id: 15, group: '计数器', title: '计数器版本', os: 'Windows', arch: '', app: '工单计数', version: '1.0.0', url: '', enabled: 1, note: '对应官网计数器产品' }
    ],
    orders: [
      {
        id: 1, userId: 10001, serialNumber: 'HP20260902001', title: '演示工单-WhatsApp', type: 'whatsApp',
        usePorts: 2, port: 10, onlineTotal: 1, totalUser: 2, completeTarget: 12, totalTarget: 100, dayTarget: 20,
        sharePassword: 'abc123', createTime: now(), expirationTime: later(30), passwordExpirationTime: later(7),
        distributionMode: 1, status: 1, zeroTime: '00:00:00', remarks: 'Hello Pix 本地演示工单'
      },
      {
        id: 2, userId: 10001, serialNumber: 'HP20260902002', title: '演示工单-Line', type: 'Line',
        usePorts: 0, port: 5, onlineTotal: 0, totalUser: 1, completeTarget: 0, totalTarget: 50, dayTarget: 10,
        sharePassword: '', createTime: now(), expirationTime: later(15), passwordExpirationTime: later(3),
        distributionMode: 2, status: 1, zeroTime: '00:00:00', remarks: ''
      }
    ],
    details: [
      { orderNum: 'HP20260902001', wsid: '10001', account: '8613800000001', nickName: '演示主号A', completedDayTarget: 8, dayTarget: 20, completedTotalTarget: 12, totalTarget: 100, repeatQuantity: 1, lastLogintime: now(), lastTime: now(), offlineTime: later(-1), occupied: 1, onlineStatus: 1, distribution: 1, version: 'Hello Pix', remarks: '在线' },
      { orderNum: 'HP20260902001', wsid: '10002', account: '8613800000002', nickName: '演示主号B', completedDayTarget: 4, dayTarget: 20, completedTotalTarget: 4, totalTarget: 100, repeatQuantity: 0, lastLogintime: later(-1), lastTime: later(-1), offlineTime: later(-0.5), occupied: 0, onlineStatus: 0, distribution: 0, version: 'Hello Pix', remarks: '离线' }
    ],
    fans: [
      { orderNum: 'HP20260902001', headImg: '', account: '628123456789', nickName: '新用户A', createTime: now(), insertTime: now(), type: '新粉', repeatAccount: '', loginAccount: '8613800000001' },
      { orderNum: 'HP20260902001', headImg: '', account: '628987654321', nickName: '回访用户B', createTime: later(-2), insertTime: now(), type: '重粉', repeatAccount: '8613800000001', loginAccount: '8613800000001' }
    ],
    shortLinks: [
      { id: 1, platform: 'is.gd', shareLink: 'http://localhost:8080/#/empty', type: 1, pattern: 1, message: 'Hello Pix 分流演示', hits: 3, orderNum: 'HP20260902001', accounts: '8613800000001,8613800000002' }
    ],
    assistantGroups: [
      { id: 1, userId: 10001, title: '默认话术' },
      { id: 2, userId: 10001, title: '售后回复' }
    ],
    assistantDetails: [
      { id: 1, groupid: 1, keyword: '你好', source: 'hello', target: '您好，有什么可以帮您？' },
      { id: 2, groupid: 1, keyword: '价格', source: 'price', target: '请查看 Hello Pix 套餐说明' }
    ],
    recharges: [
      { id: 1, userId: 10001, username: 'pix', orderNum: 'HP20260902001', price: 765, originalPrice: 850, discountAmount: 85, paidAmount: 765, basename: 'Hello Pix 专业版', month: 1, status: 1, type: '微信', createTime: now(), kind: '套餐', orderType: '专业版' },
      { id: 2, userId: 10001, username: 'pix', orderNum: 'CHAR20260902001', price: 0, originalPrice: 0, discountAmount: 0, paidAmount: 0, basename: '字符包 150万', month: 0, status: 1, type: '后台赠送', createTime: later(-3), kind: '字符', chars: 1500000, orderType: '赠送' }
    ],
    logins: [
      { account: '8613800000001', loginType: '客户端', loginTime: now(), loginIp: '127.0.0.1', username: 'pix', nickname: '演示主号A' },
      { account: 'pix', loginType: '商户后台', loginTime: later(-0.1), loginIp: '127.0.0.1', username: 'pix', nickname: '皮克斯商户' }
    ],
    targets: [
      { orderNum: 'HP20260902001', wsid: '10001', insertTime: now(), account: '8613800000001', nickName: '演示主号A', completedDayTarget: 8, completedTotalTarget: 12, repeatQuantity: 1, dayTarget: 20, totalTarget: 100 }
    ],
    subAccounts: [
      { id: 20001, parentId: 10001, username: 'pix_a', password: '123456', nickname: '员工A', email: 'pix_a@hello.pix', charBalance: 30000, charUsed: 8600, autoAlloc: 0, status: 1, boundDevice: '', activeEngine: 'deepseek', createTime: now() },
      { id: 20002, parentId: 10001, username: 'pix_b', password: '123456', nickname: '员工B', email: 'pix_b@hello.pix', charBalance: 15000, charUsed: 2100, autoAlloc: 0, status: 1, boundDevice: '', activeEngine: 'deepseek', createTime: now() }
    ]
  }

  if (!demoDataEnabled) {
    ;[
      'users', 'admins', 'translateLogs', 'audits', 'orders', 'details', 'fans',
      'shortLinks', 'assistantGroups', 'assistantDetails', 'recharges', 'logins',
      'targets', 'subAccounts'
    ].forEach(key => { db[key] = [] })
  }

  db.users.concat(db.subAccounts, db.admins).forEach(account => {
    if (!String(account.password || '').startsWith('scrypt$')) {
      account.password = security.hashPassword(account.password)
    }
  })
  const pendingPays = {}
  const appliedPays = {}
  const shareGrants = new Map()
  const verifyStore = verifyCode.createStore()
  db.verify = verifyCode.defaultConfig()
  db.verify.email.revealDemo = testMode ? 1 : 0

  function issueShareGrant(order) {
    const current = Date.now()
    for (const [key, value] of shareGrants) {
      if (value.expiresAt <= current) shareGrants.delete(key)
    }
    while (shareGrants.size >= 2000) shareGrants.delete(shareGrants.keys().next().value)
    const token = crypto.randomBytes(24).toString('base64url')
    const configuredExpiry = new Date(order.passwordExpirationTime).getTime()
    shareGrants.set(token, {
      serialNumber: order.serialNumber,
      expiresAt: Math.min(current + 60 * 60_000, Number.isFinite(configuredExpiry) ? configuredExpiry : current)
    })
    return token
  }

  function validShareGrant(token, serialNumber) {
    const grant = shareGrants.get(String(token || ''))
    if (!grant || grant.expiresAt <= Date.now() || grant.serialNumber !== String(serialNumber || '')) {
      if (grant) shareGrants.delete(String(token))
      return false
    }
    return true
  }

  function validEmail(email) {
    return verifyCode.validEmail(email)
  }

  function validPassword(password) {
    // 与 server/lib/password.js 的 validPassword 保持一致：最少 6 位、不限字符类型
    return String(password || '').length >= 6
  }

  let nextOrderId = 3
  let nextGroupId = 3
  let nextDetailId = 3
  let nextLinkId = 2
  let nextUserId = 10003
  let nextRechargeId = 3
  let nextTranslateId = 4
  let nextAuditId = 2
  let nextAdminId = 2
  let nextNoticeId = 2
  let nextClientId = 16
  let nextFaqId = 7
  let nextSubId = 20003
  let nextLineId = 4

  function currentAdminName(req) {
    return (req.pixAdmin && req.pixAdmin.username) || String(q(req).username || 'system')
  }

  function audit(req, action, detail) {
    db.audits.unshift({
      id: nextAuditId++,
      admin: currentAdminName(req),
      action: action,
      detail: detail || '',
      createTime: now(),
      ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString()
    })
  }

  function engineOf(id) {
    return db.engines.find(e => e.id === (id || db.settings.activeEngine)) || db.engines[0]
  }

  function countBillableChars(text) {
    return translateApi.countBillableChars(text)
  }

  function sellYuan(chars, user) {
    const pack = packOf(user || {})
    const total = Number(pack.chars || 1500000)
    const price = Number(pack.price || 200)
    if (!total || !price) return 0
    return Math.round(Number(chars) / total * price * 10000) / 10000
  }

  function packageBillText() {
    // 币种符号必须与全站的 currencySymbol 一致。
    // 原先是写死的 '¥'，而套餐价与站内其它金额都是美元 ——
    // 会出现"套餐 ¥200"与旁边"$35.685"并排的错位。
    return db.versions.map(v => packShortName(v.title) + ' $' + v.price + '/' + (Number(v.chars || 0) / 10000) + '万').join(' · ')
  }

  function costYuan(chars, engineId) {
    const eng = engineOf(engineId)
    return Math.round((Number(chars) / 1000000) * Number(eng.costPerMillion || 0) * 10000) / 10000
  }

  function enrichUser(u) {
    const copy = Object.assign({}, u)
    delete copy.password
    const subs = db.subAccounts.filter(s => s.parentId === u.id)
    copy.fanCount = db.fans.filter(f => {
      const order = db.orders.find(o => o.serialNumber === f.orderNum)
      return order && order.userId === u.id
    }).length
    copy.charUsed = db.translateLogs.filter(t => t.userId === u.id).reduce((s, t) => s + Number(t.chars || 0), 0)
    copy.enterprise = u.enterprise ? 1 : 0
    copy.subCount = subs.length
    copy.teamChars = Number(u.charBalance || 0) + subs.reduce((s, a) => s + Number(a.charBalance || 0), 0)
    copy.bound = u.boundDevice ? 1 : 0
    copy.imUnlimited = 1
    return copy
  }

  function currentSession(req) {
    const auth = security.resolveSession(req, 'user')
    if (!auth) return null
    const uid = auth.subjectId
    const sub = db.subAccounts.find(s => String(s.id) === String(uid))
    if (sub) {
      const parent = db.users.find(u => u.id === sub.parentId)
      if (!parent) return null
      return { kind: 'sub', account: sub, parent: parent }
    }
    const user = db.users.find(u => String(u.id) === String(uid))
    if (!user) return null
    return { kind: 'main', account: user, parent: user }
  }

  function currentMerchant(req) {
    const session = currentSession(req)
    return session && session.parent
  }

  function ownedOrders(req) {
    const user = currentMerchant(req)
    return user ? db.orders.filter(order => order.userId === user.id) : []
  }

  function ownsOrder(req, serialNumber) {
    return ownedOrders(req).some(order => String(order.serialNumber) === String(serialNumber))
  }

  function ownedOrderRows(req, rows, field) {
    const allowed = new Set(ownedOrders(req).map(order => String(order.serialNumber)))
    return rows.filter(row => allowed.has(String(row[field || 'orderNum'])))
  }

  function publicSub(s) {
    const copy = Object.assign({}, s)
    delete copy.password
    copy.bound = s.boundDevice ? 1 : 0
    copy.imUnlimited = 1
    copy.charUsed = Number(s.charUsed || 0)
    copy.autoAlloc = s.autoAlloc ? 1 : 0
    copy.email = s.email || ''
    return copy
  }

  function discountRate(n) {
    const qty = Math.max(1, Number(n) || 1)
    if (qty >= 50) return Number(db.settings.discount50 || 0.75)
    if (qty >= 10) return Number(db.settings.discount10 || 0.8)
    return Number(db.settings.discount1 || 0.9)
  }

  function packShortName(title) {
    return String(title || '').replace('Hello Pix ', '')
  }

  function currentAnnouncement() {
    const n = db.notices.find(x => Number(x.enabled) === 1)
    return n ? n.content : (db.settings.announcement || '')
  }

  function publicLines() {
    const list = Array.isArray(db.settings.lines) ? db.settings.lines : []
    return list.filter(l => Number(l.enabled) !== 0).map(l => {
      const url = safeLineUrl(l.url, production)
      if (!url) return null
      return {
        id: String(l.id),
        name: l.name || '线路',
        url: url,
        region: l.region || ''
      }
    }).filter(Boolean)
  }

  function persistSettings() {
    try {
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
      fs.writeFileSync(settingsFile, JSON.stringify(db.settings, null, 2))
    } catch (e) {}
  }

  function supportUrlOf() {
    const url = String(db.settings.telegramUrl || '').trim()
    if (url) return url
    const handle = String(db.settings.telegram || '').replace(/^@/, '').trim()
    return handle ? 'https://t.me/' + handle : ''
  }

  function syncAnnouncement(active) {
    if (active && Number(active.enabled) === 1) {
      db.notices.forEach(n => {
        if (n.id !== active.id) n.enabled = 0
      })
      db.settings.announcement = active.content || ''
      return
    }
    const n = db.notices.find(x => Number(x.enabled) === 1)
    db.settings.announcement = n ? (n.content || '') : ''
  }

  function takeDevice(account, deviceId) {
    account.boundDevice = String(deviceId || '').trim() || 'desktop-unknown'
  }

  function deviceIdOf(req) {
    return String(req.headers['x-pix-device'] || q(req).deviceId || '').trim()
  }

  function kicked(res, msg) {
    res.status(401).json({ success: false, kicked: 1, msg: msg || '账号已在其他电脑登录' })
  }

  function loginObj(session) {
    const account = session.account
    const parent = session.parent
    return {
      username: account.username,
      userid: account.id,
      role: session.kind,
      enterprise: parent.enterprise ? 1 : 0,
      parentUsername: parent.username,
      imUnlimited: 1,
      nickname: account.nickname || account.username
    }
  }

  const clientPlatforms = require('../desktop/platforms')

  function findAccount(username, password) {
    const main = db.users.find(u => (u.username === username || (u.email && u.email === username)) && security.verifyPassword(u, password))
    const sub = db.subAccounts.find(s => (s.username === username || (s.email && s.email === username)) && security.verifyPassword(s, password))
    if (!main && !sub) return { ok: false, msg: '用户名或密码错误' }
    const account = main || sub
    if (account.status !== 1) return { ok: false, msg: '账号已停用，请联系超管' }
    if (sub) {
      const parent = db.users.find(u => u.id === sub.parentId)
      if (!parent || parent.status !== 1) return { ok: false, msg: '主账户已停用，请联系超管' }
      return { ok: true, session: { kind: 'sub', account: sub, parent: parent } }
    }
    return { ok: true, session: { kind: 'main', account: main, parent: main } }
  }

  function requireUserSession(req, res) {
    const session = currentSession(req)
    if (!session) {
      res.status(401).json({ success: false, msg: '尚未登录' })
      return null
    }
    if (session.account.status !== 1 || session.parent.status !== 1) {
      res.status(403).json({ success: false, msg: '账号已停用' })
      return null
    }
    return session
  }

  function requireClientSession(req, res) {
    const session = requireUserSession(req, res)
    if (!session) return null
    const device = deviceIdOf(req)
    const auth = security.resolveSession(req, 'user')
    if (!device || !auth || !auth.deviceId || auth.deviceId !== device || session.account.boundDevice !== device) {
      kicked(res)
      return null
    }
    return session
  }

  function clientProfile(session) {
    const account = session.account
    const parent = session.parent
    const pack = packOf(parent)
    const engineId = account.activeEngine || parent.activeEngine || db.settings.activeEngine || 'deepseek'
    const eng = engineOf(engineId)
    return {
      username: account.username,
      nickname: account.nickname || account.username,
      role: session.kind,
      enterprise: parent.enterprise ? 1 : 0,
      packageTitle: packShortName(parent.basename),
      charBalance: session.kind === 'main' ? Number(parent.charBalance || 0) : Number(account.charBalance || 0),
      charUsed: Number(account.charUsed || 0),
      translateCount: Number(account.translateCount || 0),
      activeEngine: eng.id,
      activeEngineName: eng.name,
      engines: allowedEngineIds(parent),
      bound: account.boundDevice ? 1 : 0,
      announcement: currentAnnouncement(),
      transRecv: account.transRecv === 0 ? 0 : 1,
      transSend: account.transSend === 0 ? 0 : 1,
      transGroup: account.transGroup ? 1 : 0,
      langMine: account.langMine || 'zh',
      langOther: account.langOther || 'auto',
      includeZh: account.includeZh ? 1 : 0
    }
  }

  function applyCharPurchase(user, packs, versionId, payType, tradeNo) {
    if (tradeNo && appliedPays[tradeNo]) return appliedPays[tradeNo]
    const pack = db.versions.find(v => String(v.id) === String(versionId)) || packOf(user)
    const n = Math.max(1, Number(packs) || 1)
    const chars = (pack.chars || 1500000) * n
    const oldPack = packOf(user)
    if (oldPack.id !== pack.id && Number(user.charBalance || 0) > 0 && Number(oldPack.price) && Number(pack.price)) {
      user.charBalance = Math.round(Number(user.charBalance) * Number(oldPack.price) / Number(pack.price))
    }
    user.charBalance = Number(user.charBalance || 0) + chars
    user.versionId = pack.id
    user.basename = pack.title
    const upgraded = !user.enterprise
    user.enterprise = 1
    user.subQuota = Number(user.subQuota || 0) + n
    const originalPrice = Number(pack.price || 0) * n
    const rate = discountRate(n)
    const paidAmount = Math.round(originalPrice * rate * 100) / 100
    const discountAmount = Math.round((originalPrice - paidAmount) * 100) / 100
    db.recharges.unshift({
      id: nextRechargeId++,
      userId: user.id,
      username: user.username,
      orderNum: tradeNo || ('PAY' + Date.now()),
      price: paidAmount,
      originalPrice: originalPrice,
      discountAmount: discountAmount,
      paidAmount: paidAmount,
      basename: pack.title + ' ×' + n + (upgraded ? '（已成为企业用户）' : ''),
      month: n,
      status: 1,
      type: payType || '微信',
      createTime: now(),
      kind: '套餐',
      orderType: packShortName(pack.title),
      chars: chars,
      enterpriseUpgrade: upgraded ? 1 : 0,
      subQuotaAdded: n
    })
    const result = { chars: chars, upgraded: upgraded, enterprise: 1, subQuota: user.subQuota, paidAmount: paidAmount }
    if (tradeNo) appliedPays[tradeNo] = result
    return result
  }

  function requireMain(req, res) {
    const session = requireUserSession(req, res)
    if (!session) return null
    if (session.kind !== 'main') {
      res.json({ success: 'error', msg: '子账号不能管理团队，请用主账户登录官网' })
      return null
    }
    return session
  }

  function isAdmin(req) {
    const session = security.resolveSession(req, 'admin')
    if (!session) return null
    return db.admins.find(admin => String(admin.id) === String(session.subjectId)) || null
  }

  function packOf(user) {
    return db.versions.find(v => v.id === user.versionId) || db.versions[0]
  }

  function allowedEngineIds(user) {
    const pack = packOf(user)
    return pack.engines || []
  }

  function publicEngine(e, extra) {
    const copy = Object.assign({
      wired: 0,
      wiredText: e.wired ? '已接入' : '待接入'
    }, e, extra || {})
    copy.hasKey = !!(e.apiKey)
    copy.hasSecret = !!(e.secret)
    if (copy.apiKey) copy.apiKey = '********'
    if (copy.secret) copy.secret = '********'
    return copy
  }

  function userVersionOf(session) {
    const parent = session.parent
    const account = session.account
    const pack = packOf(parent)
    const subs = db.subAccounts.filter(s => s.parentId === parent.id)
    return {
      userid: account.id,
      parentId: parent.id,
      role: session.kind,
      username: account.username,
      parentUsername: parent.username,
      basename: parent.basename,
      versionId: parent.versionId,
      port: parent.port,
      portUnlimited: 1,
      imUnlimited: 1,
      enterprise: parent.enterprise ? 1 : 0,
      enterpriseMinPacks: Number(db.settings.enterpriseMinPacks || 2),
      email: account.email || parent.email || '',
      subCount: subs.length,
      subQuota: Number(parent.subQuota || 0),
      autoAllocMaster: parent.autoAllocMaster ? 1 : 0,
      charUsed: Number(account.charUsed || 0),
      translateCount: Number(account.translateCount || 0),
      packageTitle: packShortName(parent.basename),
      userPorts: parent.userPorts,
      expireTime: parent.expireTime,
      charBalance: account.charBalance || 0,
      parentCharBalance: parent.charBalance || 0,
      chars: pack.chars || 0,
      activeEngine: account.activeEngine || parent.activeEngine || db.settings.activeEngine,
      engines: allowedEngineIds(parent),
      bound: account.boundDevice ? 1 : 0
    }
  }

  const publicApiPaths = new Set([
    '/login',
    '/user/captcha',
    '/user/emailCode',
    '/user/register',
    '/user/forgot',
    '/client/login',
    '/client/lines',
    '/site/info',
    '/userVersion/getVersion',
    '/order/getServerTime',
    '/order/selectOrderBySerialNumber',
    '/order/checkSharePwd',
    '/orderDetails/shareOrder',
    '/orderDetails/getOrderFans',
    '/orderDetails/getTodayFansCount',
    '/orderDetails/jump'
  ])
  const superadminPrefixes = [
    '/admin/staff',
    '/admin/settings',
    '/admin/engines',
    '/admin/verify',
    '/admin/users',
    '/admin/subs',
    '/admin/translate/grant',
    '/admin/versions',
    '/admin/clients'
  ]

  app.use('/apis', (req, res, next) => {
    const pathname = String(req.path || '/').replace(/\/+$/, '') || '/'
    if (publicApiPaths.has(pathname) || pathname === '/admin/login') {
      req.pixPublic = true
      return next()
    }
    if (pathname.startsWith('/admin/')) {
      const admin = isAdmin(req)
      if (!admin) {
        res.status(401).json({ success: false, msg: '超管尚未登录' })
        return
      }
      if (
        (admin.role || 'superadmin') !== 'superadmin' &&
        (
          superadminPrefixes.some(prefix => pathname.startsWith(prefix)) ||
          (!['GET', 'HEAD'].includes(req.method) && pathname !== '/admin/logout')
        )
      ) {
        res.status(403).json({ success: false, msg: '该操作仅限超级管理员' })
        return
      }
      req.pixAdmin = admin
      req.pixSessionType = 'admin'
      return next()
    }
    if (pathname.startsWith('/client/')) {
      if (!requireClientSession(req, res)) return
      req.pixSessionType = 'user'
      return next()
    }
    if (pathname.startsWith('/translate') && req.headers['x-pix-device']) {
      if (!requireClientSession(req, res)) return
      req.pixSessionType = 'user'
      return next()
    }
    if (!requireUserSession(req, res)) return
    req.pixSessionType = 'user'
    next()
  })
  app.use('/apis', security.csrf)

  app.post('/apis/login', (req, res) => {
    const query = q(req)
    const username = query.username
    const password = query.password
    if (!String(query.imageCode || '').trim()) {
      res.json({ success: false, msg: '请输入图形验证码', obj: null })
      return
    }
    const captchaErr = verifyCode.checkCaptcha(verifyStore, query.imageId, query.imageCode, true)
    if (captchaErr) {
      res.json({ success: false, msg: captchaErr, obj: null })
      return
    }
    const found = findAccount(username, password)
    if (!found.ok) {
      res.json({ success: false, msg: found.msg, obj: null })
      return
    }
    const session = found.session
    const account = session.account
    security.destroySession(req, res, 'user')
    security.createSession(res, 'user', account.id, { remember: !!query.remember })
    db.logins.unshift({
      account: account.username,
      loginType: session.kind === 'sub' ? '子账号后台' : '商户后台',
      loginTime: now(),
      loginIp: req.ip || '127.0.0.1',
      username: session.parent.username,
      nickname: account.nickname || account.username
    })
    res.json({ success: true, msg: '登录成功', obj: loginObj(session) })
  })
  app.get('/apis/user/captcha', (req, res) => {
    const data = verifyCode.createCaptcha(verifyStore, db.verify.captcha)
    res.json(Object.assign({ success: true }, data))
  })
  app.post('/apis/user/emailCode', (req, res) => {
    const query = q(req)
    const result = verifyCode.issueEmailCode(verifyStore, query.email, query.scene, db.verify.email)
    if (!result.ok) {
      res.json({ success: false, msg: result.msg })
      return
    }
    res.json({ success: 'success', msg: result.msg, demo: !!result.demo, wired: false })
  })
  app.post('/apis/user/register', (req, res) => {
    const query = q(req)
    const username = String(query.userName || query.username || '').trim()
    const password = String(query.passWord || query.password || '')
    const password2 = String(query.passWord1 || query.password2 || '')
    const email = String(query.email || '').trim().toLowerCase()
    if (!username) { res.json({ success: false, msg: '请输入账号' }); return }
    if (!validPassword(password)) { res.json({ success: false, msg: '密码至少需要 6 位' }); return }
    if (password !== password2) { res.json({ success: false, msg: '两次密码不一致' }); return }
    if (!validEmail(email)) { res.json({ success: false, msg: '请输入邮箱地址' }); return }
    const captchaErr = verifyCode.checkCaptcha(verifyStore, query.imageId, query.imageCode, true)
    if (captchaErr) { res.json({ success: false, msg: captchaErr }); return }
    const codeErr = verifyCode.checkEmailCode(verifyStore, email, query.code, 'register')
    if (codeErr) { res.json({ success: false, msg: codeErr }); return }
    if (db.users.find(u => u.username === username) || db.subAccounts.find(s => s.username === username)) {
      res.json({ success: false, msg: '账号已被占用' })
      return
    }
    if (db.users.find(u => (u.email || '').toLowerCase() === email) || db.subAccounts.find(s => (s.email || '').toLowerCase() === email)) {
      res.json({ success: false, msg: '邮箱已被占用' })
      return
    }
    const pack = db.versions[0]
    const gift = testMode ? Number(db.settings.trialChars || 0) : 0
    const created = {
      id: nextUserId++,
      username: username,
      password: security.hashPassword(password),
      nickname: username,
      status: 1,
      basename: pack.title,
      versionId: pack.id,
      port: 0,
      userPorts: 0,
      expireTime: later(30),
      createTime: now(),
      charBalance: gift,
      autoReply: 0,
      phone: '',
      remarks: '',
      activeEngine: 'deepseek',
      enterprise: 0,
      boundDevice: '',
      email: email,
      emailVerified: 1,
      subQuota: 0,
      autoAllocMaster: 0,
      translateCount: 0,
      charUsed: 0
    }
    db.users.push(created)
    if (gift > 0) {
      db.recharges.unshift({
        id: nextRechargeId++,
        userId: created.id,
        username: created.username,
        orderNum: 'TRIAL' + Date.now(),
        price: 0,
        originalPrice: 0,
        discountAmount: 0,
        paidAmount: 0,
        basename: '新用户试用 ' + gift + ' 字符',
        month: 0,
        status: 1,
        type: '试用赠送',
        createTime: now(),
        kind: '试用',
        orderType: '试用',
        chars: gift
      })
    }
    verifyCode.consumeEmail(verifyStore, email)
    res.json({ success: true, msg: '注册成功', obj: { username: created.username, email: created.email } })
  })
  app.post('/apis/user/forgot', (req, res) => {
    const query = q(req)
    const email = String(query.email || '').trim().toLowerCase()
    const password = String(query.passWord || query.password || '')
    const password2 = String(query.passWord1 || query.password2 || '')
    if (!validEmail(email)) { res.json({ success: false, msg: '请输入邮箱地址' }); return }
    if (!validPassword(password)) { res.json({ success: false, msg: '密码至少需要 6 位' }); return }
    if (password !== password2) { res.json({ success: false, msg: '两次密码不一致' }); return }
    const captchaErr = verifyCode.checkCaptcha(verifyStore, query.imageId, query.imageCode, true)
    if (captchaErr) { res.json({ success: false, msg: captchaErr }); return }
    const codeErr = verifyCode.checkEmailCode(verifyStore, email, query.code, 'forgot')
    if (codeErr) { res.json({ success: false, msg: codeErr }); return }
    const user = db.users.find(u => (u.email || '').toLowerCase() === email)
    if (!user) { res.json({ success: false, msg: '该邮箱未注册' }); return }
    user.password = security.hashPassword(password)
    security.revokeSubject('user', user.id)
    verifyCode.consumeEmail(verifyStore, email)
    res.json({ success: true, msg: '密码已重置，请登录' })
  })
  app.post('/apis/logout', (req, res) => {
    security.destroySession(req, res, 'user')
    okMsg(res, '已退出')
  })
  app.post('/apis/client/login', (req, res) => {
    const query = q(req)
    const found = findAccount(query.username, query.password)
    if (!found.ok) {
      res.json({ success: false, msg: found.msg, obj: null })
      return
    }
    const session = found.session
    const deviceId = String(query.deviceId || '').trim()
    if (!deviceId) {
      res.status(400).json({ success: false, msg: '缺少设备标识' })
      return
    }
    takeDevice(session.account, deviceId)
    security.destroySession(req, res, 'user')
    security.createSession(res, 'user', session.account.id, { deviceId, remember: true })
    db.logins.unshift({
      account: session.account.username,
      loginType: '客户端',
      loginTime: now(),
      loginIp: req.ip || '127.0.0.1',
      username: session.parent.username,
      nickname: session.account.nickname || session.account.username
    })
    res.json({ success: true, msg: '登录成功', obj: clientProfile(session) })
  })
  app.get('/apis/client/session', (req, res) => {
    const session = requireClientSession(req, res)
    if (!session) return
    res.json({ success: true, obj: clientProfile(session) })
  })
  app.post('/apis/client/logout', (req, res) => {
    security.destroySession(req, res, 'user')
    okMsg(res, '已退出')
  })
  app.get('/apis/client/platforms', (req, res) => {
    const session = requireClientSession(req, res)
    if (!session) return
    res.json({ success: true, rows: clientPlatforms.filter(item => item.listed !== false) })
  })
  app.post('/apis/client/translate-prefs', (req, res) => {
    const session = requireClientSession(req, res)
    if (!session) return
    const query = q(req)
    const account = session.account
    if (query.transRecv !== undefined) account.transRecv = Number(query.transRecv) ? 1 : 0
    if (query.transSend !== undefined) account.transSend = Number(query.transSend) ? 1 : 0
    if (query.transGroup !== undefined) account.transGroup = Number(query.transGroup) ? 1 : 0
    if (query.langMine) account.langMine = String(query.langMine)
    if (query.langOther) account.langOther = String(query.langOther)
    if (query.includeZh !== undefined) account.includeZh = Number(query.includeZh) ? 1 : 0
    if (query.engine) {
      const id = String(query.engine)
      if (allowedEngineIds(session.parent).indexOf(id) !== -1) account.activeEngine = id
    }
    okMsg(res, '翻译选项已保存')
  })
  app.get('/apis/client/update', (req, res) => {
    const session = requireClientSession(req, res)
    if (!session) return
    const os = String(q(req).os || '')
    const arch = String(q(req).arch || '')
    const list = (db.clients || []).filter(c => Number(c.enabled) !== 0)
    const score = (c) => {
      const text = [c.group, c.os, c.arch, c.app].join(' ')
      let n = 0
      if (os === 'darwin' && /mac/i.test(text)) n += 10
      if (os === 'win32' && /windows/i.test(text)) n += 10
      if (os === 'linux' && /linux/i.test(text)) n += 10
      if (arch === 'arm64' && /Apple|arm/i.test(text)) n += 4
      if ((arch === 'x64' || arch === 'ia32') && /Intel|64|32/i.test(text)) n += 2
      if (!c.app) n += 1
      return n
    }
    const row = list.slice().sort((a, b) => score(b) - score(a))[0]
    res.json({
      success: true,
      version: (row && row.version) || '',
      url: (row && row.url) || db.settings.clientDownloadUrl || '',
      title: (row && row.title) || '',
      os: (row && row.os) || ''
    })
  })
  app.get('/apis/userVersion/getUserVersion', (req, res) => {
    res.json(userVersionOf(currentSession(req)))
  })
  app.post('/apis/userVersion/getVersion', (req, res) => res.json(db.versions))
  app.get('/apis/translate/engines', (req, res) => {
    const session = currentSession(req)
    const user = session.parent
    const account = session.account
    const allowed = allowedEngineIds(user)
    const active = account.activeEngine || user.activeEngine || 'deepseek'
    res.json({
      wired: false,
      msg: '翻译接口板块已就位，厂商请求尚未接入。成本由超管填写，不调取厂商计费。',
      packageTitle: user.basename,
      charBalance: account.charBalance || 0,
      activeEngine: allowed.indexOf(active) !== -1 ? active : allowed[0],
      rows: db.engines.map(e => publicEngine(e, {
        allowed: allowed.indexOf(e.id) !== -1,
        active: e.id === active && allowed.indexOf(e.id) !== -1
      }))
    })
  })
  app.post('/apis/translate/engines/active', (req, res) => {
    const session = currentSession(req)
    const user = session.parent
    const account = session.account
    const id = q(req).id
    if (allowedEngineIds(user).indexOf(id) === -1) {
      res.json({ success: 'error', msg: '当前套餐未包含此通道' })
      return
    }
    const eng = db.engines.find(e => e.id === id)
    if (!eng) { res.json({ success: 'error', msg: '通道不存在' }); return }
    account.activeEngine = eng.id
    okMsg(res, '已选择 ' + eng.name + '（接口尚未接入）')
  })
  async function handleTranslate(req, res) {
    const session = currentSession(req)
    const parent = session.parent
    const account = session.account
    const query = q(req)
    const raw = String(query.text || query.source || '').trim()
    if (raw.length > 5000) {
      res.status(413).json({ success: false, msg: '单次翻译最多 5000 个字符' })
      return
    }
    const text = raw
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/[\uFE0F\u200D\u20E3]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!raw) {
      res.json({ success: false, msg: '请输入要翻译的文本' })
      return
    }
    if (!text) {
      res.json({
        success: true,
        wired: true,
        skipped: 'emoji',
        translation: '',
        chars: 0,
        remain: Number(account.charBalance || 0)
      })
      return
    }
    const from = String(query.from || 'auto')
    const to = String(query.to || 'zh')
    const validLang = value => /^(?:auto|[a-z]{2,3}(?:-[a-z0-9]{2,8})?)$/i.test(value)
    if (!validLang(from) || !validLang(to)) {
      res.status(400).json({ success: false, msg: '语言参数无效' })
      return
    }
    const engineId = String(query.engine || account.activeEngine || parent.activeEngine || 'deepseek')
    if (allowedEngineIds(parent).indexOf(engineId) === -1) {
      res.json({ success: false, msg: '当前套餐未包含此通道' })
      return
    }
    const eng = db.engines.find(e => e.id === engineId)
    if (!eng) {
      res.json({ success: false, msg: '通道不存在' })
      return
    }
    const memoKey = account.id + '\t' + engineId + '\t' + from + '\t' + to + '\t' + text
    const chars = countBillableChars(text)
    if (Number(account.charBalance || 0) < chars) {
      res.json({ success: false, msg: '字符余额不足' })
      return
    }
    account.charBalance = Number(account.charBalance || 0) - chars
    const cachedText = translateMemo[memoKey]
    let result
    try {
      result = cachedText
        ? { ok: true, text: cachedText, cached: true }
        : await translateApi.translate(eng, {
          text: text,
          from: from,
          to: to,
          detected: translateApi.detectLang(text)
        }, {
          allowPublicNetwork: !production && process.env.PIX_ALLOW_PUBLIC_TRANSLATION === '1'
        })
    } catch (e) {
      account.charBalance = Number(account.charBalance || 0) + chars
      res.status(502).json({ success: false, wired: false, chars: chars, remain: account.charBalance, msg: '翻译服务暂不可用' })
      return
    }
    if (!result || !result.ok) {
      account.charBalance = Number(account.charBalance || 0) + chars
      res.json({
        success: false,
        wired: false,
        chars: chars,
        remain: Number(account.charBalance || 0),
        msg: (result && result.msg) || '翻译接口尚未接入'
      })
      return
    }
    const translatedText = String(result.text || '').trim()
    if (result.skipped || !translatedText || translatedText.toLocaleLowerCase() === text.toLocaleLowerCase()) {
      account.charBalance = Number(account.charBalance || 0) + chars
      res.json({
        success: true,
        wired: true,
        skipped: result.skipped || 'unchanged',
        translation: translatedText,
        chars: 0,
        remain: account.charBalance,
        from: from === 'auto' ? translateApi.detectLang(text) : from,
        engine: eng.id
      })
      return
    }
    account.charUsed = Number(account.charUsed || 0) + chars
    account.translateCount = Number(account.translateCount || 0) + 1
    translateMemo[memoKey] = result.text
    const memoKeys = Object.keys(translateMemo)
    if (memoKeys.length > 4000) {
      memoKeys.slice(0, memoKeys.length - 3000).forEach(k => { delete translateMemo[k] })
    }
    const cost = costYuan(chars, eng.id)
    const sell = sellYuan(chars, parent)
    db.translateLogs.unshift({
      id: nextTranslateId++,
      userId: parent.id,
      username: parent.username,
      engine: eng.id,
      direction: (from === 'auto' ? translateApi.detectLang(text) : from) + '→' + to,
      chars: chars,
      cost: cost,
      sell: sell,
      snippet: text.slice(0, 40),
      createTime: now()
    })
    res.json({
      success: true,
      wired: true,
      cached: !!result.cached,
      translation: result.text,
      chars: chars,
      remain: account.charBalance,
      from: from === 'auto' ? translateApi.detectLang(text) : from,
      engine: eng.id
    })
  }
  app.post('/apis/translate/run', handleTranslate)
  app.post('/apis/translate', handleTranslate)
  app.get('/apis/userRecharge/getUserRecharge', (req, res) => {
    const user = currentMerchant(req)
    const query = q(req)
    let list = db.recharges.filter(r => r.userId === user.id)
    if (query.orderNum) list = list.filter(r => String(r.orderNum).includes(query.orderNum))
    if (query.status !== undefined && query.status !== '') list = list.filter(r => String(r.status) === String(query.status))
    if (query.type) list = list.filter(r => String(r.type).includes(query.type))
    if (query.beginTime) list = list.filter(r => String(r.createTime) >= String(query.beginTime))
    if (query.endTime) list = list.filter(r => String(r.createTime) <= String(query.endTime))
    list = list.map(r => Object.assign({
      originalPrice: r.originalPrice != null ? r.originalPrice : r.price,
      discountAmount: r.discountAmount || 0,
      paidAmount: r.paidAmount != null ? r.paidAmount : r.price,
      orderType: r.orderType || r.kind || r.basename
    }, r))
    res.json(page(list, query))
  })
  app.get('/apis/user/dashboard', (req, res) => {
    const session = currentSession(req)
    const parent = session.parent
    const account = session.account
    const pack = packOf(parent)
    const subs = db.subAccounts.filter(s => s.parentId === parent.id)
    res.json({
      role: session.kind,
      username: account.username,
      nickname: account.nickname || account.username,
      email: account.email || parent.email || '',
      packageTitle: packShortName(parent.basename),
      versionId: parent.versionId,
      charBalance: session.kind === 'main' ? Number(parent.charBalance || 0) : Number(account.charBalance || 0),
      parentCharBalance: Number(parent.charBalance || 0),
      subCount: subs.length,
      subQuota: Number(parent.subQuota || 0),
      autoAllocMaster: parent.autoAllocMaster ? 1 : 0,
      charUsed: Number(account.charUsed || 0),
      translateCount: Number(account.translateCount || 0),
      enterprise: parent.enterprise ? 1 : 0,
      announcement: currentAnnouncement(),
      telegram: db.settings.telegram,
      telegramUrl: supportUrlOf(),
      clientDownloadUrl: db.settings.clientDownloadUrl,
      subs: session.kind === 'main' ? subs.map(publicSub) : []
    })
  })
  app.get('/apis/user/quote', (req, res) => {
    const query = q(req)
    const pack = db.versions.find(v => String(v.id) === String(query.baseid || query.id)) || db.versions[0]
    const n = Math.max(1, Number(query.month || query.qty || 1))
    const originalPrice = Number(pack.price || 0) * n
    const rate = discountRate(n)
    const paidAmount = Math.round(originalPrice * rate * 100) / 100
    res.json({
      qty: n,
      rate: rate,
      originalPrice: originalPrice,
      discountAmount: Math.round((originalPrice - paidAmount) * 100) / 100,
      paidAmount: paidAmount,
      subQuotaAdded: n,
      chars: (pack.chars || 1500000) * n
    })
  })

  app.post('/apis/order/getOrder', (req, res) => {
    const query = q(req)
    const user = currentMerchant(req)
    let list = db.orders.filter(o => o.userId === user.id)
    if (query.serialNumber) list = list.filter(o => String(o.serialNumber).includes(query.serialNumber))
    if (query.title) list = list.filter(o => String(o.title).includes(query.title))
    if (query.status) list = list.filter(o => String(o.status) === String(query.status))
    res.json(page(list, query))
  })

  app.post('/apis/order/editOrder', (req, res) => {
    const query = q(req)
    const user = currentMerchant(req)
    const operates = (req.query && req.query.orderOperates) || 'edit'
    if (operates === 'add') {
      db.orders.unshift({
        id: nextOrderId++,
        userId: user.id,
        serialNumber: 'HP' + Date.now(),
        title: query.title || '新工单',
        type: query.type || 'whatsApp',
        usePorts: 0,
        port: Number(query.port || 1),
        onlineTotal: 0,
        totalUser: 0,
        completeTarget: 0,
        totalTarget: Number(query.totalTarget || 0),
        dayTarget: Number(query.dayTarget || 1),
        sharePassword: '',
        createTime: now(),
        expirationTime: query.expirationTime || later(30),
        passwordExpirationTime: later(7),
        distributionMode: 1,
        status: 1,
        zeroTime: query.zeroTime || '00:00:00',
        remarks: query.remarks || '',
        assistant: query.assistant || ''
      })
      okMsg(res, '创建成功')
      return
    }
    const item = db.orders.find(o => String(o.id) === String(query.id) && o.userId === user.id)
    if (!item) {
      res.status(404).json({ success: false, msg: '工单不存在' })
      return
    }
    ;['title', 'type', 'expirationTime', 'zeroTime', 'remarks', 'assistant'].forEach(key => {
      if (query[key] !== undefined) item[key] = String(query[key]).slice(0, key === 'remarks' ? 1000 : 200)
    })
    ;['port', 'totalTarget', 'dayTarget', 'distributionMode'].forEach(key => {
      if (query[key] !== undefined && Number.isFinite(Number(query[key]))) item[key] = Number(query[key])
    })
    okMsg(res, '保存成功')
  })

  app.post('/apis/order/deleteOrder', (req, res) => {
    const ids = String(q(req).orderIds || '').split(',').filter(Boolean)
    const user = currentMerchant(req)
    db.orders = db.orders.filter(o => !(ids.indexOf(String(o.id)) !== -1 && o.userId === user.id))
    okMsg(res, '删除成功')
  })
  app.post('/apis/order/orderCloseOrOpen', (req, res) => {
    const query = q(req)
    const user = currentMerchant(req)
    const nums = String(query.orderNums || '').split(',').filter(Boolean)
    db.orders.forEach(o => {
      if (o.userId === user.id && nums.indexOf(o.serialNumber) !== -1) o.status = Number(query.type || 1)
    })
    okMsg(res, '操作成功')
  })
  app.post('/apis/order/setOrderExpTime', (req, res) => {
    const query = q(req)
    const user = currentMerchant(req)
    const nums = String(query.orderNums || '').split(',').filter(Boolean)
    db.orders.forEach(o => {
      if (o.userId === user.id && nums.indexOf(o.serialNumber) !== -1) o.expirationTime = later(Number(query.orderDays || 1))
    })
    okMsg(res, '续时成功')
  })
  app.post('/apis/order/setDistributionMode', (req, res) => okMsg(res, '设置成功'))
  app.post('/apis/order/cancelAccount', (req, res) => okMsg(res, '已释放离线账号'))
  app.post('/apis/order/resetOrder', (req, res) => okMsg(res, '工单已重置'))
  app.post('/apis/order/cancelShare', (req, res) => okMsg(res, '已取消分享'))
  app.post('/apis/order/updateSharePwd', (req, res) => okMsg(res, '分享密码已更新'))
  app.post('/apis/order/editSharePwd', (req, res) => res.json({ success: 'success', msg: '修改成功' }))
  app.get('/apis/order/getAssistantGroupByUserId', (req, res) => {
    const user = currentMerchant(req)
    res.json(db.assistantGroups.filter(group => group.userId === user.id))
  })
  app.post('/apis/order/getServerTime', (req, res) => res.json({ data: Date.now() }))
  app.post('/apis/order/selectOrderBySerialNumber', (req, res) => {
    const serial = q(req).serialNumber
    const item = db.orders.find(o => o.serialNumber === serial)
    if (!item) { res.status(404).json({ success: false, msg: '工单不存在' }); return }
    res.json({
      data: {
        serialNumber: item.serialNumber,
        title: item.title,
        zeroTime: item.zeroTime,
        passwordExpirationTime: item.passwordExpirationTime,
        status: item.status
      }
    })
  })
  app.post('/apis/order/checkSharePwd', (req, res) => {
    const query = q(req)
    const item = db.orders.find(o => o.serialNumber === query.serialNumber)
    if (!item || !item.sharePassword || !security.verifyPassword({ password: item.sharePassword }, query.sharePassword)) {
      res.status(403).json({ code: 403, msg: '分享密码错误' })
      return
    }
    if (new Date(item.passwordExpirationTime).getTime() <= Date.now()) {
      res.status(410).json({ code: 410, msg: '工单分享已过期' })
      return
    }
    res.json({ code: 200, msg: item.zeroTime, data: item.passwordExpirationTime, token: issueShareGrant(item) })
  })

  app.post('/apis/orderDetails/getOrderDetails', (req, res) => {
    const query = q(req)
    let list = ownedOrderRows(req, db.details)
    if (query.orderNum) list = list.filter(d => d.orderNum === query.orderNum)
    res.json(page(list, query))
  })
  app.post('/apis/orderDetails/shareOrder', (req, res) => {
    const query = q(req)
    if (!validShareGrant(query.shareToken, query.orderNum)) {
      res.status(403).json({ success: false, msg: '分享凭证无效或已过期' })
      return
    }
    const item = db.orders.find(order => order.serialNumber === query.orderNum)
    let list = db.details.filter(d => d.orderNum === query.orderNum)
    const result = page(list, query)
    result.object = item || {}
    res.json(result)
  })
  const orderFansHandler = (req, res) => {
    const query = q(req)
    let list
    if (currentSession(req)) {
      list = ownedOrderRows(req, db.fans)
    } else if (validShareGrant(query.shareToken, query.orderNum)) {
      list = db.fans.filter(row => row.orderNum === query.orderNum)
    } else {
      res.status(403).json({ success: false, msg: '分享凭证无效或已过期' })
      return
    }
    res.json(page(list, query))
  }
  app.post('/apis/orderDetails/getOrderFans', orderFansHandler)
  app.get('/apis/orderDetails/getOrderFans', orderFansHandler)
  app.post('/apis/orderDetails/getTodayFansCount', (req, res) => {
    const query = q(req)
    if (!currentSession(req) && !validShareGrant(query.shareToken, query.serialNumber)) {
      res.status(403).json({ success: false, msg: '分享凭证无效或已过期' })
      return
    }
    res.json({ data: { todayFansCount: 3, todayRepFansCount: 1, totalFansCount: 12 } })
  })
  app.post('/apis/orderDetails/updateRemarks', (req, res) => okMsg(res, '备注已更新'))
  app.post('/apis/orderDetails/deleteOrderDetails', (req, res) => okMsg(res, '已删除'))
  app.post('/apis/orderDetails/unbindPort', (req, res) => okMsg(res, '端口已释放'))
  app.post('/apis/orderDetails/setDistribution', (req, res) => okMsg(res, '分配状态已更新'))
  app.post('/apis/orderDetails/resetOrderDetails', (req, res) => okMsg(res, '明细已重置'))
  app.post('/apis/orderTarget/getOrderTarget', (req, res) => res.json(page(ownedOrderRows(req, db.targets), q(req))))
  app.get('/apis/userLogin/getUserLogin', (req, res) => {
    const user = currentMerchant(req)
    res.json(page(db.logins.filter(row => row.username === user.username), q(req)))
  })

  app.post('/apis/shortLink/getShortLink', (req, res) => res.json(page(ownedOrderRows(req, db.shortLinks), q(req))))
  app.post('/apis/shortLink/getShortLinkInfo', (req, res) => {
    const item = ownedOrderRows(req, db.shortLinks).find(s => String(s.id) === String(q(req).id))
    res.json({ accounts: item ? item.accounts : '' })
  })
  app.post('/apis/shortLink/editShortLink', (req, res) => okMsg(res, '短链已更新'))
  app.post('/apis/shortLink/deleteShortLink', (req, res) => okMsg(res, '短链已删除'))
  app.post('/apis/shortLink/addShortLink', (req, res) => {
    const query = q(req)
    if (!ownsOrder(req, query.orderNum)) { res.status(403).json({ success: false, msg: '无权访问该工单' }); return }
    db.shortLinks.unshift({
      id: nextLinkId++,
      platform: query.platform || 'is.gd',
      shareLink: 'http://localhost:8080/#/empty',
      type: Number(query.type || 1),
      pattern: Number(query.pattern || 1),
      message: query.message || '',
      hits: 0,
      orderNum: query.orderNum,
      accounts: query.accounts || ''
    })
    okMsg(res, '已生成分流链接')
  })

  app.get('/apis/assistant/getAssistantGroup', (req, res) => {
    const user = currentMerchant(req)
    res.json(db.assistantGroups.filter(group => group.userId === user.id))
  })
  app.post('/apis/assistant/getAssistantDetails', (req, res) => {
    const query = q(req)
    const user = currentMerchant(req)
    const groups = new Set(db.assistantGroups.filter(group => group.userId === user.id).map(group => String(group.id)))
    let list = db.assistantDetails.filter(d => groups.has(String(d.groupid)))
    if (query.groupid) list = list.filter(d => String(d.groupid) === String(query.groupid))
    if (query.keyword) list = list.filter(d => d.keyword.indexOf(query.keyword) !== -1)
    res.json(page(list, query))
  })
  app.post('/apis/assistant/deleteAssistantDetails', (req, res) => {
    const ids = String(q(req).ids || '').split(',')
    const user = currentMerchant(req)
    const groups = new Set(db.assistantGroups.filter(group => group.userId === user.id).map(group => String(group.id)))
    db.assistantDetails = db.assistantDetails.filter(d => ids.indexOf(String(d.id)) === -1 || !groups.has(String(d.groupid)))
    okMsg(res, '已删除')
  })
  app.post('/apis/assistant/deleteAssistantGroup', (req, res) => {
    const id = String(q(req).id)
    const user = currentMerchant(req)
    const group = db.assistantGroups.find(g => String(g.id) === id && g.userId === user.id)
    if (!group) { res.status(404).json({ success: false, msg: '分组不存在' }); return }
    db.assistantGroups = db.assistantGroups.filter(g => String(g.id) !== id)
    db.assistantDetails = db.assistantDetails.filter(d => String(d.groupid) !== id)
    okMsg(res, '分组已删除')
  })
  app.get('/apis/assistant/selectAssistantGroupById', (req, res) => {
    const user = currentMerchant(req)
    res.json(db.assistantGroups.find(g => String(g.id) === String(q(req).id) && g.userId === user.id) || {})
  })
  app.post('/apis/assistant/editAssistant', (req, res) => {
    const query = q(req)
    const op = req.query && req.query.assistantOperates
    const user = currentMerchant(req)
    const group = db.assistantGroups.find(g => String(g.id) === String(query.groupid) && g.userId === user.id)
    if (!group) { res.status(403).json({ success: false, msg: '无权访问该分组' }); return }
    if (op === 'add' || !query.id) {
      db.assistantDetails.unshift({
        id: nextDetailId++,
        groupid: group.id,
        keyword: query.keyword || '',
        source: query.source || '',
        target: query.target || ''
      })
    }
    okMsg(res, '保存成功')
  })
  app.post('/apis/assistant/editAssistantGroup', (req, res) => {
    const query = q(req)
    const op = req.query && req.query.assistantGroupOperates
    const user = currentMerchant(req)
    if (op === 'add' || !query.id) {
      db.assistantGroups.push({ id: nextGroupId++, userId: user.id, title: query.title || '新分组' })
    } else {
      const item = db.assistantGroups.find(g => String(g.id) === String(query.id) && g.userId === user.id)
      if (item) item.title = query.title
    }
    okMsg(res, '保存成功')
  })

  app.get('/apis/team/info', (req, res) => {
    const session = currentSession(req)
    const parent = session.parent
    const subs = db.subAccounts.filter(s => s.parentId === parent.id)
    res.json({
      role: session.kind,
      enterprise: parent.enterprise ? 1 : 0,
      enterpriseMinPacks: Number(db.settings.enterpriseMinPacks || 2),
      username: session.account.username,
      parentUsername: parent.username,
      email: session.account.email || parent.email || '',
      charBalance: session.account.charBalance || 0,
      parentCharBalance: parent.charBalance || 0,
      subCount: subs.length,
      subQuota: Number(parent.subQuota || 0),
      autoAllocMaster: parent.autoAllocMaster ? 1 : 0,
      imUnlimited: 1,
      bound: session.account.boundDevice ? 1 : 0
    })
  })
  app.get('/apis/team/subs', (req, res) => {
    const session = requireMain(req, res)
    if (!session) return
    const query = q(req)
    let list = db.subAccounts.filter(s => s.parentId === session.parent.id)
    if (query.keyword) {
      list = list.filter(s => String(s.username).includes(query.keyword) || String(s.email || '').includes(query.keyword) || String(s.nickname || '').includes(query.keyword))
    }
    res.json(page(list.map(publicSub), query))
  })
  app.post('/apis/team/subs/save', (req, res) => {
    const session = requireMain(req, res)
    if (!session) return
    const query = q(req)
    if (query.id) {
      const sub = db.subAccounts.find(s => String(s.id) === String(query.id) && s.parentId === session.parent.id)
      if (!sub) { res.json({ success: 'error', msg: '子账号不存在' }); return }
      if (query.nickname !== undefined) sub.nickname = query.nickname
      if (query.email !== undefined) sub.email = query.email
      if (query.password) {
        if (!validPassword(query.password)) { res.json({ success: 'error', msg: '密码至少需要 6 位' }); return }
        sub.password = security.hashPassword(query.password)
        security.revokeSubject('user', sub.id)
      }
      if (query.status !== undefined) {
        sub.status = Number(query.status)
        if (sub.status !== 1) security.revokeSubject('user', sub.id)
      }
      if (query.autoAlloc !== undefined) sub.autoAlloc = Number(query.autoAlloc) ? 1 : 0
      okMsg(res, '子账号已更新')
      return
    }
    const quota = Number(session.parent.subQuota || 0)
    const used = db.subAccounts.filter(s => s.parentId === session.parent.id).length
    if (used >= quota) {
      res.json({ success: 'error', msg: '子账号名额已满。购买字符可成为企业用户并增加子账户名额' })
      return
    }
    if (!query.username) { res.json({ success: 'error', msg: '请填写登录账号' }); return }
    if (db.users.find(u => u.username === query.username) || db.subAccounts.find(s => s.username === query.username)) {
      res.json({ success: 'error', msg: '用户名已被占用' })
      return
    }
    if (!validPassword(query.password)) { res.json({ success: 'error', msg: '密码至少需要 6 位' }); return }
    db.subAccounts.push({
      id: nextSubId++,
      parentId: session.parent.id,
      username: query.username,
      password: security.hashPassword(query.password),
      nickname: query.nickname || query.username,
      email: query.email || '',
      charBalance: 0,
      charUsed: 0,
      autoAlloc: 0,
      status: 1,
      boundDevice: '',
      activeEngine: 'deepseek',
      createTime: now()
    })
    okMsg(res, '子账号已创建。该账号可登录无限个 Telegram / WhatsApp 等聊天号')
  })
  app.post('/apis/team/subs/batch', (req, res) => {
    const session = requireMain(req, res)
    if (!session) return
    const query = q(req)
    const ids = String(query.ids || '').split(',').map(s => s.trim()).filter(Boolean)
    const status = Number(query.status)
    ids.forEach(id => {
      const sub = db.subAccounts.find(s => String(s.id) === String(id) && s.parentId === session.parent.id)
      if (sub) {
        sub.status = status
        if (status !== 1) security.revokeSubject('user', sub.id)
      }
    })
    okMsg(res, status === 1 ? '已开启所选' : '已关闭所选')
  })
  app.post('/apis/team/autoAlloc', (req, res) => {
    const session = requireMain(req, res)
    if (!session) return
    const query = q(req)
    if (query.id) {
      const sub = db.subAccounts.find(s => String(s.id) === String(query.id) && s.parentId === session.parent.id)
      if (!sub) { res.json({ success: 'error', msg: '子账号不存在' }); return }
      sub.autoAlloc = Number(query.autoAlloc) ? 1 : 0
      okMsg(res, '已更新自动分配')
      return
    }
    session.parent.autoAllocMaster = Number(query.autoAlloc) ? 1 : 0
    okMsg(res, session.parent.autoAllocMaster ? '已开启自动分配总开关' : '已关闭自动分配总开关')
  })
  app.post('/apis/team/password', (req, res) => {
    const session = currentSession(req)
    const query = q(req)
    if (!query.oldPassword || !security.verifyPassword(session.account, query.oldPassword)) {
      res.json({ success: 'error', msg: '原密码不正确' })
      return
    }
    if (!validPassword(query.newPassword)) {
      res.json({ success: 'error', msg: '新密码至少需要 6 位' })
      return
    }
    session.account.password = security.hashPassword(query.newPassword)
    security.revokeSubject('user', session.account.id)
    okMsg(res, '密码已修改')
  })
  app.post('/apis/team/subs/chars', (req, res) => {
    const session = requireMain(req, res)
    if (!session) return
    const query = q(req)
    const sub = db.subAccounts.find(s => String(s.id) === String(query.id) && s.parentId === session.parent.id)
    if (!sub) { res.json({ success: 'error', msg: '子账号不存在' }); return }
    const chars = Number(query.chars || 0)
    if (!chars) { res.json({ success: 'error', msg: '请填写分配字符数' }); return }
    const parent = session.parent
    if (chars > 0) {
      if (Number(parent.charBalance || 0) < chars) {
        res.json({ success: 'error', msg: '主账户字符不足' })
        return
      }
      parent.charBalance = Number(parent.charBalance) - chars
      sub.charBalance = Number(sub.charBalance || 0) + chars
      okMsg(res, '已分配 ' + chars + ' 字符给 ' + sub.username)
      return
    }
    const take = Math.abs(chars)
    if (Number(sub.charBalance || 0) < take) {
      res.json({ success: 'error', msg: '子账号字符不足，无法收回' })
      return
    }
    sub.charBalance -= take
    parent.charBalance = Number(parent.charBalance || 0) + take
    okMsg(res, '已从 ' + sub.username + ' 收回 ' + take + ' 字符')
  })
  app.post('/apis/team/subs/status', (req, res) => {
    const session = requireMain(req, res)
    if (!session) return
    const query = q(req)
    const sub = db.subAccounts.find(s => String(s.id) === String(query.id) && s.parentId === session.parent.id)
    if (!sub) { res.json({ success: 'error', msg: '子账号不存在' }); return }
    sub.status = Number(query.status)
    if (sub.status !== 1) security.revokeSubject('user', sub.id)
    okMsg(res, Number(query.status) === 1 ? '已启用' : '已停用')
  })
  app.post('/apis/team/device/reset', (req, res) => {
    const session = currentSession(req)
    const query = q(req)
    if (session.kind === 'sub') {
      session.account.boundDevice = 'kick-' + Date.now()
      security.revokeSubject('user', session.account.id)
      okMsg(res, '已强制下线本机客户端')
      return
    }
    if (query.id && String(query.id) !== String(session.parent.id)) {
      const sub = db.subAccounts.find(s => String(s.id) === String(query.id) && s.parentId === session.parent.id)
      if (!sub) { res.json({ success: 'error', msg: '子账号不存在' }); return }
      sub.boundDevice = 'kick-' + Date.now()
      security.revokeSubject('user', sub.id)
      okMsg(res, '已将 ' + sub.username + ' 的客户端踢下线')
      return
    }
    session.parent.boundDevice = 'kick-' + Date.now()
    security.revokeSubject('user', session.parent.id)
    okMsg(res, '已将主账户客户端踢下线')
  })

  app.get('/apis/weixin/weixinPay', (req, res) => {
    if (!demoPaymentEnabled) { res.status(503).json({ success: false, msg: '支付验签尚未配置，暂不可用' }); return }
    const query = q(req)
    const session = currentSession(req)
    if (query.out_trade_no) {
      pendingPays[query.out_trade_no] = {
        userId: session.parent.id,
        versionId: query.baseid,
        packs: Number(query.month || 1),
        type: query.type || '微信'
      }
    }
    const file = path.join(__dirname, '../src/assets/defaultQrcode.jpg')
    res.type('png')
    fs.createReadStream(file).pipe(res)
  })
  app.post('/apis/weixin/checkStatus', (req, res) => {
    if (!demoPaymentEnabled) { res.status(503).json({ success: false, msg: '支付验签尚未配置，暂不可用' }); return }
    const query = q(req)
    const session = currentSession(req)
    const pending = pendingPays[query.out_trade_no]
    if (pending && pending.userId === session.parent.id) {
      const user = db.users.find(u => u.id === pending.userId)
      if (user) applyCharPurchase(user, pending.packs, pending.versionId, pending.type, query.out_trade_no)
      delete pendingPays[query.out_trade_no]
    }
    res.json(1)
  })
  app.get('/apis/zfb/alipay', (req, res) => {
    if (!demoPaymentEnabled) { res.status(503).json({ success: false, msg: '支付验签尚未配置，暂不可用' }); return }
    const query = q(req)
    const session = currentSession(req)
    applyCharPurchase(session.parent, Number(query.month || 1), query.baseid, query.type || '支付宝', query.out_trade_no)
    res.redirect('/#/paySuccess')
  })

  const exportHandler = (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="export.csv"')
    res.send('\ufeffHello Pix 本地导出\n')
  }
  app.get('/apis/export/orderFansExport', exportHandler)
  app.get('/apis/export/orderDetailExport', exportHandler)
  app.get('/apis/export2/orderDetailLogExport', exportHandler)
  app.get('/apis/export2/orderExport', exportHandler)
  app.get('/apis/orderDetails/jump', (req, res) => res.redirect('/#/empty'))

  app.get('/apis/site/info', (req, res) => {
    const downloadByGroup = (group) => {
      const row = (db.clients || []).find(item => (
        Number(item.enabled) !== 0 &&
        String(item.group || '').toLowerCase() === String(group).toLowerCase() &&
        String(item.url || '').trim()
      ))
      return row ? String(row.url).trim() : ''
    }
    res.json({
      siteName: db.settings.siteName,
      announcement: currentAnnouncement(),
      clientDownloadUrl: db.settings.clientDownloadUrl,
      clientDownloads: {
        app: db.settings.clientDownloadUrl || '',
        windows: downloadByGroup('Windows'),
        macos: downloadByGroup('macOS'),
        android: downloadByGroup('Android'),
        ios: downloadByGroup('iOS'),
        standalone: downloadByGroup('独立应用')
      },
      officialUrl: db.settings.officialUrl || '',
      guideUrl: db.settings.guideUrl || '',
      telegram: db.settings.telegram,
      telegramUrl: supportUrlOf(),
      supportBtnText: db.settings.supportBtnText || '联系客服',
      supportShow: Number(db.settings.supportShow) !== 0 ? 1 : 0,
      supportNote: db.settings.supportNote,
      discount1: Number(db.settings.discount1 || 0.9),
      discount10: Number(db.settings.discount10 || 0.8),
      discount50: Number(db.settings.discount50 || 0.75),
      packageBill: packageBillText(),
      imUnlimited: 1,
      lines: publicLines()
    })
  })
  app.get('/apis/client/lines', (req, res) => {
    res.json({ success: true, rows: publicLines() })
  })

  app.post('/apis/admin/login', (req, res) => {
    const { username, password } = q(req)
    const admin = db.admins.find(u => u.username === username && security.verifyPassword(u, password))
    if (!admin) {
      res.json({ success: false, msg: '超管账号或密码错误' })
      return
    }
    security.destroySession(req, res, 'admin')
    security.createSession(res, 'admin', admin.id, { remember: false })
    audit(req, '登录超管后台', admin.username)
    res.json({ success: true, msg: '登录成功', obj: { username: admin.username, nickname: admin.nickname, role: admin.role || 'superadmin' } })
  })
  app.post('/apis/admin/logout', (req, res) => {
    security.destroySession(req, res, 'admin')
    okMsg(res, '已退出')
  })
  app.get('/apis/admin/stats', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const paid = db.recharges.filter(r => r.status === 1)
    const charUsed = db.translateLogs.reduce((s, t) => s + Number(t.chars || 0), 0)
    const translateCost = db.translateLogs.reduce((s, t) => s + Number(t.cost || 0), 0)
    const translateSell = db.translateLogs.reduce((s, t) => s + Number(t.sell || 0), 0)
    const activeEngine = engineOf()
    res.json({
      userCount: db.users.length,
      activeUsers: db.users.filter(u => u.status === 1).length,
      // 工单已下线（见路由注释）：orderCount / openOrders 一并移除，
      // 与真后端 /admin/stats 保持一致。
      // 待支付订单：仍在有效期内的未支付单 —— 与真后端的 recharge_pending 同口径
      rechargePending: db.recharges.filter(r => r.status === 0).length,
      rechargePendingStale: 0,
      portTotal: db.users.reduce((s, u) => s + Number(u.port || 0), 0),
      portUsed: db.users.reduce((s, u) => s + Number(u.userPorts || 0), 0),
      onlineAccounts: db.details.filter(d => Number(d.onlineStatus) === 1).length,
      accountTotal: db.details.length,
      fanCount: db.fans.length,
      shortLinkHits: db.shortLinks.reduce((s, l) => s + Number(l.hits || 0), 0),
      scriptCount: db.assistantDetails.length,
      rechargeCount: paid.length,
      rechargeSum: paid.reduce((s, r) => s + Number(r.price || 0), 0),
      charBalance: db.users.reduce((s, u) => s + Number(u.charBalance || 0), 0),
      charUsed: charUsed,
      translateCost: Math.round(translateCost * 10000) / 10000,
      translateSell: Math.round(translateSell * 10000) / 10000,
      enterpriseUsers: db.users.filter(u => u.enterprise).length,
      subCount: db.subAccounts.length,
      // 毛利估算：与真后端同口径（累计实收 − 累计通道成本）
      grossProfit: Math.round((paid.reduce((s, r) => s + Number(r.price || 0), 0) - translateCost) * 100) / 100,
      packageBill: packageBillText(),
      activeEngine: activeEngine.name,
      engineCostPerMillion: activeEngine.costPerMillion,
      announcement: currentAnnouncement(),
      recentAudits: db.audits.slice(0, 6),
      recentTranslates: db.translateLogs.slice(0, 6),
      recentFans: db.fans.slice(0, 6)
    })
  })
  app.get('/apis/admin/users', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    let list = db.users.map(enrichUser)
    if (query.keyword) {
      list = list.filter(u => u.username.indexOf(query.keyword) !== -1 || (u.nickname || '').indexOf(query.keyword) !== -1)
    }
    res.json(page(list, query))
  })
  app.post('/apis/admin/users/save', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    const pack = db.versions.find(v => String(v.id) === String(query.versionId)) || db.versions[0]
    if (query.id) {
      const user = db.users.find(u => String(u.id) === String(query.id))
      if (!user) { res.json({ success: 'error', msg: '用户不存在' }); return }
      user.nickname = query.nickname || user.nickname
      user.status = query.status === undefined ? user.status : Number(query.status)
      user.versionId = Number(query.versionId || user.versionId)
      user.basename = pack.title
      user.port = Number(query.port || pack.port)
      // 「无限期」= 到期时间为 null。与生产端 /admin/users/save 的三态一致：
      // 勾了无限期就清空；没勾且给了日期就更新；都没给则保持原值。
      if (isUnlimited(query.expireUnlimited)) {
        user.expireTime = null
      } else if (query.expireTime) {
        user.expireTime = query.expireTime
      }
      if (query.password) {
        if (!validPassword(query.password)) { res.json({ success: 'error', msg: '密码至少需要 6 位' }); return }
        user.password = security.hashPassword(query.password)
        security.revokeSubject('user', user.id)
      }
      if (user.status !== 1) security.revokeSubject('user', user.id)
      if (query.phone !== undefined) user.phone = query.phone
      if (query.remarks !== undefined) user.remarks = query.remarks
      if (query.autoReply !== undefined) user.autoReply = Number(query.autoReply)
      if (query.charBalance !== undefined && query.charBalance !== '') user.charBalance = Number(query.charBalance)
      if (query.enterprise !== undefined && query.enterprise !== '') user.enterprise = Number(query.enterprise) ? 1 : 0
      audit(req, '编辑商户', user.username)
      okMsg(res, '用户已更新')
      return
    }
    if (db.users.find(u => u.username === query.username)) {
      res.json({ success: 'error', msg: '用户名已存在' })
      return
    }
    const trial = Number(db.settings.trialChars || 0)
    const gift = query.charBalance !== undefined && query.charBalance !== ''
      ? Number(query.charBalance)
      : trial
    if (!validPassword(query.password)) { res.json({ success: 'error', msg: '密码至少需要 6 位' }); return }
    const created = {
      id: nextUserId++,
      username: query.username,
      password: security.hashPassword(query.password),
      nickname: query.nickname || query.username,
      status: 1,
      basename: pack.title,
      versionId: pack.id,
      port: Number(query.port || pack.port),
      userPorts: 0,
      expireTime: isUnlimited(query.expireUnlimited) ? null : (query.expireTime || later(30)),
      createTime: now(),
      charBalance: gift,
      autoReply: Number(query.autoReply || 0),
      phone: query.phone || '',
      remarks: query.remarks || '',
      activeEngine: 'deepseek',
      enterprise: Number(query.enterprise || 0) ? 1 : 0,
      boundDevice: '',
      email: query.email || '',
      subQuota: Number(query.subQuota || 0),
      autoAllocMaster: 0,
      translateCount: 0,
      charUsed: 0
    }
    db.users.push(created)
    if (gift > 0) {
      db.recharges.unshift({
        id: nextRechargeId++,
        userId: created.id,
        username: created.username,
        orderNum: 'TRIAL' + Date.now(),
        price: 0,
        basename: '新商户试用 ' + gift + ' 字符',
        month: 0,
        status: 1,
        type: '试用赠送',
        createTime: now(),
        kind: '试用',
        chars: gift
      })
    }
    audit(req, '新建商户', query.username + ' 试用字符 ' + gift)
    okMsg(res, gift ? ('用户已创建，已赠送试用 ' + gift + ' 字符') : '用户已创建')
  })
  app.post('/apis/admin/users/status', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    const user = db.users.find(u => String(u.id) === String(query.id))
    if (user) {
      user.status = Number(query.status)
      if (user.status !== 1) security.revokeSubject('user', user.id)
      audit(req, Number(query.status) === 1 ? '启用商户' : '停用商户', user.username)
    }
    okMsg(res, Number(query.status) === 1 ? '已启用' : '已停用')
  })
  // 与 server/routes/production.js 的 /admin/users/resetPassword 对齐：
  // 只改密码、不碰其它字段。规则 6-128 位（见 server/lib/password.js）
  app.post('/apis/admin/users/resetPassword', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    const user = db.users.find(u => String(u.id) === String(query.id || query.userId))
    if (!user) { res.json({ success: 'error', msg: '商户不存在' }); return }
    if (!validPassword(query.password)) { res.json({ success: 'error', msg: '密码至少需要 6 位' }); return }
    user.password = security.hashPassword(query.password)
    security.revokeSubject('user', user.id)
    audit(req, '重置商户密码', user.username)
    okMsg(res, '密码已重置')
  })
  app.post('/apis/admin/users/enterprise', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    const user = db.users.find(u => String(u.id) === String(query.id))
    if (!user) { res.json({ success: 'error', msg: '商户不存在' }); return }
    user.enterprise = Number(query.enterprise) ? 1 : 0
    audit(req, user.enterprise ? '升级企业账号' : '降为个人账号', user.username)
    okMsg(res, user.enterprise ? '已升级为企业账号，可无限开子账号' : '已降为个人账号')
  })
  app.post('/apis/admin/users/unbind', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    if (query.subId) {
      const sub = db.subAccounts.find(s => String(s.id) === String(query.subId))
      if (!sub) { res.json({ success: 'error', msg: '子账号不存在' }); return }
      sub.boundDevice = 'kick-' + Date.now()
      security.revokeSubject('user', sub.id)
      audit(req, '踢下线子账号', sub.username)
      okMsg(res, '已将 ' + sub.username + ' 踢下线')
      return
    }
    const user = db.users.find(u => String(u.id) === String(query.id))
    if (!user) { res.json({ success: 'error', msg: '商户不存在' }); return }
    user.boundDevice = 'kick-' + Date.now()
    security.revokeSubject('user', user.id)
    audit(req, '踢下线商户', user.username)
    okMsg(res, '已将 ' + user.username + ' 踢下线')
  })
  app.get('/apis/admin/subs', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    let list = db.subAccounts.map(s => {
      const parent = db.users.find(u => u.id === s.parentId)
      return Object.assign(publicSub(s), { parentUsername: parent ? parent.username : '' })
    })
    if (query.userId) list = list.filter(s => String(s.parentId) === String(query.userId))
    if (query.keyword) {
      list = list.filter(s => String(s.username).includes(query.keyword) || String(s.parentUsername).includes(query.keyword))
    }
    res.json(page(list, query.rows ? query : Object.assign({}, query, { page: 1, rows: 50 })))
  })
  // 工单（orders）相关接口于 2026-10-11 移除：与真后端一致 ——
  // 没有任何创建入口，保留 @/admin/orders 只会让 mock 与生产的路由表不一致。
  app.get('/apis/admin/packages', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    res.json(db.versions)
  })
  app.post('/apis/admin/packages/save', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    const pack = db.versions.find(v => String(v.id) === String(query.id))
    if (pack) {
      pack.title = query.title || pack.title
      pack.port = Number(query.port || pack.port)
      pack.price = Number(query.price || pack.price)
      if (query.chars !== undefined && query.chars !== '') pack.chars = Number(query.chars)
      if (query.subtitle !== undefined) pack.subtitle = query.subtitle
      if (query.engines) {
        try {
          pack.engines = typeof query.engines === 'string' ? JSON.parse(query.engines) : query.engines
        } catch (e) {}
      }
      if (query.clients) {
        try {
          pack.clients = typeof query.clients === 'string' ? JSON.parse(query.clients) : query.clients
        } catch (e) {}
      }
      if (query.features) {
        try {
          pack.features = typeof query.features === 'string' ? JSON.parse(query.features) : query.features
        } catch (e) {}
      }
      if (query.highlights) {
        try {
          pack.highlights = typeof query.highlights === 'string' ? JSON.parse(query.highlights) : query.highlights
        } catch (e) {}
      }
    }
    audit(req, '保存套餐', pack ? pack.title : '')
    okMsg(res, '套餐已保存')
  })
  app.get('/apis/admin/recharges', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    res.json(page(db.recharges, q(req)))
  })
  app.post('/apis/admin/recharges/status', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    const item = db.recharges.find(r => String(r.id) === String(query.id))
    if (item) {
      item.status = Number(query.status)
      audit(req, '标记充值', item.username + ' ¥' + item.price)
    }
    okMsg(res, '充值状态已更新')
  })

  app.get('/apis/admin/accounts', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    let list = db.details.map(d => {
      const order = db.orders.find(o => o.serialNumber === d.orderNum)
      const user = order ? db.users.find(u => u.id === order.userId) : null
      return Object.assign({}, d, {
        username: user ? user.username : '',
        merchant: user ? user.nickname : '',
        orderTitle: order ? order.title : ''
      })
    })
    if (query.keyword) {
      list = list.filter(d =>
        String(d.account).includes(query.keyword) ||
        String(d.nickName).includes(query.keyword) ||
        String(d.username).includes(query.keyword) ||
        String(d.orderNum).includes(query.keyword)
      )
    }
    if (query.online === '1') list = list.filter(d => Number(d.onlineStatus) === 1)
    if (query.online === '0') list = list.filter(d => Number(d.onlineStatus) !== 1)
    res.json(page(list, query))
  })

  app.get('/apis/admin/fans', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    let list = db.fans.map(f => {
      const order = db.orders.find(o => o.serialNumber === f.orderNum)
      const user = order ? db.users.find(u => u.id === order.userId) : null
      return Object.assign({}, f, {
        username: user ? user.username : '',
        merchant: user ? user.nickname : '',
        orderTitle: order ? order.title : ''
      })
    })
    if (query.keyword) {
      list = list.filter(f =>
        String(f.account).includes(query.keyword) ||
        String(f.nickName).includes(query.keyword) ||
        String(f.username).includes(query.keyword) ||
        String(f.orderNum).includes(query.keyword)
      )
    }
    if (query.type) list = list.filter(f => f.type === query.type)
    res.json(page(list, query))
  })

  app.get('/apis/admin/links', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    let list = db.shortLinks.map(l => {
      const order = db.orders.find(o => o.serialNumber === l.orderNum)
      const user = order ? db.users.find(u => u.id === order.userId) : null
      return Object.assign({}, l, {
        username: user ? user.username : '',
        merchant: user ? user.nickname : ''
      })
    })
    if (query.keyword) {
      list = list.filter(l => String(l.shareLink).includes(query.keyword) || String(l.orderNum).includes(query.keyword) || String(l.username).includes(query.keyword))
    }
    res.json(page(list, query))
  })

  app.get('/apis/admin/scripts', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    let list = db.assistantDetails.map(d => {
      const group = db.assistantGroups.find(g => g.id === d.groupid)
      const user = group ? db.users.find(u => u.id === group.userId) : null
      return Object.assign({}, d, {
        groupTitle: group ? group.title : '',
        username: user ? user.username : '',
        merchant: user ? user.nickname : ''
      })
    })
    if (query.keyword) {
      list = list.filter(d => String(d.keyword).includes(query.keyword) || String(d.source).includes(query.keyword) || String(d.target).includes(query.keyword))
    }
    res.json(page(list, query))
  })

  app.get('/apis/admin/translate/logs', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    let list = db.translateLogs.slice()
    if (query.keyword) {
      list = list.filter(t => String(t.username).includes(query.keyword) || String(t.snippet).includes(query.keyword) || String(t.engine).includes(query.keyword))
    }
    res.json(page(list, query))
  })

  app.post('/apis/admin/translate/grant', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    const user = db.users.find(u => String(u.id) === String(query.userId) || u.username === query.username)
    if (!user) { res.json({ success: 'error', msg: '商户不存在' }); return }
    const chars = Number(query.chars || 0)
    if (!chars) { res.json({ success: 'error', msg: '请填写字符数' }); return }
    user.charBalance = Number(user.charBalance || 0) + chars
    db.recharges.unshift({
      id: nextRechargeId++,
      userId: user.id,
      username: user.username,
      orderNum: 'CHAR' + Date.now(),
      price: Number(query.price || 0),
      basename: '字符包 ' + chars,
      month: 0,
      status: 1,
      type: query.type || '后台赠送',
      createTime: now(),
      kind: '字符',
      chars: chars
    })
    audit(req, '赠送字符', user.username + ' +' + chars)
    okMsg(res, '已为 ' + user.username + ' 增加 ' + chars + ' 字符')
  })

  app.get('/apis/admin/verify', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    res.json({
      wired: false,
      msg: '验证码接口板块已就位，邮件发送尚未接入',
      rows: verifyCode.publicRows(db.verify)
    })
  })

  app.post('/apis/admin/verify/save', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    const channel = db.verify[query.id]
    if (!channel) { res.json({ success: 'error', msg: '通道不存在' }); return }
    verifyCode.applySave(channel, query)
    if (channel === db.verify.email && !testMode) channel.revealDemo = 0
    audit(req, '保存验证码接口', channel.name)
    okMsg(res, channel.name + ' 已保存')
  })

  app.get('/apis/admin/engines', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    res.json({
      activeEngine: db.settings.activeEngine,
      packageBill: packageBillText(),
      rows: db.engines.map(e => {
        const copy = Object.assign({}, e)
        copy.active = e.id === db.settings.activeEngine
        copy.wiredText = e.wired ? '已接入' : '待接入'
        copy.hasKey = !!(e.apiKey)
        copy.hasSecret = !!(e.secret)
        if (copy.apiKey) copy.apiKey = '********'
        if (copy.secret) copy.secret = '********'
        return copy
      })
    })
  })

  app.post('/apis/admin/engines/save', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    const eng = db.engines.find(e => e.id === query.id)
    if (!eng) { res.json({ success: 'error', msg: '通道不存在' }); return }
    if (query.enabled !== undefined) eng.enabled = Number(query.enabled)
    if (query.costPerMillion !== undefined && query.costPerMillion !== '') eng.costPerMillion = Number(query.costPerMillion)
    if (query.model !== undefined) eng.model = query.model
    if (query.note !== undefined) eng.note = query.note
    if (query.endpoint !== undefined) eng.endpoint = query.endpoint
    if (query.secret && String(query.secret).indexOf('****') === -1) eng.secret = query.secret
    if (query.apiKey && query.apiKey.indexOf('****') === -1) eng.apiKey = query.apiKey
    audit(req, '保存翻译通道', eng.name)
    okMsg(res, '通道已保存')
  })

  app.post('/apis/admin/engines/active', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    const eng = db.engines.find(e => e.id === query.id)
    if (!eng) { res.json({ success: 'error', msg: '通道不存在' }); return }
    db.settings.activeEngine = eng.id
    audit(req, '切换翻译通道', eng.name)
    okMsg(res, '已切换为 ' + eng.name)
  })

  app.get('/apis/admin/logs', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    const kind = query.kind || 'login'
    if (kind === 'audit') {
      let list = db.audits.slice()
      if (query.keyword) list = list.filter(a => String(a.action).includes(query.keyword) || String(a.admin).includes(query.keyword) || String(a.detail).includes(query.keyword))
      res.json(page(list, query))
      return
    }
    let list = db.logins.slice()
    if (query.keyword) list = list.filter(a => String(a.account).includes(query.keyword) || String(a.username).includes(query.keyword) || String(a.loginType).includes(query.keyword))
    res.json(page(list, query))
  })

  app.get('/apis/admin/settings', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    res.json(Object.assign({}, db.settings, { notices: db.notices }))
  })

  app.post('/apis/admin/settings/save', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    ;['siteName', 'announcement', 'clientDownloadUrl', 'officialUrl', 'guideUrl', 'activeEngine', 'telegram', 'telegramUrl', 'supportNote', 'supportBtnText'].forEach(key => {
      if (query[key] !== undefined) db.settings[key] = query[key]
    })
    if (query.trialChars !== undefined && query.trialChars !== '') db.settings.trialChars = Number(query.trialChars)
    ;['discount1', 'discount10', 'discount50'].forEach(key => {
      if (query[key] !== undefined && query[key] !== '') db.settings[key] = Number(query[key])
    })
    if (query.supportShow !== undefined && query.supportShow !== '') db.settings.supportShow = Number(query.supportShow) ? 1 : 0
    if (query.lines !== undefined && query.lines !== '') {
      try {
        const list = typeof query.lines === 'string' ? JSON.parse(query.lines) : query.lines
        if (Array.isArray(list)) {
          db.settings.lines = list.map(l => {
            const url = safeLineUrl(l.url, production)
            if (!url) return null
            return {
              id: l.id || nextLineId++,
              name: l.name || '线路',
              url: url,
              region: l.region || '',
              enabled: Number(l.enabled) !== 0 ? 1 : 0
            }
          }).filter(Boolean)
        }
      } catch (e) {}
    }
    if (query.notices !== undefined && query.notices !== '') {
      try {
        const list = typeof query.notices === 'string' ? JSON.parse(query.notices) : query.notices
        if (Array.isArray(list)) {
          db.notices = list.map(n => ({
            id: n.id || nextNoticeId++,
            title: n.title || '公告',
            content: n.content || '',
            enabled: Number(n.enabled) ? 1 : 0,
            createTime: n.createTime || now()
          }))
          syncAnnouncement()
        }
      } catch (e) {}
    }
    if (!String(db.settings.telegramUrl || '').trim()) {
      db.settings.telegramUrl = supportUrlOf()
    }
    persistSettings()
    audit(req, '保存系统设置', '')
    okMsg(res, '设置已保存')
  })

  app.get('/apis/admin/clients', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    let list = db.clients.slice()
    if (query.group) list = list.filter(c => c.group === query.group)
    if (query.keyword) {
      list = list.filter(c => String(c.title).includes(query.keyword) || String(c.app).includes(query.keyword) || String(c.os).includes(query.keyword))
    }
    res.json(page(list, query.rows ? query : Object.assign({}, query, { page: 1, rows: 50 })))
  })

  app.post('/apis/admin/clients/save', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    if (query.id) {
      const item = db.clients.find(c => String(c.id) === String(query.id))
      if (!item) { res.json({ success: 'error', msg: '版本不存在' }); return }
      ;['group', 'title', 'os', 'arch', 'app', 'version', 'url', 'note'].forEach(key => {
        if (query[key] !== undefined) item[key] = query[key]
      })
      if (query.enabled !== undefined) item.enabled = Number(query.enabled)
      audit(req, '编辑客户端', item.title)
      okMsg(res, '客户端版本已更新')
      return
    }
    db.clients.push({
      id: nextClientId++,
      group: query.group || 'Windows',
      title: query.title || '新客户端',
      os: query.os || '',
      arch: query.arch || '',
      app: query.app || '',
      version: query.version || '1.0.0',
      url: query.url || '',
      enabled: 1,
      note: query.note || ''
    })
    audit(req, '新增客户端', query.title)
    okMsg(res, '客户端版本已添加')
  })

  app.get('/apis/admin/faqs', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    res.json(db.faqs.slice().sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0)))
  })

  app.post('/apis/admin/faqs/save', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    if (query.id) {
      const item = db.faqs.find(f => String(f.id) === String(query.id))
      if (!item) { res.json({ success: 'error', msg: '条目不存在' }); return }
      item.question = query.question || item.question
      item.answer = query.answer || item.answer
      if (query.sort !== undefined) item.sort = Number(query.sort)
      if (query.enabled !== undefined) item.enabled = Number(query.enabled)
      audit(req, '编辑 FAQ', item.question)
      okMsg(res, 'FAQ 已更新')
      return
    }
    db.faqs.push({
      id: nextFaqId++,
      question: query.question || '新问题',
      answer: query.answer || '',
      sort: Number(query.sort || db.faqs.length + 1),
      enabled: 1
    })
    audit(req, '新增 FAQ', query.question)
    okMsg(res, 'FAQ 已添加')
  })

  app.get('/apis/admin/notices', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    res.json({
      current: currentAnnouncement(),
      rows: db.notices
    })
  })
  app.post('/apis/admin/notices/save', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    if (query.id) {
      const item = db.notices.find(n => String(n.id) === String(query.id))
      if (!item) { res.json({ success: 'error', msg: '公告不存在' }); return }
      if (query.title !== undefined) item.title = query.title
      if (query.content !== undefined) item.content = query.content
      if (query.enabled !== undefined) item.enabled = Number(query.enabled)
      syncAnnouncement(item)
      audit(req, '编辑公告', item.title)
      okMsg(res, Number(item.enabled) === 1 ? '公告已更新，商户首页已同步' : '公告已更新')
      return
    }
    const created = {
      id: nextNoticeId++,
      title: query.title || '公告',
      content: query.content || '',
      enabled: query.enabled === undefined ? 1 : Number(query.enabled),
      createTime: now()
    }
    db.notices.unshift(created)
    syncAnnouncement(created)
    audit(req, '发布公告', created.title)
    okMsg(res, '公告已发布，商户首页已同步')
  })
  app.post('/apis/admin/notices/delete', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    const idx = db.notices.findIndex(n => String(n.id) === String(query.id))
    if (idx < 0) { res.json({ success: 'error', msg: '公告不存在' }); return }
    const removed = db.notices.splice(idx, 1)[0]
    syncAnnouncement()
    audit(req, '删除公告', removed.title)
    okMsg(res, '公告已删除')
  })

  app.get('/apis/admin/staff', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    res.json(db.admins.map(a => ({ id: a.id, username: a.username, nickname: a.nickname, role: a.role || 'superadmin' })))
  })

  app.post('/apis/admin/staff/save', (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ msg: '超管未登录' }); return }
    const query = q(req)
    if (query.id) {
      const admin = db.admins.find(a => String(a.id) === String(query.id))
      if (!admin) { res.json({ success: 'error', msg: '账号不存在' }); return }
      admin.nickname = query.nickname || admin.nickname
      if (query.password) {
        if (!validPassword(query.password)) { res.json({ success: 'error', msg: '密码至少需要 6 位' }); return }
        admin.password = security.hashPassword(query.password)
        security.revokeSubject('admin', admin.id)
      }
      audit(req, '编辑超管', admin.username)
      okMsg(res, '已更新')
      return
    }
    if (db.admins.find(a => a.username === query.username)) {
      res.json({ success: 'error', msg: '账号已存在' })
      return
    }
    if (!validPassword(query.password)) { res.json({ success: 'error', msg: '密码至少需要 6 位' }); return }
    db.admins.push({
      id: nextAdminId++,
      username: query.username,
      password: security.hashPassword(query.password),
      nickname: query.nickname || query.username,
      role: query.role || 'operator'
    })
    audit(req, '新建超管', query.username)
    okMsg(res, '超管账号已创建')
  })

  app.use('/apis', (req, res) => {
    res.status(404).json({ success: false, msg: '接口不存在' })
  })
}
