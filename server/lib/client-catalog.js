'use strict'

// 独立应用是 Hello Pix 自己的单应用翻译壳，不是 Signal/Telegram 官方安装包。
// client_releases.app 必须对齐 desktop/platforms.js 的 id（如 signal、telegram-z）。
const platforms = require('../../desktop/platforms')

const RELEASE_GROUPS = Object.freeze([
  { id: 'windows', label: 'Windows' },
  { id: 'macos', label: 'macOS' },
  { id: 'android', label: 'Android' },
  { id: 'ios', label: 'iOS' },
  { id: 'standalone', label: '独立应用' },
  { id: 'counter', label: '计数器' }
])

const STANDALONE_APPS = Object.freeze(
  platforms
    .filter(item => !item.customUrl && item.id !== 'tickets' && item.id !== 'pm-office')
    .map(item => Object.freeze({ id: item.id, name: item.name }))
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

function packageAllowsStandalone(clients) {
  if (!clients || typeof clients !== 'object') return false
  return clients.standalone === true || Number(clients.standalone) === 1
}

module.exports = {
  RELEASE_GROUPS,
  STANDALONE_APPS,
  groupId,
  groupLabel,
  isStandaloneApp,
  hasPublicUrl,
  publicRelease,
  adminRelease,
  packageAllowsStandalone
}
