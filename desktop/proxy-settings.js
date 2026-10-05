'use strict'

/**
 * 线路代理的**构建与应用**。
 *
 * ## 为什么把这些函数从 main.js 抽出来
 *
 * 原先代理规则构建（`proxyRulesOf`）与"把规则写进 session"（`applySessionProxy`）
 * 都埋在 main.js 里。main.js 是 Electron 入口，`require` 时会碰 `electron` 模块，
 * 在普通 Node 里加载不了 —— 于是这段**最需要回归保护**的逻辑一个测试都没有。
 *
 * 抽出来之后：产品、单元测试、真机机制测试**用的是同一份实现**，
 * 不存在"测试里一套、产品里另一套"的漂移。
 *
 * ## 被修的真实缺陷（本模块的由来）
 *
 * `applySessionProxy` 此前**只有一个调用点**：`startTabLoad()`。
 * 也就是说代理只在"新建线路 / 重启恢复"时才会写进 session。
 * 凡是"改一条已存在线路的代理"的路径，改了都不会生效 ——
 * 设置看着保存了，实际走的还是旧代理，直到这条线路被关掉重建。
 *
 * 修法不是加第二套代理逻辑，而是把应用动作交回这里，
 * 让 `updateTabSettings` 也能调同一个函数（见 main.js）。
 *
 * ## 约束
 *
 * 本文件**不得 require electron**，否则又回到"测不了"的老路。
 * 需要 session 的地方一律由调用方传入（真实 Electron session 或测试替身），
 * 我们只要求它有一个 `setProxy()` 方法。
 */

const proxyPresets = require('./proxy-presets')

/**
 * 代理字段白名单。
 *
 * 用途有二：
 *   1. 判断"这次补丁有没有动代理"，决定要不要重新应用并 reload；
 *   2. 从完整 settings 里挑出代理部分回给渲染层（不回传翻译设置等无关字段）。
 *
 * 漏掉某个字段的后果：改了它不会触发重新应用 —— 正是本次要修的缺陷形态。
 */
const PROXY_FIELDS = Object.freeze([
  'proxyType',
  'proxyScheme',
  'proxyHost',
  'proxyPort',
  'proxyUser',
  'proxyPass'
])

function proxyPresetOf(id) {
  return proxyPresets.find(item => item.id === id) || proxyPresets[0]
}

function sanitizeProxyPart(raw, max) {
  const text = String(raw || '').trim()
  if (!text || text.length > (max || 260) || /[\s<>'"\\]/.test(text)) return ''
  return text
}

/**
 * 解析「主机:端口:账号:密码」或「socks5://账号:密码@主机:端口」。
 * 用户从代理后台复制时通常是这两种形态，允许直接粘贴。
 */
function parseProxyHostLine(raw) {
  const text = String(raw || '').trim().replace(/^(socks5h?|https?):\/\//i, '')
  if (!text) return {}
  const authAt = text.lastIndexOf('@')
  if (authAt > 0) {
    const auth = text.slice(0, authAt)
    const hostPort = text.slice(authAt + 1)
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

/**
 * 把一条线路的 settings 编译成 Electron 的 proxyRules 字符串。
 * 返回 '' 表示**直连**（由调用方转成 `{ mode: 'direct' }`）。
 */
function proxyRulesOf(settings) {
  const type = String((settings && settings.proxyType) || 'none')
  if (!type || type === 'none') return ''
  const preset = proxyPresetOf(type)
  if (preset.kind === 'direct') return ''
  if (type === 'ssh' && settings.proxyLocal) return 'socks5://' + settings.proxyLocal
  let host = sanitizeProxyPart(settings.proxyHost, 180)
  let port = sanitizeProxyPart(settings.proxyPort, 8)
  let user = String((settings && settings.proxyUser) || '').trim()
  let pass = String((settings && settings.proxyPass) || '').trim()
  const parsed = parseProxyHostLine(settings.proxyHost || settings.proxyNode || '')
  // 用户常把代理后台给的一整行「主机:端口:账号:密码」直接粘进"代理主机"。
  // 这种时候 proxyHost 里带着冒号，**不能整串当主机名** ——
  // 否则会拼出 socks5://u:p@1.2.3.4:8080:u:p:8080 这种坏规则
  // （Electron 解析失败 → 表现为"填了代理反而更连不上"）。
  // 只在整串确实解析出端口/账密时才拆开，正常主机名不受影响。
  if (parsed.host && (parsed.port || parsed.user || parsed.pass)) {
    host = sanitizeProxyPart(parsed.host, 180)
    if (parsed.port) port = sanitizeProxyPart(parsed.port, 8)
    if (parsed.user) user = String(parsed.user).trim()
    if (parsed.pass) pass = String(parsed.pass).trim()
  }
  if (!host && parsed.host) host = sanitizeProxyPart(parsed.host, 180)
  if (!port && parsed.port) port = sanitizeProxyPart(parsed.port, 8)
  if (!user && parsed.user) user = String(parsed.user).trim()
  if (!pass && parsed.pass) pass = String(parsed.pass).trim()
  if (settings.proxyNode && !host) {
    const node = parseProxyHostLine(settings.proxyNode)
    host = sanitizeProxyPart(node.host, 180)
    port = port || sanitizeProxyPart(node.port, 8)
    user = user || String(node.user || '').trim()
    pass = pass || String(node.pass || '').trim()
  }
  if (!host) return ''
  const scheme = String((settings && settings.proxyScheme) || preset.scheme || 'socks5').toLowerCase()
  const proto = scheme === 'https' ? 'https' : scheme === 'http' ? 'http' : 'socks5'
  const auth = user || pass
    ? encodeURIComponent(user) + ':' + encodeURIComponent(pass) + '@'
    : ''
  return proto + '://' + auth + host + (port ? ':' + port : '')
}

/** 只挑出代理字段（回给渲染层用，避免把整个 settings 抖出去）。 */
function proxySettingsOf(settings) {
  const src = settings || {}
  const out = {}
  PROXY_FIELDS.forEach(key => { out[key] = src[key] === undefined ? '' : src[key] })
  out.proxyType = src.proxyType || 'none'
  return out
}

/**
 * 这次修改有没有动到代理字段。
 *
 * 比较的是**规范化后的字符串**：`undefined` 与 `''` 视为相同，
 * 否则"表单里空密码"这种无意义差异会触发一次多余的 reload。
 */
function proxyFieldsChanged(before, after) {
  const b = before || {}
  const a = after || {}
  return PROXY_FIELDS.some(key => {
    const left = b[key] === undefined || b[key] === null ? '' : String(b[key])
    const right = a[key] === undefined || a[key] === null ? '' : String(a[key])
    return left !== right
  })
}

/** 取出线路对应的 Electron session（测试替身只需具备 setProxy）。 */
function sessionOf(tab) {
  return tab && tab.view && tab.view.webContents ? tab.view.webContents.session : null
}

/**
 * 把 settings 里的代理写进指定 session。
 *
 * 有代理 → `proxyRules`；没有 → `mode: 'direct'`（**必须显式走 direct**，
 * 否则"删除代理"只会留着上一次的规则，线路继续走旧代理）。
 *
 * 失败一律吞掉：代理填错不该让整个客户端崩，用户会表现为"上不了网"，
 * 再回去改设置即可。这也是原先就有的行为，保持不动。
 */
function applySessionProxy(ses, settings) {
  if (!ses || typeof ses.setProxy !== 'function') return Promise.resolve()
  const rules = proxyRulesOf(settings)
  const next = rules
    ? ses.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' })
    : ses.setProxy({ mode: 'direct' })
  return Promise.resolve(next).catch(() => {})
}

/**
 * 对一条线路应用它自己的代理 —— **新建、重启恢复、改代理都走这里**。
 *
 * deps:
 *   restartSshTunnel(tab)  仅 ssh 类型需要；由 main.js 注入（它要 spawn ssh）
 *   applySessionProxy      可选，注入测试替身；默认用上面的真实实现
 *
 * 返回 Promise，调用方据此决定"应用完成后再 reload"——顺序反了会
 * 出现"页面已重新加载，但走的是旧代理"。
 */
function applyTabProxy(tab, deps) {
  const options = deps || {}
  const settings = (tab && tab.settings) || {}
  const apply = typeof options.applySessionProxy === 'function'
    ? options.applySessionProxy
    : applySessionProxy
  const restart = options.restartSshTunnel
  const isSsh = String(settings.proxyType || '') === 'ssh'
  const ready = isSsh && typeof restart === 'function'
    ? Promise.resolve(restart(tab))
    : Promise.resolve()
  return ready.then(() => apply(sessionOf(tab), settings))
}

module.exports = {
  PROXY_FIELDS,
  proxyPresetOf,
  sanitizeProxyPart,
  parseProxyHostLine,
  proxyRulesOf,
  proxySettingsOf,
  proxyFieldsChanged,
  sessionOf,
  applySessionProxy,
  applyTabProxy
}
