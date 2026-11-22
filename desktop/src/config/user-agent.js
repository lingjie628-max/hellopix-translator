'use strict'

/**
 * 客页 User-Agent。
 *
 * Google 会拒绝“看起来像 Chrome、但实际上没有应用标识”的嵌入式浏览器。
 * 这里使用当前 Electron 内核的真实 Chromium 版本，并保留 Hello Pix 与
 * Electron 标识。既让网页知道这是哪个应用，也避免 Windows 用户被伪装成
 * macOS Chrome 这种明显不一致的 UA 触发风控。
 */
function cleanVersion(value, fallback) {
  const text = String(value || '').trim()
  return /^[0-9A-Za-z._-]+$/.test(text) ? text : fallback
}

function buildUserAgent(input) {
  const opts = input || {}
  const platform = String(opts.platform || 'darwin')
  const appVersion = cleanVersion(opts.appVersion, '0.0.0')
  const electronVersion = cleanVersion(opts.electronVersion, '0.0.0')
  const chromeVersion = cleanVersion(opts.chromeVersion, '0.0.0')
  const system = platform === 'win32'
    ? 'Windows NT 10.0; Win64; x64'
    : platform === 'linux'
      ? 'X11; Linux x86_64'
      : 'Macintosh; Intel Mac OS X 10_15_7'
  return 'Mozilla/5.0 (' + system + ') AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'HelloPix/' + appVersion + ' Chrome/' + chromeVersion +
    ' Electron/' + electronVersion + ' Safari/537.36'
}

module.exports = { buildUserAgent, cleanVersion }
