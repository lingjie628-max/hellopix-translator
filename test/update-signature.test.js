'use strict'

/**
 * 更新清单签名校验。
 *   node --test test/update-signature.test.js
 *
 * ## 为什么要有这组测试
 *
 * 更新通道是唯一能给**所有用户**推代码执行的通道。它现在只有一道域名
 * 白名单（`DOWNLOAD_HOSTS`），而白名单防不住「服务端被攻破、在白名单
 * 域名上换一个恶意包」—— 那时 URL 完全合法。
 *
 * 加了 Ed25519 验签之后，安全性完全依赖「验签真的会拒绝」。而验签最典型
 * 的失效方式不是抛错，是**静默通过**：字段顺序变了、公钥没注入、
 * 版本比较用字符串……任何一种都会让校验形同虚设，且看不出异常。
 *
 * 所以这里每一条都构造一个「应该被拒绝」的真实攻击形态。
 *
 * ## 测试里为什么自己生成密钥
 *
 * 内置公钥是占位符（正式密钥在构建机上）。测试用自己的临时密钥对，
 * 通过 `publicKeys` 注入 —— 这样即使正式公钥换了，测试也不需要改。
 */

const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')

const {
  manifestPayload,
  verifySignature,
  parsePublicKey,
  compareVersions
} = require('../desktop/src/update/signature')
const {
  resolveRelease,
  validateManifest
} = require('../desktop/src/update/verify-release')

const APP_ID = 'com.hellopix.desktop'

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' })
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' })

function signManifest (manifest) {
  const signature = crypto.sign(null, manifestPayload(manifest), PRIVATE_PEM)
  return Object.assign({}, manifest, { signature: signature.toString('base64') })
}

function baseManifest (patch) {
  return Object.assign({
    appId: APP_ID,
    version: '1.3.0',
    url: 'https://pixfanyi.com/downloads/HelloPix-Setup-1.3.0.exe',
    sha256: 'a'.repeat(64),
    channel: 'stable',
    minVersion: '1.2.0'
  }, patch || {})
}

function silentLogger () {
  const lines = []
  const fn = (level, channel, msg) => lines.push([level, channel, msg])
  fn.lines = lines
  return fn
}

/* ==========================================================================
 * 签名原文
 * ========================================================================== */

test('签名原文是固定字段顺序、换行分隔，不是 JSON', () => {
  const payload = manifestPayload(baseManifest()).toString('utf8')
  assert.deepEqual(payload.split('\n'), [
    APP_ID,
    '1.3.0',
    'https://pixfanyi.com/downloads/HelloPix-Setup-1.3.0.exe',
    'a'.repeat(64),
    'stable',
    '1.2.0'
  ])
})

test('字段顺序参与签名：改动顺序必须导致验签失败', () => {
  const manifest = signManifest(baseManifest())
  // 模拟「有人把字段顺序调整了一下」—— 语义没变但原文变了
  const swapped = Buffer.from([
    manifest.version,
    manifest.appId,
    manifest.url,
    manifest.sha256,
    manifest.channel,
    manifest.minVersion
  ].join('\n'))
  assert.throws(
    () => verifySignature(swapped, manifest.signature, [PUBLIC_PEM]),
    /验签失败|签名/
  )
})

/* ==========================================================================
 * 正常路径
 * ========================================================================== */

test('合法清单通过', () => {
  const release = validateManifest(signManifest(baseManifest()), {
    appId: APP_ID,
    currentVersion: '1.2.1',
    channel: 'stable',
    publicKeys: [PUBLIC_PEM]
  })
  assert.equal(release.version, '1.3.0')
  assert.equal(release.sha256, 'a'.repeat(64))
})

/* ==========================================================================
 * 攻击形态：每一种都必须被拒绝
 * ========================================================================== */

test('篡改下载地址（指向恶意包）后拒绝', () => {
  const manifest = signManifest(baseManifest())
  manifest.url = 'https://pixfanyi.com/downloads/evil.exe'
  assert.throws(() => validateManifest(manifest, {
    appId: APP_ID, currentVersion: '1.2.1', publicKeys: [PUBLIC_PEM]
  }), /签名/)
})

test('篡改 sha256（换成攻击者的包）后拒绝', () => {
  const manifest = signManifest(baseManifest())
  manifest.sha256 = 'b'.repeat(64)
  assert.throws(() => validateManifest(manifest, {
    appId: APP_ID, currentVersion: '1.2.1', publicKeys: [PUBLIC_PEM]
  }), /签名/)
})

test('把清单改成别的 appId 后拒绝', () => {
  const manifest = signManifest(baseManifest())
  manifest.appId = 'com.other.app'
  assert.throws(() => validateManifest(manifest, {
    appId: APP_ID, currentVersion: '1.2.1', publicKeys: [PUBLIC_PEM]
  }), /签名/)
})

test('攻击者用自己的密钥重签后拒绝', () => {
  const attacker = crypto.generateKeyPairSync('ed25519')
  const manifest = baseManifest({ url: 'https://pixfanyi.com/downloads/evil.exe' })
  const forged = crypto.sign(null, manifestPayload(manifest), attacker.privateKey)
  assert.throws(() => validateManifest(
    Object.assign({}, manifest, { signature: forged.toString('base64') }),
    { appId: APP_ID, currentVersion: '1.2.1', publicKeys: [PUBLIC_PEM] }
  ), /签名|验签/)
})

test('重放一份签名合法但版本更旧的清单（降级攻击）被拒绝', () => {
  // 攻击者手里有一份 1.2.0 的合法清单，漏洞已在 1.2.1 修复。
  // 签名完全有效 —— 只有版本判断能挡住它。
  const old = signManifest(baseManifest({ version: '1.2.0', minVersion: '1.2.0' }))
  assert.throws(() => validateManifest(old, {
    appId: APP_ID, currentVersion: '1.2.1', publicKeys: [PUBLIC_PEM]
  }), /降级/)
})

test('通道不匹配被拒绝（stable 清单不能推给 beta 客户端）', () => {
  const manifest = signManifest(baseManifest({ channel: 'stable' }))
  assert.throws(() => validateManifest(manifest, {
    appId: APP_ID, currentVersion: '1.2.1', channel: 'beta', publicKeys: [PUBLIC_PEM]
  }), /通道/)
})

test('签名被截断后拒绝', () => {
  const manifest = signManifest(baseManifest())
  const truncated = Buffer.from(manifest.signature, 'base64').subarray(0, 32).toString('base64')
  assert.throws(() => verifySignature(manifestPayload(manifest), truncated, [PUBLIC_PEM]), /长度/)
})

test('签名是空串时拒绝', () => {
  assert.throws(
    () => verifySignature(manifestPayload(baseManifest()), '', [PUBLIC_PEM]),
    /长度/
  )
})

/* ==========================================================================
 * 公钥本身
 * ========================================================================== */

test('没有公钥时拒绝一切清单（安全默认，不是放行）', () => {
  assert.throws(
    () => verifySignature(manifestPayload(baseManifest()), 'x'.repeat(88), []),
    /未内置更新公钥/
  )
})

test('公钥不是 Ed25519 时拒绝，而不是静默降级', () => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const rsaPem = rsa.publicKey.export({ type: 'spki', format: 'pem' })
  assert.throws(() => parsePublicKey(rsaPem), /ed25519/)
})

test('公钥轮换：新旧两把都能验', () => {
  const next = crypto.generateKeyPairSync('ed25519')
  const nextPem = next.publicKey.export({ type: 'spki', format: 'pem' })
  const manifest = signManifest(baseManifest())

  // 旧钥签的清单，新客户端配了 [新钥, 旧钥] 也能过
  assert.equal(
    verifySignature(manifestPayload(manifest), manifest.signature, [nextPem, PUBLIC_PEM]),
    true
  )
  // 只有新钥时过不了 —— 证明确实在逐把尝试，而不是只看第一把
  assert.throws(
    () => verifySignature(manifestPayload(manifest), manifest.signature, [nextPem]),
    /验签|签名/
  )
})

/* ==========================================================================
 * resolveRelease：三种状态
 * ========================================================================== */

test('服务端带签名清单 → hardened', () => {
  const log = silentLogger()
  const result = resolveRelease({ success: true, manifest: signManifest(baseManifest()) }, {
    appId: APP_ID, currentVersion: '1.2.1', channel: 'stable', publicKeys: [PUBLIC_PEM], logger: log
  })
  assert.equal(result.status, 'hardened')
  assert.equal(result.remote, '1.3.0')
  assert.equal(result.sha256, 'a'.repeat(64))
})

test('服务端没清单 + 允许降级 → legacy，并留痕', () => {
  const log = silentLogger()
  const result = resolveRelease({ success: true, version: '1.3.0', url: 'https://pixfanyi.com/x.exe' }, {
    appId: APP_ID, currentVersion: '1.2.1', allowLegacy: true, logger: log
  })
  assert.equal(result.status, 'legacy')
  assert.equal(result.remote, '1.3.0')
  assert.ok(log.lines.some(line => line[0] === 'warn'), '降级必须在日志里留痕')
})

test('服务端没清单 + 不允许降级 → rejected（不给下载地址）', () => {
  const result = resolveRelease({ success: true, version: '1.3.0', url: 'https://pixfanyi.com/x.exe' }, {
    appId: APP_ID, currentVersion: '1.2.1', allowLegacy: false, logger: silentLogger()
  })
  assert.equal(result.status, 'rejected')
  assert.equal(result.url, '')
})

test('清单验签失败 → rejected，且记 error 日志', () => {
  const log = silentLogger()
  const manifest = signManifest(baseManifest())
  manifest.url = 'https://pixfanyi.com/downloads/evil.exe'
  const result = resolveRelease({ success: true, manifest }, {
    appId: APP_ID, currentVersion: '1.2.1', publicKeys: [PUBLIC_PEM], logger: log
  })
  assert.equal(result.status, 'rejected')
  assert.equal(result.url, '')
  assert.ok(log.lines.some(line => line[0] === 'error'), '验签失败必须单独告警')
})

/* ==========================================================================
 * 版本比较
 * ========================================================================== */

test('版本比较按数字，不做字符串比较', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1, '1.10.0 必须大于 1.9.0')
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1)
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.2', '1.2.0'), 0)
  assert.equal(compareVersions('1.2.1', '1.2.0'), 1)
})

/* ==========================================================================
 * 严格开关：PIX_REQUIRE_SIGNED_UPDATE
 *
 * 文件头注释一直写着"降级模式可关闭"，但 2026-10-23 查代码时发现
 * 这个环境变量**根本没被读过** —— 运维以为设了就锁死，实际 legacy 照走。
 * 这几条就是防止它再次变成"注释里才存在"的功能。
 * ========================================================================== */

test('★ PIX_REQUIRE_SIGNED_UPDATE=1 时禁止降级', () => {
  // 服务端还没升级：没有清单，只有旧字段
  const data = { success: true, version: '1.3.0', url: 'https://pixfanyi.com/a.exe' }
  const base = { appId: APP_ID, currentVersion: '1.2.1' }

  const relaxed = resolveRelease(data, { ...base, allowLegacy: true, env: {} })
  assert.equal(relaxed.status, 'legacy', '没设开关时允许降级')

  const strict = resolveRelease(data, {
    ...base, allowLegacy: true, env: { PIX_REQUIRE_SIGNED_UPDATE: '1' }
  })
  assert.equal(strict.status, 'rejected', '设了开关就必须拒绝 —— 哪怕调用了 allowLegacy')
})

test('严格开关下 remote 仍然保留（界面要能说"有新版本但不可下载"）', () => {
  const result = resolveRelease(
    { success: true, version: '1.3.0', url: 'https://pixfanyi.com/a.exe' },
    { appId: APP_ID, currentVersion: '1.2.1', allowLegacy: true, env: { PIX_REQUIRE_SIGNED_UPDATE: '1' } }
  )
  assert.equal(result.remote, '1.3.0', '清掉 remote 会让界面谎报"已是最新"')
  assert.equal(result.url, '')
})

test('开关只认字面量 "1"（防止 "0"/"false" 被误当成开启）', () => {
  const data = { success: true, version: '1.3.0', url: 'https://pixfanyi.com/a.exe' }
  const base = { appId: APP_ID, currentVersion: '1.2.1', allowLegacy: true }
  for (const value of ['0', 'false', '', 'yes']) {
    assert.equal(resolveRelease(data, { ...base, env: { PIX_REQUIRE_SIGNED_UPDATE: value } }).status,
      'legacy', `PIX_REQUIRE_SIGNED_UPDATE=${JSON.stringify(value)} 不该开启严格模式`)
  }
})
