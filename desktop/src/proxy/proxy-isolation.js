'use strict'

/**
 * 代理配置的**实例级隔离**。
 *
 * ## 产品硬规则
 *
 * 一个窗口 = 一个独立 Session = 一个独立 Partition = 一套独立代理配置 = 一个独立出口 IP。
 * 代理属于**实例级敏感配置**，不能成为任何形式的全局默认值。
 *
 * ## 被修的缺陷：新建实例继承了上一个实例的代理
 *
 * `app-presets.json` 是"某个平台上次是怎么配的"模板。它的 `settings` 存的是**整份**
 * 标签页设置 —— 包括全部代理字段。于是链路变成：
 *
 *   给 WhatsApp A 配了代理 X
 *     → 标签页设置连同代理被写进 app-presets.json（app:savePreset）
 *     → 用户点「新增应用」，渲染进程拉这个平台的预设（app:preset）
 *     → fillAddForm 把预设并进表单默认值，代理字段被填成 X
 *     → 新实例 B 带着 X 被创建
 *
 * 也就是说 B 之所以继承 X，不是因为哪里"复制了变量"，而是因为**代理被当成了模板内容**。
 * 模板里本来就不该有代理。
 *
 * ## 这个模块负责什么
 *
 * 提供"代理字段全集"和"直连初值"的唯一定义，以及两个纯函数：
 *
 *   - `stripProxyFields()` —— 把代理字段从任意 settings 里摘掉。
 *     **写模板 / 读模板 / 改名继承模板** 这三处都必须过它。
 *   - `withDirectProxy()` —— 直连初值覆盖。
 *   - `isDirectProxy()` —— 判定"这条实例是直连"。
 *
 * 纯函数、无副作用、不依赖 electron，所以测试可以直接 require。
 *
 * ## 刻意不做的事
 *
 * 不去动 `open-apps.json`（每个实例自己的设置）。那里**必须**保留代理，
 * 否则重启后 A 恢复不了 X。隔离的目标是"实例之间"与"模板到实例"，
 * 不是"实例到磁盘"。
 */

/**
 * 代理字段全集。任何跨实例传递 settings 的地方都要先过 `stripProxyFields`。
 *
 * 与渲染进程表单里的字段一一对应（见 `renderer/app.js` 的 `readAddSettings`）。
 *
 * ## 为什么比 `proxy-settings.js` 的 PROXY_FIELDS 更宽
 *
 * 那份清单解决的是另一个问题："这次补丁有没有动代理，要不要重连"。
 * 它只需要覆盖**影响实际连接**的字段，所以不含 proxyNode / proxyChannel /
 * proxyIpVer / proxyRefresh / proxyUdp / proxyGeo。
 *
 * 这份清单解决的是"什么不许跨实例继承"，口径必须是**用户填过的整块代理配置**，
 * 否则 `proxyRefresh`（自动换线地址）这类字段会悄悄跟着新实例跑。
 * 两者是包含关系，`test/proxy-instance-isolation.test.js` 里有断言锁住它 ——
 * 以后往 proxy-settings 加字段却忘了在这里同步，测试会直接挂。
 */
const PROXY_FIELDS = [
  'proxyType',
  'proxyHost',
  'proxyPort',
  'proxyScheme',
  'proxyUser',
  'proxyPass',
  'proxyNode',
  'proxyChannel',
  'proxyIpVer',
  'proxyRefresh',
  'proxyUdp',
  'proxyGeo'
]

/**
 * 直连初值 —— 新建实例的唯一合法起点。
 *
 * `proxyChannel` / `proxyIpVer` 不是敏感信息，但它们是**代理配置块的一部分**：
 * 上一个实例选了 ipv6，新实例没理由跟着变。一并回到默认。
 */
const DIRECT_PROXY = Object.freeze({
  proxyType: 'none',
  proxyHost: '',
  proxyPort: '',
  proxyScheme: 'socks5',
  proxyUser: '',
  proxyPass: '',
  proxyNode: '',
  proxyChannel: 'dbip',
  proxyIpVer: 'ipv4',
  proxyRefresh: '',
  proxyUdp: false,
  proxyGeo: null
})

/** 摘掉全部代理字段。返回新对象，不改入参。 */
function stripProxyFields(settings) {
  const copy = Object.assign({}, settings || {})
  for (const name of PROXY_FIELDS) delete copy[name]
  return copy
}

/** 摘掉代理字段再铺上直连初值。 */
function withDirectProxy(settings) {
  const copy = stripProxyFields(settings)
  for (const name of PROXY_FIELDS) copy[name] = DIRECT_PROXY[name]
  return copy
}

/** 代理字段有没有差异（用于判断"这次改动要不要重连"）。 */
function proxyFieldsChanged(before, after) {
  const a = before || {}
  const b = after || {}
  for (const name of PROXY_FIELDS) {
    if (JSON.stringify(a[name] === undefined ? null : a[name]) !==
        JSON.stringify(b[name] === undefined ? null : b[name])) return true
  }
  return false
}

/**
 * 这条实例是不是直连。
 *
 * 只看 `proxyType` 与主机字段：类型是 none 时，残留的 host/port 不构成代理
 * （`proxyRulesOf` 也是按类型决定是否下发规则的），所以不能反过来把
 * "类型 none 但 host 有值"误判成"在用代理"。
 */
function isDirectProxy(settings) {
  const s = settings || {}
  if (String(s.proxyType || 'none') !== 'none') return false
  if (String(s.proxyHost || '').trim()) return false
  if (String(s.proxyNode || '').trim()) return false
  return true
}

module.exports = {
  PROXY_FIELDS,
  DIRECT_PROXY,
  stripProxyFields,
  withDirectProxy,
  proxyFieldsChanged,
  isDirectProxy
}
