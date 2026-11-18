'use strict'

/**
 * `/apis/client/update` 必须返回**版本号最高**的那条可用记录。
 *
 * ## 事故（2026-10-26）
 *
 * 库里已经发布了 1.2.6（三条全 enabled），但客户端点「检查更新」显示
 * 「当前已是最新版本」，停在 1.2.1 不动。用真实库数据复现，`usable` 是：
 *
 *     usable = 124:1.2.6:s4, 118:1.2.4:s4, 116:1.2.3:s4, 111:1.2.2:s4, 110:1.2.1:s5
 *                                                                         ↑ 赢了
 *
 * 两个独立缺陷叠在一起：
 *
 *   1. `score()` 里 `if (!row.app) points += 1` —— 老记录（1.2.1，发布脚本
 *      当时还没写 app 字段）比新记录多 1 分，直接把旧版顶到第一位；
 *   2. `RELEASE_GROUPS` 里没有 `desktop`，而发布脚本从 1.2.2 起一直写
 *      `release_group='desktop'`，`groupId()` 把它归一成空串 —— 这既让
 *      缺陷 1 判据失真，也让后台分组列显示空白。
 *
 * 修法有两层，测试也分两层：`score` 不能压过版本号（这里用真数据锁住），
 * 以及 `desktop` 必须被识别成合法分组（catalog 那层）。
 */

const assert = require('node:assert/strict')
const test = require('node:test')
const catalog = require('../server/lib/client-catalog')
const { CoreService } = require('../server/services/core-service')

/** 线上 1.2.x 那批记录的原样快照（字段取自 2026-10-26 的 client_releases）。 */
const LIVE_ROWS = [
  { id: 126, version: '1.2.6', os: 'macos', arch: 'arm64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: true, url: 'https://pixfanyi.com/downloads/Hello%20Pix-1.2.6-arm64.dmg' },
  { id: 125, version: '1.2.6', os: 'macos', arch: 'x64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: true, url: 'https://pixfanyi.com/downloads/Hello%20Pix-1.2.6.dmg' },
  { id: 124, version: '1.2.6', os: 'Windows', arch: 'x64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: true, url: 'https://pixfanyi.com/downloads/HelloPix-Setup-1.2.6.exe' },
  { id: 123, version: '1.2.5', os: 'macos', arch: 'arm64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: false, url: 'https://pixfanyi.com/downloads/Hello%20Pix-1.2.5-arm64.dmg' },
  { id: 122, version: '1.2.5', os: 'macos', arch: 'x64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: false, url: 'https://pixfanyi.com/downloads/Hello%20Pix-1.2.5.dmg' },
  { id: 121, version: '1.2.5', os: 'windows', arch: 'x64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: false, url: 'https://pixfanyi.com/downloads/HelloPix-Setup-1.2.5.exe' },
  { id: 120, version: '1.2.4', os: 'macos', arch: 'arm64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: true, url: 'https://pixfanyi.com/downloads/Hello%20Pix-1.2.4-arm64.dmg' },
  { id: 119, version: '1.2.4', os: 'macos', arch: 'x64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: true, url: 'https://pixfanyi.com/downloads/Hello%20Pix-1.2.4.dmg' },
  { id: 118, version: '1.2.4', os: 'windows', arch: 'x64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: true, url: 'https://pixfanyi.com/downloads/HelloPix-Setup-1.2.4.exe' },
  { id: 117, version: '1.2.3', os: 'macOS', arch: 'x64', app: '', release_group: 'macos', enabled: true, url: 'https://pixfanyi.com/downloads/Hello%20Pix-1.2.3.dmg' },
  { id: 116, version: '1.2.3', os: 'Windows', arch: 'x64', app: '', release_group: 'windows', enabled: true, url: 'https://pixfanyi.com/downloads/HelloPix-Setup-1.2.3.exe' },
  { id: 115, version: '1.2.3', os: 'macOS', arch: 'arm64', app: '', release_group: 'macos', enabled: true, url: 'https://pixfanyi.com/downloads/Hello%20Pix-1.2.3-arm64.dmg' },
  { id: 113, version: '1.2.2', os: 'macOS', arch: 'arm64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: true, url: 'https://pixfanyi.com/downloads/Hello%20Pix-1.2.2-arm64.dmg' },
  { id: 112, version: '1.2.2', os: 'macOS', arch: 'x64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: true, url: 'https://pixfanyi.com/downloads/Hello%20Pix-1.2.2.dmg' },
  { id: 111, version: '1.2.2', os: 'Windows', arch: 'x64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: true, url: 'https://pixfanyi.com/downloads/HelloPix-Setup-1.2.2.exe' },
  // ★ 事故主角：唯一一条 app 为空的 Windows 记录，靠 +1 分压过了 1.2.6 ★
  { id: 110, version: '1.2.1', os: 'Windows', arch: 'x64', app: '', release_group: 'windows', enabled: true, url: 'https://pixfanyi.com/downloads/HelloPix-Setup-1.2.1.exe' },
  { id: 109, version: '1.2.1', os: 'macOS', arch: 'x64', app: '', release_group: 'macos', enabled: true, url: 'https://pixfanyi.com/downloads/HelloPix-1.2.1-x64.dmg' },
  { id: 108, version: '1.2.1', os: 'macOS', arch: 'arm64', app: '', release_group: 'macos', enabled: true, url: 'https://pixfanyi.com/downloads/HelloPix-1.2.1-arm64.dmg' }
]

function makeCore(rows) {
  return new CoreService({
    async settings() { return {} },
    async query(sql) {
      if (/FROM client_releases/.test(sql)) {
        // 与线上 SQL 一致：按创建时间倒序，**不是**按版本号
        return { rows }
      }
      return { rows: [] }
    }
  }, { get() {}, set() {} }, {})
}

test('findUpdate 必须按版本号选包，不能被空 app 的旧记录顶掉（事故复现）', async () => {
  const core = makeCore(LIVE_ROWS)

  const win = await core.findUpdate({ os: 'win32', arch: 'x64' })
  assert.equal(win.version, '1.2.6', '★ Windows 必须拿到 1.2.6，而不是 app 为空的 1.2.1')
  assert.match(win.url, /HelloPix-Setup-1\.2\.6\.exe$/)

  const macX64 = await core.findUpdate({ os: 'darwin', arch: 'x64' })
  assert.equal(macX64.version, '1.2.6')
  assert.match(macX64.url, /Hello%20Pix-1\.2\.6\.dmg$/)

  const macArm = await core.findUpdate({ os: 'darwin', arch: 'arm64' })
  assert.equal(macArm.version, '1.2.6')
  assert.match(macArm.url, /Hello%20Pix-1\.2\.6-arm64\.dmg$/)
})

test('客户端带 app 参数时同样选最高版本', async () => {
  const core = makeCore(LIVE_ROWS)
  const r = await core.findUpdate({ os: 'win32', arch: 'x64', app: 'com.hellopix.desktop' })
  assert.equal(r.version, '1.2.6')
})

test('禁用的版本不参与选包（1.2.5 全禁用，不能漏出去）', async () => {
  const core = makeCore(LIVE_ROWS)
  for (const [os, arch] of [['win32', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64']]) {
    const r = await core.findUpdate({ os, arch })
    assert.notEqual(r.version, '1.2.5', `${os}/${arch} 拿到了已禁用的 1.2.5`)
  }
})

test('desktop 是发布脚本实际在写的分组，必须被识别（否则归一成空串）', () => {
  assert.equal(catalog.groupId('desktop'), 'desktop',
    '★ 发布脚本硬编码 release_group=desktop，不在 RELEASE_GROUPS 里就会被归一成空串')
  assert.equal(catalog.groupId('Desktop'), 'desktop', '大小写不敏感')
  assert.ok(catalog.groupLabel('desktop'), '分组列要有可读名字，不能显示空白')
})

test('compareVersions 按数字段比较，不是字符串比较', () => {
  assert.ok(catalog.compareVersions('1.10.0', '1.9.0') > 0, "'1.10.0' 比 '1.9.0' 新")
  assert.ok(catalog.compareVersions('1.2.6', '1.2.1') > 0)
  assert.equal(catalog.compareVersions('1.2.6', '1.2.6'), 0)
  assert.equal(catalog.compareVersions('v1.2.6', '1.2.6'), 0, '前缀 v 不影响')
  assert.ok(catalog.compareVersions('1.2.1', '1.3.0') < 0, '数字大不代表新')
})
