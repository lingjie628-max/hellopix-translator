/**
 * TRC20 地址前端校验（与服务端 server/lib/tron-address.js 同一套逻辑）。
 *
 * 前端这份的意义是**即时反馈**：管理员粘贴地址时立刻能看出校验和是否匹配，
 * 而不是点了保存才被后端拒绝。服务端那份才是权威校验，两边都不能省。
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
  for (const ch of text) {
    if (ch === '1') bytes.unshift(0)
    else break
  }
  return Uint8Array.from(bytes)
}

/** 用 Web Crypto 做双 SHA-256，避免为了校验引入额外依赖 */
async function doubleSha256(bytes) {
  const subtle = window.crypto && window.crypto.subtle
  if (!subtle) return null
  const first = await subtle.digest('SHA-256', bytes)
  return new Uint8Array(await subtle.digest('SHA-256', first))
}

/**
 * 校验 TRC20 地址。
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function checkTronAddress(value) {
  const address = String(value || '').trim()
  if (!address) return { ok: false, reason: '地址为空' }
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
    if (!address.startsWith('T')) return { ok: false, reason: 'TRC20 地址必须以 T 开头' }
    if (address.length !== 34) return { ok: false, reason: `TRC20 地址应为 34 位，当前 ${address.length} 位` }
    return { ok: false, reason: '包含 Base58 不允许的字符（如 0、O、I、l）' }
  }
  const raw = base58Decode(address)
  if (!raw || raw.length !== 25) return { ok: false, reason: '地址长度不合法' }
  if (raw[0] !== 0x41) return { ok: false, reason: '不是 TRON 主网地址' }
  const digest = await doubleSha256(raw.subarray(0, 21))
  if (!digest) return { ok: false, reason: '浏览器不支持校验，请以保存时的服务端校验为准' }
  for (let i = 0; i < 4; i++) {
    if (digest[i] !== raw[21 + i]) {
      // 校验和不匹配几乎一定是复制时漏字/多字/改字
      return { ok: false, reason: '校验和不匹配 —— 地址可能复制错了字符，请重新复制' }
    }
  }
  return { ok: true }
}
