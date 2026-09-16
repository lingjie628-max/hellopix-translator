'use strict'

// 厂商密钥落盘加密的测试。
// 重点：没配密钥时**拒绝保存**，解密失败时**视为未配置**（fail-closed），
// 绝不能出现"解不出来就当明文用"或"密文回传前端"这类事故。

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')
const credentials = require('../server/lib/credentials')

const KEY = crypto.randomBytes(32)

function withKey(value, run) {
  const saved = process.env.PIX_CREDENTIAL_KEY
  if (value === undefined) delete process.env.PIX_CREDENTIAL_KEY
  else process.env.PIX_CREDENTIAL_KEY = value
  try {
    return run()
  } finally {
    if (saved === undefined) delete process.env.PIX_CREDENTIAL_KEY
    else process.env.PIX_CREDENTIAL_KEY = saved
  }
}

test('secret round-trips with a configured key', () => {
  withKey(KEY.toString('hex'), () => {
    const cipher = credentials.encryptSecret('deepseek-app-secret')
    assert.ok(Buffer.isBuffer(cipher))
    assert.ok(!cipher.includes(Buffer.from('deepseek-app-secret')), '密文里不得出现明文')
    assert.equal(credentials.decryptSecret(cipher), 'deepseek-app-secret')
    // 同样的明文两次加密应得到不同密文（随机 IV）
    assert.notEqual(credentials.encryptSecret('x').toString('hex'), credentials.encryptSecret('x').toString('hex'))
  })
})

test('base64 encoded key is accepted too', () => {
  withKey(KEY.toString('base64'), () => {
    assert.equal(credentials.decryptSecret(credentials.encryptSecret('中文密钥 ok')), '中文密钥 ok')
  })
})

test('saving is refused when no key is configured', () => {
  withKey(undefined, () => {
    assert.equal(credentials.credentialsKeyReady(), false)
    assert.throws(() => credentials.encryptSecret('secret'), /PIX_CREDENTIAL_KEY/)
  })
})

test('wrong-length key is rejected rather than silently used', () => {
  withKey('abcd', () => {
    assert.equal(credentials.credentialsKeyReady(), false)
    assert.throws(() => credentials.encryptSecret('secret'), /32 字节/)
  })
  withKey('ab'.repeat(31), () => { // 31 字节
    assert.throws(() => credentials.encryptSecret('secret'), /32 字节/)
  })
})

test('decryption failures degrade to "no credential" instead of throwing', () => {
  const cipher = withKey(KEY.toString('hex'), () => credentials.encryptSecret('secret'))

  // 换了密钥（轮换/部署不一致）-> 空串，通道被判为未配置
  withKey(crypto.randomBytes(32).toString('hex'), () => {
    assert.equal(credentials.decryptSecret(cipher), '')
  })
  // 未配置密钥 -> 空串
  withKey(undefined, () => {
    assert.equal(credentials.decryptSecret(cipher), '')
  })
  // 数据被截断/损坏 -> 空串
  withKey(KEY.toString('hex'), () => {
    assert.equal(credentials.decryptSecret(cipher.subarray(0, 20)), '')
    assert.equal(credentials.decryptSecret(Buffer.from('not-a-cipher')), '')
    assert.equal(credentials.decryptSecret(null), '')
    assert.equal(credentials.decryptSecret(undefined), '')
  })
})

test('ciphertext carries an integrity tag that tampering breaks', () => {
  withKey(KEY.toString('hex'), () => {
    const cipher = credentials.encryptSecret('secret')
    const tampered = Buffer.from(cipher)
    tampered[tampered.length - 1] ^= 0xff
    assert.equal(credentials.decryptSecret(tampered), '', 'GCM 校验失败必须拒绝解密')
  })
})
