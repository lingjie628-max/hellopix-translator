const net = require('net')

const PLATFORM_DOMAINS = {
  'whatsapp-green': ['whatsapp.com'],
  'whatsapp-pro': ['whatsapp.com'],
  'telegram-z': ['telegram.org'],
  line: ['line.me', 'line-scdn.net'],
  'line-biz': ['line.biz', 'line.me', 'line-scdn.net'],
  instagram: ['instagram.com', 'facebook.com'],
  messenger: ['messenger.com', 'facebook.com'],
  facebook: ['facebook.com'],
  'facebook-page': ['facebook.com'],
  x: ['x.com', 'twitter.com'],
  linkedin: ['linkedin.com'],
  zalo: ['zalo.me'],
  tinder: ['tinder.com'],
  discord: ['discord.com'],
  tiktok: ['tiktok.com'],
  skype: ['skype.com', 'microsoft.com', 'live.com'],
  googlevoice: ['google.com'],
  'google-chat': ['google.com'],
  teams: ['microsoft.com', 'microsoftonline.com', 'live.com', 'office.com'],
  snapchat: ['snapchat.com'],
  openphone: ['openphone.com'],
  textnow: ['textnow.com'],
  textfree: ['textfree.us'],
  bip: ['bip.com'],
  quora: ['quora.com'],
  okcupid: ['okcupid.com'],
  secret: ['secret.com'],
  slack: ['slack.com'],
  deepseek: ['deepseek.com'],
  vk: ['vk.com'],
  band: ['band.us'],
  signal: ['signal.org'],
  'pm-office': ['hellowoorld.com']
}

/** 以内置 Chrome 扩展承载的平台：只放行该扩展自己的页面。 */
const PLATFORM_EXTENSION_IDS = {
  line: 'ophjlpahpchlmihnnnihgmmeilfjmjjc'
}

const SHARED_AUTH_DOMAINS = [
  'accounts.google.com',
  'appleid.apple.com',
  'login.live.com',
  'login.microsoftonline.com'
]

function csvHosts(value) {
  return String(value || '')
    .split(',')
    .map(host => host.trim().toLowerCase().replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)
}

function parseUrl(value) {
  try {
    return new URL(String(value || ''))
  } catch (e) {
    return null
  }
}

function hostMatches(host, allowed) {
  const current = String(host || '').toLowerCase().replace(/\.$/, '')
  return allowed.some(domain => current === domain || current.endsWith('.' + domain))
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (net.isIP(host) === 4) {
    const parts = host.split('.').map(Number)
    return parts[0] === 0 ||
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) ||
      parts[0] >= 224
  }
  if (net.isIP(host) === 6) {
    return host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:')
  }
  return false
}

function trustedApiHosts(defaultApi, extraHosts) {
  const parsed = parseUrl(defaultApi)
  const hosts = csvHosts(extraHosts)
  if (parsed && parsed.hostname) hosts.push(parsed.hostname.toLowerCase())
  return Array.from(new Set(hosts))
}

function validateApiUrl(value, options) {
  const opts = options || {}
  const parsed = parseUrl(value)
  if (!parsed || parsed.username || parsed.password || parsed.search || parsed.hash) return null
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  const loopback = hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost'
  if (parsed.protocol !== 'https:' && !(opts.development && loopback && parsed.protocol === 'http:')) return null
  if (isPrivateHost(hostname) && !(opts.development && loopback)) return null
  const allowed = opts.allowedHosts || []
  if (!loopback && (!allowed.length || !hostMatches(hostname, allowed))) return null
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.toString().replace(/\/+$/, '')
}

function isAllowedPlatformUrl(item, candidate, initialUrl) {
  const parsed = parseUrl(candidate)
  const initial = parseUrl(initialUrl)
  if (!parsed || parsed.username || parsed.password) return false
  if (item && item.extension) {
    const extId = PLATFORM_EXTENSION_IDS[item.extension]
    return !!extId && parsed.protocol === 'chrome-extension:' && parsed.hostname === extId
  }
  if (parsed.protocol !== 'https:' && !(item && item.id === 'tickets' && parsed.protocol === 'http:')) return false
  if (item && item.customUrl) return !!initial && parsed.origin === initial.origin
  if (item && item.id === 'tickets') return !!initial && parsed.origin === initial.origin
  const domains = (PLATFORM_DOMAINS[item && item.id] || []).concat(SHARED_AUTH_DOMAINS)
  return hostMatches(parsed.hostname, domains)
}

function isAllowedExternalUrl(value, allowedHosts) {
  const parsed = parseUrl(value)
  if (!parsed) return false
  if (parsed.protocol === 'tg:') return true
  return parsed.protocol === 'https:' && !isPrivateHost(parsed.hostname) && hostMatches(parsed.hostname, allowedHosts || [])
}

module.exports = {
  csvHosts,
  isPrivateHost,
  trustedApiHosts,
  validateApiUrl,
  isAllowedPlatformUrl,
  isAllowedExternalUrl,
  PLATFORM_EXTENSION_IDS
}
