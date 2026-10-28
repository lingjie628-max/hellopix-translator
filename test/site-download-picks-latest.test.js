'use strict'

/**
 * 官网下载按钮必须指向**最新版本**的包。
 *
 * ## 事故（2026-10-26）
 *
 * 客户端自动更新已经修好、开始下发 1.2.7 了，但官网 `pixfanyi.com` 的
 * 下载按钮还停在 **1.2.3**。用户从官网手动下载，拿到的仍是旧包 ——
 * 自动更新推一个版本、官网发另一个版本，两条链路彻底脱节。
 *
 * ## 根因
 *
 * `siteInfo()` 里挑包用的是：
 *
 *     listed.filter(item => item.releaseGroup === group)   // group = 'windows' / 'macos'
 *
 * 而发布脚本从 1.2.2 起统一写 `release_group='desktop'`。于是：
 *
 *   · `desktop` 的记录在 group='windows' 的过滤里**一条都匹配不上**；
 *   · 唯一还能匹配上的，是 1.2.3 那批老记录（release_group 还是 windows/macos）；
 *   · 结果按钮永远跳回 1.2.3，而且**不会报错** —— 只是静默地发旧包。
 *
 * 修复：改成按 `os` 文本判断平台（与 findUpdate 同一套口径），再取版本最高。
 * 本测试锁住"取最高版本"和"desktop 分组也要认"两件事。
 */

const assert = require('node:assert/strict')
const test = require('node:test')
const { CoreService } = require('../server/services/core-service')

/** 线上记录快照：新版全是 desktop 分组，老版才是 windows/macos。 */
const ROWS = [
  { id: 129, version: '1.2.7', os: 'macos', arch: 'arm64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: true, url: 'https://pixfanyi.com/downloads/Hello%20Pix-1.2.7-arm64.dmg' },
  { id: 128, version: '1.2.7', os: 'macos', arch: 'x64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: true, url: 'https://pixfanyi.com/downloads/Hello%20Pix-1.2.7.dmg' },
  { id: 127, version: '1.2.7', os: 'Windows', arch: 'x64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: true, url: 'https://pixfanyi.com/downloads/HelloPix-Setup-1.2.7.exe' },
  { id: 124, version: '1.2.6', os: 'Windows', arch: 'x64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: true, url: 'https://pixfanyi.com/downloads/HelloPix-Setup-1.2.6.exe' },
  { id: 125, version: '1.2.6', os: 'macos', arch: 'x64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: true, url: 'https://pixfanyi.com/downloads/Hello%20Pix-1.2.6.dmg' },
  // ★ 事故里被误选的这批：分组是 windows/macos，版本却最旧 ★
  { id: 117, version: '1.2.3', os: 'macOS', arch: 'x64', app: '', release_group: 'macos', enabled: true, url: 'https://pixfanyi.com/downloads/Hello%20Pix-1.2.3.dmg' },
  { id: 116, version: '1.2.3', os: 'Windows', arch: 'x64', app: '', release_group: 'windows', enabled: true, url: 'https://pixfanyi.com/downloads/HelloPix-Setup-1.2.3.exe' }
]

function makeCore(rows) {
  return new CoreService({
    async settings() { return {} },
    async query(sql) {
      if (/FROM client_releases/.test(sql)) return { rows }
      if (/FROM client_lines/.test(sql)) return { rows: [] }
      return { rows: [] }
    }
  }, { get() {}, set() {} }, {})
}

test('★ 官网 Windows 下载按钮必须指向最新版（不能被 windows 分组的旧包抢走）', async () => {
  const info = await makeCore(ROWS).siteInfo({ arch: 'x64' })
  assert.match(info.clientDownloads.windows, /1\.2\.7/,
    `官网 Windows 按钮指向了旧版：${info.clientDownloads.windows}`)
  assert.match(info.clientDownloads.windows, /HelloPix-Setup-1\.2\.7\.exe$/)
})

test('★ 官网 macOS 下载按钮必须指向最新版', async () => {
  const info = await makeCore(ROWS).siteInfo({ arch: 'x64' })
  assert.match(info.clientDownloads.macos, /1\.2\.7/,
    `官网 macOS 按钮指向了旧版：${info.clientDownloads.macos}`)
})

test('主下载按钮跟架构走：Apple 芯片用户拿 arm64 最新版', async () => {
  const arm = await makeCore(ROWS).siteInfo({ arch: 'arm64' })
  assert.match(arm.clientDownloads.macos, /1\.2\.7-arm64\.dmg$/,
    'arm64 用户必须拿到 arm64 包，不能拿 x64')
  assert.match(arm.clientDownloadUrl, /1\.2\.7-arm64\.dmg$/)
})

test('主下载按钮跟架构走：Intel 用户拿 x64 最新版', async () => {
  const x64 = await makeCore(ROWS).siteInfo({ arch: 'x64' })
  assert.match(x64.clientDownloads.macos, /Hello%20Pix-1\.2\.7\.dmg$/,
    'x64 用户不能被推 arm64 包')
})

test('禁用的发布记录不出现在官网上', async () => {
  const withDisabled = ROWS.concat([
    { id: 200, version: '9.9.9', os: 'Windows', arch: 'x64', app: 'com.hellopix.desktop', release_group: 'desktop', enabled: false, url: 'https://pixfanyi.com/downloads/bad.exe' }
  ])
  const info = await makeCore(withDisabled).siteInfo({ arch: 'x64' })
  assert.doesNotMatch(info.clientDownloads.windows, /9\.9\.9/)
})

test('standalone 应用包不能被当成 Windows/macOS 主包', async () => {
  const withStandalone = ROWS.concat([
    { id: 300, version: '1.0.0', os: 'macOS', arch: 'arm64', app: 'zalo', release_group: 'standalone', enabled: true, url: 'https://pixfanyi.com/downloads/zalo.dmg' }
  ])
  const info = await makeCore(withStandalone).siteInfo({ arch: 'arm64' })
  assert.match(info.clientDownloads.macos, /Hello%20Pix-1\.2\.7/,
    'standalone 分组不该混进主下载按钮')
})
