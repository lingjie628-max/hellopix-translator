'use strict'

/**
 * ★ 更新清单的 minVersion 不能被驼峰化吃掉 ★
 *
 * ## 事故形态（2026-10-26 发 1.2.6 时发现）
 *
 * 库里 client_releases.min_version = '1.2.0'，但 /client/update 签出来的
 * 清单里 minVersion 是 '1.2.6'。
 *
 * 链路：
 *
 *   repo.query(...)            → 原始行，字段是 min_version
 *   mapRow(row)                → 驼峰化，字段变成 minVersion（min_version 消失）
 *   catalog.publicRelease(row) → **只读 row.min_version** → undefined → ''
 *   buildManifest(row, ...)    → minVersion: row.min_version || row.minVersion || row.version
 *                              → '' 是 falsy，跳过；row.minVersion 已经是 ''，
 *                                也是 falsy；→ 退回 row.version（1.2.6）
 *
 * 客户端 `verify-release.js` 用 minVersion 做防降级自检
 * （`compareVersions(version, minVersion) < 0` 就拒绝），所以语义被悄悄改掉：
 * 声明"最低兼容 1.2.0"变成了"最低必须 1.2.6"。
 *
 * ## 为什么原测试没抓到
 *
 * test/update-signing-server.test.js 是**直接构造 `{ min_version: '1.2.0' }`**
 * 调 buildManifest 的，把中间那一层整个跳过了。测试验的是"buildManifest 认
 * min_version"，而线上实际传给它的是驼峰对象 —— 测的和跑的不是同一条路。
 *
 * 这个用例走完整链路：原始 SQL 行 → mapRow → publicRelease → buildManifest。
 */

const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')

const { mapRow } = require('../server/repositories/production-repository')
const catalog = require('../server/lib/client-catalog')
const { buildManifest } = require('../server/lib/update-signing')

function keyPairPem () {
  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
}

/** 一条典型的 client_releases 原始行（SQL 取出来的样子） */
function rawRow (over) {
  return Object.assign({
    id: 124,
    release_group: 'desktop',
    title: 'Hello Pix 1.2.6',
    os: 'Windows',
    arch: 'x64',
    app: 'com.hellopix.desktop',
    version: '1.2.6',
    url: 'https://pixfanyi.com/downloads/HelloPix-Setup-1.2.6.exe',
    enabled: true,
    note: '',
    sha256: 'a'.repeat(64),
    signature: null,
    min_version: '1.2.0'
  }, over)
}

test('★ 全链路：原始行的 min_version 必须原样出现在签名清单的 minVersion 里', () => {
  const env = { UPDATE_SIGNING_KEY: keyPairPem() }
  const mapped = mapRow(rawRow())
  const listed = catalog.publicRelease(mapped)
  assert.equal(listed.minVersion, '1.2.0', 'publicRelease 把 min_version 丢了（驼峰化后叫 minVersion）')

  const manifest = buildManifest(listed, { appId: 'com.hellopix.desktop', channel: 'stable', env })
  assert.ok(manifest, '应能签出清单')
  assert.equal(manifest.minVersion, '1.2.0',
    '签名清单的 minVersion 变成了 ' + manifest.minVersion + '，库里是 1.2.0')
})

test('驼峰行（minVersion）直接喂给 publicRelease 也不能丢', () => {
  const listed = catalog.publicRelease({
    releaseGroup: 'desktop', os: 'macos', arch: 'arm64', app: 'com.hellopix.desktop',
    version: '1.2.6', url: 'https://pixfanyi.com/downloads/x.dmg', enabled: true,
    sha256: 'b'.repeat(64), minVersion: '1.2.0'
  })
  assert.equal(listed.minVersion, '1.2.0')
})

test('真的没有下限时，才退回本次版本号（这条是原意，别一起修坏）', () => {
  const env = { UPDATE_SIGNING_KEY: keyPairPem() }
  const mapped = mapRow(rawRow({ min_version: null }))
  const manifest = buildManifest(catalog.publicRelease(mapped), { env })
  assert.equal(manifest.minVersion, '1.2.6', '没声明下限时应退回本次版本号，禁止降级')
})
