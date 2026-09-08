'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const catalog = require('../server/lib/client-catalog')
const { CoreService } = require('../server/services/core-service')

test('standalone catalog uses platforms.js ids and rejects custom pages', () => {
  assert.equal(catalog.isStandaloneApp('signal'), true)
  assert.equal(catalog.isStandaloneApp('telegram-z'), true)
  assert.equal(catalog.isStandaloneApp('whatsapp-green'), true)
  assert.equal(catalog.isStandaloneApp('custom-web'), false)
  assert.equal(catalog.isStandaloneApp('tickets'), false)
  assert.equal(catalog.isStandaloneApp('pm-office'), false)
  assert.equal(catalog.groupId('独立应用'), 'standalone')
  assert.equal(catalog.groupLabel('standalone'), '独立应用')
})

test('package entitlement only opens standalone when clients.standalone is set', () => {
  assert.equal(catalog.packageAllowsStandalone({ standalone: true, mobile: true }), true)
  assert.equal(catalog.packageAllowsStandalone({ standalone: 1 }), true)
  assert.equal(catalog.packageAllowsStandalone({ standalone: false, mobile: true }), false)
  assert.equal(catalog.packageAllowsStandalone({}), false)
  assert.equal(catalog.packageAllowsStandalone(null), false)
})

test('public catalog hides empty, unpublished and non-https download urls', async () => {
  const rows = [
    { id: 1, release_group: 'windows', title: 'Windows 客户端', os: 'Windows', arch: '64位', app: '', version: '1.0.0', url: 'https://cdn.example.com/win.exe', enabled: true },
    { id: 2, release_group: 'standalone', title: 'Signal 翻译客户端', os: '桌面', arch: '', app: 'signal', version: '1.0.0', url: '', enabled: false },
    { id: 3, release_group: '独立应用', title: 'Telegram 翻译桌面版', os: '桌面', arch: '', app: 'telegram-z', version: '1.0.0', url: 'https://cdn.example.com/tg.dmg', enabled: true },
    { id: 4, release_group: 'standalone', title: '不安全包', os: '桌面', arch: '', app: 'signal', version: '2.0.0', url: 'http://insecure.example/x', enabled: true }
  ]
  const core = new CoreService({
    async settings() {
      return {
        'site.name': 'Hello Pix',
        'downloads.client_url': '',
        'billing.discounts': {},
        'support.visible': true
      }
    },
    async query(sql) {
      if (/FROM client_lines/.test(sql)) return { rows: [] }
      if (/FROM client_releases/.test(sql)) return { rows }
      throw new Error(`Unexpected SQL: ${sql}`)
    }
  }, { get() {}, set() {} }, {})
  const info = await core.siteInfo()
  assert.equal(info.clientDownloads.windows, 'https://cdn.example.com/win.exe')
  assert.equal(info.clientDownloads.standalone, 'https://cdn.example.com/tg.dmg')
  assert.equal(info.clientDownloads.standaloneApps.length, 1)
  assert.equal(info.clientDownloads.standaloneApps[0].app, 'telegram-z')
  assert.equal(info.clientDownloads.standaloneApps[0].releaseGroup, 'standalone')
  assert.ok(!info.clientDownloads.standaloneApps.some(item => item.app === 'signal'))
})

test('main shell updates never pick standalone packages unless app is set', async () => {
  const rows = [
    { id: 1, release_group: 'standalone', title: 'Signal 翻译客户端', os: 'macOS', arch: 'Apple 芯片', app: 'signal', version: '9.9.9', url: 'https://cdn.example.com/signal.dmg', enabled: true },
    { id: 2, release_group: 'macos', title: 'Hello Pix', os: 'macOS', arch: 'Apple 芯片', app: '', version: '1.2.0', url: 'https://cdn.example.com/pix.dmg', enabled: true }
  ]
  const core = new CoreService({
    async settings() { return { 'downloads.client_url': 'https://cdn.example.com/fallback.dmg' } },
    async query() { return { rows } }
  }, { get() {}, set() {} }, {})
  const shell = await core.findUpdate({ os: 'darwin', arch: 'arm64' })
  assert.equal(shell.version, '1.2.0')
  assert.equal(shell.url, 'https://cdn.example.com/pix.dmg')
  const standalone = await core.findUpdate({ os: 'darwin', arch: 'arm64', app: 'signal' })
  assert.equal(standalone.version, '9.9.9')
  assert.equal(standalone.app, 'signal')
  assert.equal(standalone.url, 'https://cdn.example.com/signal.dmg')
})

test('profile exposes standaloneClient from the current package', () => {
  const core = new CoreService({ query() {} }, { get() {}, set() {} }, {})
  const allowed = core.profile({
    kind: 'main',
    account: { id: 1, username: 'alice', charBalance: 10 },
    parent: { id: 1, packageTitle: '基础版', packageId: 1, packageClients: { standalone: true }, enterprise: false }
  })
  const denied = core.profile({
    kind: 'main',
    account: { id: 2, username: 'bob', charBalance: 10 },
    parent: { id: 2, packageTitle: '试用', packageId: 2, packageClients: { standalone: false }, enterprise: false }
  })
  assert.equal(allowed.standaloneClient, 1)
  assert.equal(denied.standaloneClient, 0)
})

test('saving a standalone release requires a platforms.js app id and https when enabled', async () => {
  const core = new CoreService({ query() {} }, { get() {}, set() {} }, {})
  await assert.rejects(
    core.saveClientRelease({ group: '独立应用', title: 'Signal', app: 'custom-web', url: 'https://cdn.example.com/x', enabled: 1 }),
    error => error.code === 'BAD_STANDALONE_APP'
  )
  await assert.rejects(
    core.saveClientRelease({ group: '独立应用', title: 'Signal', app: 'signal', url: '', enabled: 1 }),
    error => error.code === 'DOWNLOAD_URL_REQUIRED'
  )
  await assert.rejects(
    core.saveClientRelease({ group: '独立应用', title: 'Signal', app: 'signal', url: 'http://cdn.example.com/x', enabled: 0 }),
    error => error.code === 'BAD_DOWNLOAD_URL'
  )
})
