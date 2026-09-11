'use strict'

/**
 * 厂商密钥的落盘加解密（AES-256-GCM）。
 *
 * 设计取舍：
 *   - 密钥只从环境变量 PIX_CREDENTIAL_KEY 读（32 字节，64 位十六进制或 base64），
 *     绝不入库、绝不写日志、绝不回传给前端。
 *   - 保存时必须已配置该密钥，否则直接拒绝 —— 宁可保存失败，也不明文落库。
 *   - 解密失败（密钥轮换、数据损坏、未配置）一律返回空串，视为"该通道没有凭据"，
 *     由上层走 fail-closed：通道不会被认为可用，也就不会被计费。
 *   - 存储格式：iv(12) | authTag(16) | ciphertext，GCM 自带完整性校验。
 */

const crypto = require('node:crypto')

const KEY_ENV = 'PIX_CREDENTIAL_KEY'
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

function loadKey() {
  const raw = String(process.env[KEY_ENV] || '').trim()
  if (!raw) return null
  const key = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error(`${KEY_ENV} 必须是 32 字节（64 位十六进制或 base64 编码）`)
  }
  return key
}

/** 是否具备保存密钥的条件（前端/管理接口用来提示，不暴露密钥本身）。 */
function credentialsKeyReady() {
  try {
    return loadKey() !== null
  } catch (error) {
    return false
  }
}

function encryptSecret(plain) {
  const key = loadKey()
  if (!key) {
    throw new Error(`未配置 ${KEY_ENV}，拒绝保存厂商密钥（不得明文落库）`)
  }
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
}

function decryptSecret(payload) {
  if (!payload) return ''
  const key = loadKey()
  if (!key) return ''
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  if (buffer.length <= IV_LENGTH + TAG_LENGTH) return ''
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, buffer.subarray(0, IV_LENGTH))
    decipher.setAuthTag(buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH))
    return Buffer.concat([
      decipher.update(buffer.subarray(IV_LENGTH + TAG_LENGTH)),
      decipher.final()
    ]).toString('utf8')
  } catch (error) {
    return ''
  }
}

module.exports = { encryptSecret, decryptSecret, credentialsKeyReady, KEY_ENV }
