'use strict'

// 独立应用是 Hello Pix 自己的单应用翻译壳，不是 Signal/Telegram 官方安装包。
// client_releases.app 必须对齐 desktop/platforms.js 的 id（如 signal、telegram-z）。
const platforms = require('../../desktop/shared/platforms')

const RELEASE_GROUPS = Object.freeze([
  // `desktop` 是发布脚本实际在写的分组（1.2.2 起 12 条记录）。它原来不在
  // 这张表里，`groupId()` 于是把它归一成空串，后果是：
  //   · findUpdate 的 score() 给"空分组"多打 1 分，旧版 windows/macos
  //     记录反过来把**新版**压到后面 —— 线上返回 1.2.1 让客户端以为自己最新；
  //   · 后台分组列显示空白，看不出这些包属于哪个平台。
  // 放在最前，让它是 `groupLabel` 的兜底选择。
  { id: 'desktop', label: '桌面版' },
  { id: 'windows', label: 'Windows' },
  { id: 'macos', label: 'macOS' },
  { id: 'android', label: 'Android' },
  { id: 'ios', label: 'iOS' },
  { id: 'standalone', label: '独立应用' },
  { id: 'counter', label: '计数器' }
])

const STANDALONE_ONLY_APPS = Object.freeze([
  // Signal 没有网页版，只作为独立原生客户端发布，不能混进多开壳的平台表。
  Object.freeze({ id: 'signal', name: 'Signal' })
])

/**
 * 真正具备“客户身份采集 → 新粉/重粉筛选”链路的平台。
 *
 * 平台出现在客户端里，不等于能被计数工单识别。只有采集层能稳定产出
 * accountKey、peerKey、会话和入站消息证据的平台，才允许进入计数工单。
 */
const COUNTING_PLATFORMS = new Set([
  'whatsapp-green',
  'whatsapp-pro',
  'whatsapp-biz',
  'telegram-z'
])

const STANDALONE_APPS = Object.freeze(
  [
    ...platforms
      .filter(item => !item.customUrl && item.id !== 'tickets' && item.id !== 'pm-office')
      .map(item => ({ id: item.id, name: item.name })),
    ...STANDALONE_ONLY_APPS
  ]
    .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index)
    .map(item => Object.freeze(item))
)

function groupId(value) {
  const raw = String(value || '').trim()
  const found = RELEASE_GROUPS.find(item => item.id === raw.toLowerCase() || item.label === raw)
  return found ? found.id : ''
}

function groupLabel(value) {
  const found = RELEASE_GROUPS.find(item => item.id === groupId(value))
  return found ? found.label : String(value || '')
}

function isStandaloneApp(appId) {
  return STANDALONE_APPS.some(item => item.id === String(appId || ''))
}

function supportsCounting(platformId) {
  return COUNTING_PLATFORMS.has(String(platformId || '').trim().toLowerCase())
}

function hasPublicUrl(url) {
  return /^https:\/\//i.test(String(url || '').trim())
}

function publicRelease(row) {
  if (!row || !row.enabled || !hasPublicUrl(row.url)) return null
  const releaseGroup = groupId(row.releaseGroup || row.group)
  return {
    id: row.id,
    group: groupLabel(releaseGroup),
    releaseGroup,
    title: row.title,
    os: row.os,
    arch: row.arch || '',
    app: row.app || '',
    version: row.version,
    url: String(row.url).trim(),
    // 签名清单优先使用离线签好并入库的 signature；生产服务不必常驻私钥。
    // 数据库若改了 URL/哈希却没重新签名，客户端仍会验签失败。
    sha256: row.sha256 || '',
    signature: row.signature || '',
    /**
     * ★ 两种命名都要认 ★
     *
     * `publicReleases()` 传进来的是**已经经过 mapRow 驼峰化**的行
     * （production-repository.js 的 mapRow 把 min_version 转成 minVersion），
     * 所以这里只读 `row.min_version` 永远是 undefined → 退成空串 →
     * buildManifest 再退成 `row.version`。
     *
     * 后果：库里 min_version=1.2.0 的记录，签出来的清单 minVersion 却是 1.2.6。
     * 客户端拿它做防降级自检，等于把"可以升到任意 ≥ 1.2.6"变成
     * "只能 ≥ 1.2.6" —— 语义被悄悄改掉，而现有测试是直接构造
     * `{ min_version }` 调 buildManifest 的，压根没经过这一层，所以全绿。
     */
    minVersion: row.minVersion || row.min_version || '',
    note: row.note || ''
  }
}

function adminRelease(row) {
  const releaseGroup = groupId(row.releaseGroup || row.group)
  return {
    id: row.id,
    group: groupLabel(releaseGroup),
    releaseGroup,
    title: row.title,
    os: row.os,
    arch: row.arch || '',
    app: row.app || '',
    version: row.version,
    url: row.url || '',
    enabled: row.enabled ? 1 : 0,
    note: row.note || ''
  }
}

/**
 * 套餐是否包含原生计数工单。
 *
 * 计数工单承接原“计数器版本”的商业权益，因此必须与套餐 `clients.counter`
 * 使用同一个开关。后端 API 是最终闸门，前端字段只负责隐藏入口。
 */
function packageAllowsCounter(clients) {
  let value = clients
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch (_error) {
      return false
    }
  }
  if (!value || typeof value !== 'object') return false
  return value.counter === true || Number(value.counter) === 1
}

/**
 * 语义化版本比较：`a` 比 `b` 新返回正数，旧返回负数，相同返回 0。
 *
 * 必须按**数字段**比，不能按字符串比 —— `'1.10.0' < '1.9.0'` 是字符串的真相，
 * 但版本语义恰好相反。客户端 `renderer/pure.js` 里已有一份 cmpVer，这里
 * 是服务端对应实现（两处不共用代码是因为一个跑在 Electron 渲染进程、
 * 一个跑在 Node 服务端，没有可共享的构建产物）。
 *
 * `findUpdate` 选包**必须先过这个函数**再考虑其他偏好分：把一个更旧、
 * 但恰好"app 字段为空 / 架构写法更讨喜"的包推给用户，等于把用户按在
 * 已知问题上，而且界面会显示"已是最新"。
 */
function compareVersions(a, b) {
  const parts = v => String(v == null ? '' : v).split(/[^\d]+/).filter(s => s !== '').map(n => parseInt(n, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

module.exports = {
  RELEASE_GROUPS,
  STANDALONE_APPS,
  groupId,
  groupLabel,
  compareVersions,
  isStandaloneApp,
  supportsCounting,
  hasPublicUrl,
  publicRelease,
  adminRelease,
  packageAllowsCounter
}
