'use strict'

/**
 * TRON（TRC20）地址校验。
 *
 * 为什么不能只用正则：TRC20 地址是 Base58Check 编码，正则只能保证"看起来像"。
 * 收款地址填错的后果是**资金永久丢失、无法追回**，所以这里做完整校验：
 *   1. 长度 34、以 T 开头、Base58 字符集
 *   2. Base58 解码后必须是 25 字节（1 字节版本 + 20 字节地址 + 4 字节校验和）
 *   3. 版本字节必须是 0x41（TRON 主网）
 *   4. 校验和 = 对前 21 字节做两次 SHA-256 后取前 4 字节
 *
 * 校验和能挡掉绝大多数手误（改一个字符就会失败）。剩下 1/2^32 的概率
 * 是"另一个合法地址"，这种情况任何软件都无能为力，只能靠人工核对。
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Decode(text) {
  let num = 0n
  for (const ch of text) {
    const idx = ALPHABET.indexOf(ch)
    if (idx < 0) return null
    num = num * 58n + BigInt(idx)
  }
  const bytes = []
  while (num > 0n) {
    bytes.unshift(Number(num % 256n))
    num /= 256n
  }
  // 前导 '1' 对应前导零字节
  for (const ch of text) {
    if (ch === '1') bytes.unshift(0)
    else break
  }
  return Buffer.from(bytes)
}

/** @returns {boolean} 是否为合法的 TRON 主网地址 */
function validTronAddress(value) {
  const address = String(value || '').trim()
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false

  const crypto = require('crypto')
  const raw = base58Decode(address)
  if (!raw || raw.length !== 25) return false

  const payload = raw.subarray(0, 21)
  if (payload[0] !== 0x41) return false // TRON 主网前缀

  const first = crypto.createHash('sha256').update(payload).digest()
  const second = crypto.createHash('sha256').update(first).digest()
  return second.subarray(0, 4).equals(raw.subarray(21))
}

/** 规范化：仅去空白并保持原样（TRON 地址区分大小写，不可转小写） */
function normalizeTronAddress(value) {
  return String(value || '').trim()
}

module.exports = { validTronAddress, normalizeTronAddress, base58Decode }
