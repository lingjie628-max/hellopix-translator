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

/** 解析 "host:port"（ssh 隧道本地监听用）。 */
function splitHostPort(raw) {
  const text = String(raw || '').trim()
  const idx = text.lastIndexOf(':')
  if (idx <= 0) return { host: text, port: '' }
  return { host: text.slice(0, idx), port: text.slice(idx + 1) }
}

/**
 * 把一条线路的 settings 解析成**代理目标**。
 *
 * 返回 `{ direct: true }` 表示直连；否则给出 `scheme / host / port / user / pass / hasAuth`。
 *
 * 为什么把账密单独解析出来：Chromium 的 `proxyRules` 字符串**不接受内嵌凭据**
 * （`socks5://user:pass@host:port` 实测报 `net::ERR_NO_SUPPORTED_PROXIES`）。
 * 所以规则串与凭据必须分开传递 —— 规则走 `proxyRulesOf`，
 * HTTP/HTTPS 的凭据走 `app.on('login')`，SOCKS5 的凭据走本地中继。
 */
function proxyTargetOf(settings) {
  const s = settings || {}
  const type = String(s.proxyType || 'none')
  if (!type || type === 'none') return { direct: true }
  const preset = proxyPresetOf(type)
  if (preset.kind === 'direct') return { direct: true }
  // ssh 隧道：隧道进程已在本地监听一个无认证 socks5，直接用它的地址。
  if (type === 'ssh' && s.proxyLocal) {
    const local = splitHostPort(s.proxyLocal)
    return {
      direct: false,
      scheme: 'socks5',
      host: sanitizeProxyPart(local.host, 180),
      port: sanitizeProxyPart(local.port, 8),
      user: '',
      pass: '',
      hasAuth: false,
      viaTunnel: true
    }
  }
  let host = sanitizeProxyPart(s.proxyHost, 180)
  let port = sanitizeProxyPart(s.proxyPort, 8)
  let user = String(s.proxyUser || '').trim()
  let pass = String(s.proxyPass || '').trim()
  const parsed = parseProxyHostLine(s.proxyHost || s.proxyNode || '')
  // 用户常把代理后台给的一整行「主机:端口:账号:密码」直接粘进"代理主机"。
  // 这种时候 proxyHost 里带着冒号，**不能整串当主机名** ——
  // 否则端口/账密会被解析错位（填了代理反而更连不上）。
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
  if (s.proxyNode && !host) {
    const node = parseProxyHostLine(s.proxyNode)
    host = sanitizeProxyPart(node.host, 180)
    port = port || sanitizeProxyPart(node.port, 8)
    user = user || String(node.user || '').trim()
    pass = pass || String(node.pass || '').trim()
  }
  if (!host) return { direct: true }
  const scheme = String(s.proxyScheme || preset.scheme || 'socks5').toLowerCase()
  const normalized = scheme === 'https' ? 'https' : scheme === 'http' ? 'http' : 'socks5'
  return {
    direct: false,
    scheme: normalized,
    host: host,
    port: port,
    user: user,
    pass: pass,
    hasAuth: !!(user || pass)
  }
}

/**
 * 这条线路是否有需要交给「认证环节」的账密。
 *
 * · HTTP/HTTPS：交给 `app.on('login')`（`authInfo.isProxy === true` 时）。
 * · SOCKS5：交给本地中继（Chromium 的 socks5 认证不触发 login 事件）。
 * 没有账密返回 null。
 */
function proxyAuthOf(settings) {
  const target = proxyTargetOf(settings)
  if (target.direct || !target.hasAuth) return null
  return { scheme: target.scheme, host: target.host, port: target.port, user: target.user, pass: target.pass }
}

/**
 * 把一条线路的 settings 编译成 Electron 的 proxyRules 字符串 —— **不含任何凭据**。
 * 返回 '' 表示**直连**（由调用方转成 `{ mode: 'direct' }`）。
 *
 * · HTTP/HTTPS：`http(s)://host:port`，Basic 凭据由 `app.on('login')` 补上。
 * · SOCKS5 无认证：`socks5://host:port`。
 * · SOCKS5 带认证：Chromium 无法为 socks5 提供凭据，必须由一个**本地中继**承接 ——
 *   调用方先起中继、把中继地址通过 `options.relayEndpoint`（形如 `127.0.0.1:12345`）传入，
 *   这里生成 `socks5://127.0.0.1:12345`（Chromium 连中继，中继再带凭据连上游）。
 *   没有传中继地址时返回 '' —— 但这**不是**"直连"，调用方（applyTabProxy）必须先起中继，
 *   否则等于静默换了出口。
 */
function proxyRulesOf(settings, options) {
  const target = proxyTargetOf(settings)
  if (target.direct || !target.host) return ''
  if (target.scheme === 'socks5' && target.hasAuth) {
    const endpoint = options && options.relayEndpoint
    if (!endpoint) return ''
    return 'socks5://' + endpoint
  }
  return target.scheme + '://' + target.host + (target.port ? ':' + target.port : '')
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
 * `options.relayEndpoint`：带认证 SOCKS5 的本地中继地址（见 proxyRulesOf）。
 *
 * 失败一律吞掉：代理填错不该让整个客户端崩，用户会表现为"上不了网"，
 * 再回去改设置即可。这也是原先就有的行为，保持不动。
 */
function applySessionProxy(ses, settings, options) {
  if (!ses || typeof ses.setProxy !== 'function') return Promise.resolve()
  const rules = proxyRulesOf(settings, options)
  const next = rules
    ? ses.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' })
    : ses.setProxy({ mode: 'direct' })
  return Promise.resolve(next).catch(() => {})
}

/**
 * 对一条线路应用它自己的代理 —— **新建、重启恢复、改代理都走这里**。
 *
 * deps:
 *   restartSshTunnel(tab)   仅 ssh 类型需要；由 main.js 注入（它要 spawn ssh）
 *   ensureSocksRelay(tab, target)  仅"带认证的 SOCKS5"需要；返回 { endpoint: '127.0.0.1:port' }
 *   releaseSocksRelay(tab)         线路不再需要中继时调用（改成直连/别的代理）
 *   applySessionProxy              可选，注入测试替身；默认用上面的真实实现
 *
 * 顺序很重要：
 *   · ssh：**先起隧道再写 session**（隧道没起来就写 session 会连到不存在的本地端口）；
 *   · socks5+认证：**先起中继再写 session**（规则里要填中继地址）。
 * 因此目标（target）在 pre 步骤之后才解析 —— ssh 隧道会把 proxyLocal 写回 settings。
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
  const isSsh = String(settings.proxyType || '') === 'ssh'
  const pre = isSsh && typeof options.restartSshTunnel === 'function'
    ? Promise.resolve(options.restartSshTunnel(tab))
    : Promise.resolve()

  return pre.then(() => {
    const target = proxyTargetOf(settings)
    const needsRelay = !target.direct && target.scheme === 'socks5' && target.hasAuth

    if (needsRelay) {
      if (typeof options.ensureSocksRelay !== 'function') {
        // 带认证的 socks5 没有中继就走不了。**绝不退回直连** —— 那是静默换出口。
        throw new Error('带认证的 SOCKS5 需要本地中继，但未注入 ensureSocksRelay')
      }
      return Promise.resolve(options.ensureSocksRelay(tab, {
        host: target.host,
        port: target.port,
        user: target.user,
        pass: target.pass
      })).then(relay => {
        const endpoint = relay && relay.endpoint
        if (!endpoint) throw new Error('本地 SOCKS5 中继未能启动')
        return apply(sessionOf(tab), settings, { relayEndpoint: endpoint })
      })
    }

    // 不再需要中继（改成直连/其它代理）：先把旧中继关掉，再写 session。
    const release = typeof options.releaseSocksRelay === 'function'
      ? Promise.resolve(options.releaseSocksRelay(tab))
      : Promise.resolve()
    return release.then(() => apply(sessionOf(tab), settings, {}))
  })
}

module.exports = {
  PROXY_FIELDS,
  proxyPresetOf,
  sanitizeProxyPart,
  parseProxyHostLine,
  splitHostPort,
  proxyTargetOf,
  proxyAuthOf,
  proxyRulesOf,
  proxySettingsOf,
  proxyFieldsChanged,
  sessionOf,
  applySessionProxy,
  applyTabProxy
}
