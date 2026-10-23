'use strict'

/**
 * 服务端更新清单签名。
 *   node --test test/update-signing-server.test.js
 *
 * ## 这组测试锁的是一条「两端必须一致」的契约
 *
 * 签名原文的字段顺序同时写在两处：
 *   · 服务端 server/lib/update-signing.js
 *   · 客户端 desktop/src/update/signature.js
 *
 * 任何一侧改动都会让**所有存量客户端**验签失败，而且是静默的 ——
 * 用户只会看到「检查更新失败」，没有任何线索指向字段顺序。
 *
 * 所以这里不只测"能签出来"，还直接拿客户端那份 `manifestPayload`
 * 去验服务端签出的东西。两边任何一处不一致，这里就红。
 */

const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')

const {
  MANIFEST_FIELDS,
  manifestPayload,
  parsePrivateKey,
  signManifest,
  buildManifest
} = require('../server/lib/update-signing')

const clientSignature = require('../desktop/src/update/signature')

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' })

function envWith (pem) {
  return { UPDATE_SIGNING_KEY: pem }
}

const ROW = {
  app: 'com.hellopix.desktop',
  version: '1.3.0',
  url: 'https://pixfanyi.com/downloads/HelloPix-Setup-1.3.0.exe',
  sha256: 'c'.repeat(64),
  min_version: '1.2.0'
}

/* ==========================================================================
 * 两端契约一致
 * ========================================================================== */

test('服务端与客户端的签名字段顺序完全一致', () => {
  assert.deepEqual(MANIFEST_FIELDS, clientSignature.MANIFEST_FIELDS)
})

test('服务端签出的清单，客户端那份 manifestPayload 能验过', () => {
  const manifest = signManifest({
    appId: 'com.hellopix.desktop',
    version: '1.3.0',
    url: ROW.url,
    sha256: ROW.sha256,
    channel: 'stable',
    minVersion: '1.2.0'
  }, envWith(PRIVATE_PEM))

  assert.ok(manifest.signature, '必须签出签名')

  // 关键：用**客户端**的实现重算原文并验签
  const ok = crypto.verify(
    null,
    clientSignature.manifestPayload(manifest),
    publicKey,
    Buffer.from(manifest.signature, 'base64')
  )
  assert.equal(ok, true, '两端原文不一致会让所有客户端更新失败')
})

test('客户端 verifySignature 也认服务端签的清单', () => {
  const manifest = signManifest({
    appId: 'com.hellopix.desktop',
    version: '1.3.0',
    url: ROW.url,
    sha256: ROW.sha256,
    channel: 'stable',
    minVersion: '1.2.0'
  }, envWith(PRIVATE_PEM))

  const pubPem = publicKey.export({ type: 'spki', format: 'pem' })
  assert.equal(
    clientSignature.verifySignature(clientSignature.manifestPayload(manifest), manifest.signature, [pubPem]),
    true
  )
})

/* ==========================================================================
 * 私钥处理
 * ========================================================================== */

test('没配私钥时不签名，buildManifest 返回 null（不发无签名清单）', () => {
  assert.equal(signManifest({ appId: 'x', version: '1', url: 'https://a/b.exe', sha256: 'd'.repeat(64) }, {}), null)
  assert.equal(buildManifest(ROW, { env: {} }), null)
})

test('私钥不是 Ed25519 时抛错，不静默降级', () => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const rsaPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' })
  assert.throws(() => parsePrivateKey(rsaPem), /ed25519/)
})

test('支持单行 base64 私钥（CI secret 常被折成一行）', () => {
  const der = privateKey.export({ type: 'pkcs8', format: 'der' })
  const single = der.toString('base64')
  const manifest = signManifest({
    appId: 'com.hellopix.desktop', version: '1.3.0', url: ROW.url,
    sha256: ROW.sha256, channel: 'stable', minVersion: '1.2.0'
  }, envWith(single))
  assert.ok(manifest.signature)
})

/* ==========================================================================
 * buildManifest 的准入条件
 * ========================================================================== */

test('记录没有 sha256 时不下发清单', () => {
  assert.equal(buildManifest(Object.assign({}, ROW, { sha256: '' }), { env: envWith(PRIVATE_PEM) }), null)
})

test('下载地址不是 https 时不下发清单', () => {
  assert.equal(buildManifest(Object.assign({}, ROW, { url: 'http://pixfanyi.com/x.exe' }), {
    env: envWith(PRIVATE_PEM)
  }), null)
})

test('没给 min_version 时退回本次版本号（禁止降级到更早）', () => {
  const manifest = buildManifest(Object.assign({}, ROW, { min_version: null }), { env: envWith(PRIVATE_PEM) })
  assert.equal(manifest.minVersion, '1.3.0')
})

test('signature 是 64 字节 base64', () => {
  const manifest = buildManifest(ROW, { env: envWith(PRIVATE_PEM) })
  assert.equal(Buffer.from(manifest.signature, 'base64').length, 64)
})

test('签出的清单字段完整，一个不缺', () => {
  const manifest = buildManifest(ROW, { env: envWith(PRIVATE_PEM) })
  for (const field of ['appId', 'version', 'url', 'sha256', 'channel', 'minVersion', 'signature']) {
    assert.ok(manifest[field], `缺少 ${field}`)
  }
})
