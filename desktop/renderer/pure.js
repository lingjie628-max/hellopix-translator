/**
 * 渲染层的纯函数与常量。
 *
 * 这里的东西不碰 DOM、不碰 window.pix、不碰任何状态 —— 同样的输入永远
 * 同样的输出。所以它们能被 node 直接 require 来测（见 test/renderer-pure.test.js），
 * 而 app.js 本身跑不进单测。
 *
 * ## 为什么值得单独拎出来
 *
 * 这几个恰好是最容易出错的一类：版本号比较、代理链接解析、语种排序、
 * 错误文案映射。全是边界条件扎堆的地方，而以前**一个测试都没有** ——
 * 验证方式只能是"装个包点一遍"。
 *
 * ★ 必须在 app.js 之前加载 ★ —— app.js 顶层会直接引用这些名字。
 */

const LANG_PRIORITY = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt-BR', 'pt-PT', 'it', 'ar', 'th', 'vi', 'id', 'hi']

const LANGS = [
  { id: 'auto', name: '自动检测' },
  { id: 'aa', name: '阿法尔语' }, { id: 'ace', name: '亚齐语' }, { id: 'af', name: '南非荷兰语' }, { id: 'ak', name: '阿肯语' }, { id: 'am', name: '阿姆哈拉语' }, { id: 'ar', name: '阿拉伯语' },
  { id: 'as', name: '阿萨姆语' }, { id: 'ay', name: '艾马拉语' }, { id: 'az', name: '阿塞拜疆语' }, { id: 'bal', name: '俾路支语' }, { id: 'ban', name: '巴厘语' }, { id: 'bcl', name: '比科尔语' },
  { id: 'be', name: '白俄罗斯语' }, { id: 'ber', name: '柏柏尔语' }, { id: 'bg', name: '保加利亚语' }, { id: 'bi', name: '比斯拉马语' }, { id: 'bjn', name: '班贾尔语' }, { id: 'bm', name: '班巴拉语' },
  { id: 'bn', name: '孟加拉语' }, { id: 'bo', name: '藏语' }, { id: 'brx', name: '博多语' }, { id: 'bs', name: '波斯尼亚语' }, { id: 'bug', name: '布吉语' }, { id: 'ca', name: '加泰罗尼亚语' },
  { id: 'ce', name: '车臣语' }, { id: 'ceb', name: '宿务语' }, { id: 'ch', name: '查莫罗语' }, { id: 'ckb', name: '中库尔德语' }, { id: 'crs', name: '塞舌尔克里奥尔语' }, { id: 'cs', name: '捷克语' },
  { id: 'cy', name: '威尔士语' }, { id: 'da', name: '丹麦语' }, { id: 'de', name: '德语' }, { id: 'doi', name: '多格拉语' }, { id: 'dv', name: '迪维希语' }, { id: 'dz', name: '宗喀语' },
  { id: 'ee', name: '埃维语' }, { id: 'el', name: '希腊语' }, { id: 'en', name: '英语' }, { id: 'es', name: '西班牙语' }, { id: 'et', name: '爱沙尼亚语' }, { id: 'eu', name: '巴斯克语' },
  { id: 'fa', name: '波斯语' }, { id: 'ff', name: '富拉语' }, { id: 'fi', name: '芬兰语' }, { id: 'fil', name: '菲律宾语' }, { id: 'fj', name: '斐济语' }, { id: 'fo', name: '法罗语' },
  { id: 'fr', name: '法语' }, { id: 'fy', name: '西弗里西语' }, { id: 'ga', name: '爱尔兰语' }, { id: 'gd', name: '苏格兰盖尔语' }, { id: 'gil', name: '基里巴斯语' }, { id: 'gl', name: '加利西亚语' },
  { id: 'gn', name: '瓜拉尼语' }, { id: 'gu', name: '古吉拉特语' }, { id: 'ha', name: '豪萨语' }, { id: 'haw', name: '夏威夷语' }, { id: 'he', name: '希伯来语' }, { id: 'hi', name: '印地语' },
  { id: 'hil', name: '希利盖农语' }, { id: 'hr', name: '克罗地亚语' }, { id: 'ht', name: '海地克里奥尔语' }, { id: 'hu', name: '匈牙利语' }, { id: 'hy', name: '亚美尼亚语' }, { id: 'id', name: '印尼语' },
  { id: 'ig', name: '伊博语' }, { id: 'ilo', name: '伊洛卡诺语' }, { id: 'is', name: '冰岛语' }, { id: 'it', name: '意大利语' }, { id: 'iu', name: '因纽特语' }, { id: 'ja', name: '日语' },
  { id: 'jam', name: '牙买加克里奥尔语' }, { id: 'jv', name: '爪哇语' }, { id: 'ka', name: '格鲁吉亚语' }, { id: 'kab', name: '卡拜尔语' }, { id: 'kg', name: '刚果语' }, { id: 'khq', name: '科伊拉奇尼语' },
  { id: 'kk', name: '哈萨克语' }, { id: 'kl', name: '格陵兰语' }, { id: 'km', name: '高棉语' }, { id: 'kn', name: '卡纳达语' }, { id: 'ko', name: '韩语' }, { id: 'kok', name: '孔卡尼语' },
  { id: 'ks', name: '克什米尔语' }, { id: 'ku', name: '库尔德语' }, { id: 'ky', name: '吉尔吉斯语' }, { id: 'lb', name: '卢森堡语' }, { id: 'lg', name: '卢干达语' }, { id: 'ln', name: '林加拉语' },
  { id: 'lo', name: '老挝语' }, { id: 'lt', name: '立陶宛语' }, { id: 'lu', name: '卢巴语' }, { id: 'lv', name: '拉脱维亚语' }, { id: 'mad', name: '马都拉语' }, { id: 'mai', name: '迈蒂利语' },
  { id: 'mfe', name: '毛里求斯克里奥尔语' }, { id: 'mg', name: '马尔加什语' }, { id: 'mh', name: '马绍尔语' }, { id: 'mi', name: '毛利语' }, { id: 'min', name: '米南加保语' }, { id: 'mk', name: '马其顿语' },
  { id: 'ml', name: '马拉雅拉姆语' }, { id: 'mn', name: '蒙古语' }, { id: 'mni', name: '曼尼普尔语' }, { id: 'mr', name: '马拉地语' }, { id: 'mrj', name: '西马里语' }, { id: 'ms', name: '马来语' },
  { id: 'mt', name: '马耳他语' }, { id: 'my', name: '缅甸语' }, { id: 'mzn', name: '马赞德兰语' }, { id: 'na', name: '瑙鲁语' }, { id: 'ne', name: '尼泊尔语' }, { id: 'nl', name: '荷兰语' },
  { id: 'no', name: '挪威语' }, { id: 'nqo', name: '恩科语' }, { id: 'nr', name: '南恩德贝莱语' }, { id: 'nso', name: '北索托语' }, { id: 'ny', name: '齐切瓦语' }, { id: 'om', name: '奥罗莫语' },
  { id: 'or', name: '奥里亚语' }, { id: 'os', name: '奥塞梯语' }, { id: 'pa', name: '旁遮普语' }, { id: 'pag', name: '邦阿西楠语' }, { id: 'pap', name: '帕皮阿门托语' }, { id: 'pau', name: '帕劳语' },
  { id: 'pl', name: '波兰语' }, { id: 'prs', name: '达里语' }, { id: 'ps', name: '普什图语' },
  // 葡萄牙语分两种：巴西（pt-BR）与欧洲（pt-PT）。
  // 界面上必须让用户选得到自己那一种 —— 只写"葡萄牙语"时，巴西用户与葡萄牙
  // 用户都以为自己选对了，实际译文风格不符合预期。
  { id: 'pt-BR', name: '葡萄牙语（巴西）' }, { id: 'pt-PT', name: '葡萄牙语（欧洲）' },
  { id: 'qu', name: '克丘亚语' }, { id: 'rm', name: '罗曼什语' },
  { id: 'rn', name: '基隆迪语' }, { id: 'ro', name: '罗马尼亚语' }, { id: 'ru', name: '俄语' }, { id: 'rw', name: '卢旺达语' }, { id: 'sa', name: '梵语' }, { id: 'sat', name: '桑塔利语' },
  { id: 'sd', name: '信德语' }, { id: 'ses', name: '科伊拉博罗语' }, { id: 'sg', name: '桑戈语' }, { id: 'shi', name: '希尔哈语' }, { id: 'si', name: '僧伽罗语' }, { id: 'sk', name: '斯洛伐克语' },
  { id: 'sl', name: '斯洛文尼亚语' }, { id: 'sm', name: '萨摩亚语' }, { id: 'sn', name: '绍纳语' }, { id: 'so', name: '索马里语' }, { id: 'sq', name: '阿尔巴尼亚语' }, { id: 'sr', name: '塞尔维亚语' },
  { id: 'srn', name: '苏里南语' }, { id: 'ss', name: '斯瓦蒂语' }, { id: 'st', name: '塞索托语' }, { id: 'su', name: '巽他语' }, { id: 'sun', name: '巽他语' }, { id: 'sv', name: '瑞典语' },
  { id: 'sw', name: '斯瓦希里语' }, { id: 'ta', name: '泰米尔语' }, { id: 'te', name: '泰卢固语' }, { id: 'tet', name: '德顿语' }, { id: 'tg', name: '塔吉克语' }, { id: 'th', name: '泰语' },
  { id: 'ti', name: '提格里尼亚语' }, { id: 'tk', name: '土库曼语' }, { id: 'tn', name: '茨瓦纳语' }, { id: 'to', name: '汤加语' }, { id: 'tr', name: '土耳其语' }, { id: 'ts', name: '聪加语' },
  { id: 'tvl', name: '图瓦卢语' }, { id: 'tw', name: '契维语' }, { id: 'ty', name: '塔希提语' }, { id: 'tzm', name: '中阿特拉斯柏柏尔语' }, { id: 'ug', name: '维吾尔语' }, { id: 'uk', name: '乌克兰语' },
  { id: 'ur', name: '乌尔都语' }, { id: 'uz', name: '乌兹别克语' }, { id: 've', name: '文达语' }, { id: 'vi', name: '越南语' }, { id: 'wa', name: '瓦隆语' }, { id: 'war', name: '瓦瑞语' },
  { id: 'wo', name: '沃洛夫语' }, { id: 'xh', name: '科萨语' }, { id: 'yi', name: '意第绪语' }, { id: 'yo', name: '约鲁巴语' }, { id: 'zh', name: '中文' }, { id: 'zh-TW', name: '繁体中文' },
  { id: 'zu', name: '祖鲁语' }
]

function friendlyError(err, fallback) {
  // 取消息：优先 err.message；字符串直接用。
  // 注意 new Error('') 的 toString 是 "Error"，别把它当成有效消息。
  let msg = ''
  if (err && typeof err.message === 'string') msg = err.message
  else if (typeof err === 'string') msg = err
  else if (err) msg = String(err)
  // 包装可能套多层，循环剥干净
  for (let i = 0; i < 4; i++) {
    const next = msg.replace(/^\s*Error invoking remote method '[^']*':\s*/i, '').replace(/^\s*Error:\s*/i, '')
    if (next === msg) break
    msg = next
  }
  msg = msg.trim()
  if (!msg || /^error$/i.test(msg)) return fallback
  const known = [
    [/不符合安全策略/, '当前线路不可用，请检查网络后重试'],
    [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, '无法解析服务器地址，请检查网络'],
    [/ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|超时/i, '连接服务器超时，请稍后重试'],
    [/fetch failed|NetworkError|network/i, '网络连接失败，请检查网络']
  ]
  for (const [re, text] of known) if (re.test(msg)) return text
  return msg
}

function cmpVer(a, b) {
  // ★ 必须先滤掉 split 产生的空段 ★
  //
  // 'v1.2.3'.split(/[^\d]+/) 是 ['', '1', '2', '3'] —— 开头的非数字会产生
  // 一个空段，被 parseInt 成 0；而 '1.2.3' 是 ['1', '2', '3']。
  // 于是 cmpVer('v1.2.3', '1.2.3') 返回 -1，也就是把同一个版本判成"更旧"。
  // 现在两边都是纯数字，所以线上没暴露；但只要哪天版本号带上前缀，
  // 更新检查就会永远说"已是最新"。
  const parts = v => String(v || '0').split(/[^\d]+/).filter(s => s !== '').map(n => parseInt(n, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  // 全是分隔符的输入（比如 'v'）会滤成空数组，补一个 0 当 0.0.0
  if (!pa.length) pa.push(0)
  if (!pb.length) pb.push(0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
  }
  return 0
}

function esc(text) {
  return String(text || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]))
}

function langDisplayName(l) {
  if (l.id === 'auto') return '自动识别'
  if (l.id === 'zh') return '简体中文'
  return l.name
}

function orderedLangs(rows) {
  const rank = new Map(LANG_PRIORITY.map((id, i) => [id, i]))
  return rows.slice().sort((a, b) => {
    // 'auto'（自动识别）永远置顶：它是发/收翻译的默认值，排到中间会让
    // 用户以为默认值变了
    if (a.id === 'auto' || b.id === 'auto') return a.id === 'auto' ? -1 : 1
    const ra = rank.has(a.id) ? rank.get(a.id) : Infinity
    const rb = rank.has(b.id) ? rank.get(b.id) : Infinity
    return ra - rb
  })
}

function langOptionHtml(rows) {
  const list = orderedLangs(rows || LANGS)
  // 常用语种与其余部分之间插一条分隔线：让"下面还有一长串"这件事可见。
  // 用空值 + disabled，避免它被当成可选项选中。
  const topCount = list.filter(l => l.id === 'auto' || LANG_PRIORITY.includes(l.id)).length
  return list
    .map((l, i) => '<option value="' + l.id + '">' + langDisplayName(l) + '</option>' +
      (i === topCount - 1 ? '<option value="" disabled>──────────</option>' : ''))
    .join('')
}

function groupModeUiValue(mode) {
  if (mode === 'inherit') return 'inherit'
  if (mode === 'auto') return 'auto'
  return 'manual'
}

function speedText(line) {
  if (line.pending) return '测速中'
  if (line.ok === false) return '超时'
  if (line.ms == null) return '--'
  return line.ms + 'ms'
}

function speedClass(line) {
  if (line.ok === false) return 'ms bad'
  if (line.ms == null || line.pending) return 'ms'
  if (line.ms > 300) return 'ms bad'
  if (line.ms > 120) return 'ms slow'
  return 'ms'
}

function formatProxyTime(at) {
  const d = new Date(Number(at) || 0)
  if (!d.getTime()) return ''
  const pad = n => (n < 10 ? '0' : '') + n
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}

function parseProxyLine(raw) {
  const text = String(raw || '').trim().replace(/^(socks5h?|https?):\/\//i, '')
  if (!text) return null
  const at = text.lastIndexOf('@')
  if (at > 0) {
    const auth = text.slice(0, at)
    const hostPort = text.slice(at + 1)
    const colon = auth.indexOf(':')
    const hp = hostPort.split(':')
    return {
      user: colon >= 0 ? auth.slice(0, colon) : auth,
      pass: colon >= 0 ? auth.slice(colon + 1) : '',
      host: hp[0] || '',
      port: hp[1] || ''
    }
  }
  const parts = text.split(':')
  if (parts.length >= 4) {
    return { host: parts[0], port: parts[1], user: parts[2], pass: parts.slice(3).join(':') }
  }
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { host: parts[0], port: parts[1] }
  }
  return { host: text }
}
