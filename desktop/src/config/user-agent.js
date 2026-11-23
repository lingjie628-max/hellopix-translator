'use strict'

/**
 * 客页 User-Agent。
 *
 * WhatsApp Web 会按 UA 判断浏览器；在标准 Chrome 产品段里插入
 * `HelloPix/...` 或 `Electron/...` 会让部分页面把它识别成未知嵌入式
 * 浏览器，直接显示“请升级 Chrome 100+”。这里保留当前 Electron 内核的真实
 * Chromium 版本，但输出标准 Chrome UA，让能力判断回到实际内核版本。
 */
function cleanVersion(value, fallback) {
  const text = String(value || '').trim()
  return /^[0-9A-Za-z._-]+$/.test(text) ? text : fallback
}

function buildUserAgent(input) {
  const opts = input || {}
  const platform = String(opts.platform || 'darwin')
  const chromeVersion = cleanVersion(opts.chromeVersion, '0.0.0')
  const system = platform === 'win32'
    ? 'Windows NT 10.0; Win64; x64'
    : platform === 'linux'
      ? 'X11; Linux x86_64'
      : 'Macintosh; Intel Mac OS X 10_15_7'
  return 'Mozilla/5.0 (' + system + ') AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/' + chromeVersion + ' Safari/537.36'
}

module.exports = { buildUserAgent, cleanVersion }
