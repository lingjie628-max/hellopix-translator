'use strict'

const crypto = require('crypto')
const { RedisVerificationStore } = require('../stores')

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * 图形验证码有效期。
 *
 * 之前是 5 分钟（由 store 的默认值兜底）。注册表单要依次填用户名、两遍密码、
 * 邮箱，再回头抄图形码 —— 用密码管理器、翻一下页面说明都很容易吃掉时间，
 * 5 分钟偏紧。给到 10 分钟，与邮箱验证码的 600 秒一致。
 *
 * **不用"永不过期"**：图形验证码是挡机器人刷发信的一次性闸门，
 * 永久有效等于把它变成可无限重放的东西。
 *
 * 由这里**唯一**决定，两个 store 的默认值只是兜底；改这个常数即改生产行为。
 */
const CAPTCHA_TTL_MS = 10 * 60_000

function randomCode(length) {
  return Array.from({ length }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('')
}

function createSvg(code) {
  const noise = Array.from({ length: 8 }, () => {
    const x1 = crypto.randomInt(120)
    const y1 = crypto.randomInt(42)
    const x2 = crypto.randomInt(120)
    const y2 = crypto.randomInt(42)
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#789" opacity=".45"/>`
  }).join('')
  const text = Array.from(code).map((letter, index) => (
    `<text x="${13 + index * 26}" y="${28 + crypto.randomInt(-3, 4)}" font-size="23" ` +
    `font-family="Verdana,sans-serif" font-weight="700" fill="#${crypto.randomBytes(3).toString('hex')}">${letter}</text>`
  )).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="42">` +
    `<rect width="120" height="42" fill="#eef3fb"/>${noise}${text}</svg>`
}

async function issue(redis) {
  const code = randomCode(4)
  const imageId = `img_${crypto.randomBytes(18).toString('base64url')}`
  await new RedisVerificationStore(redis).setCaptcha(imageId, code, CAPTCHA_TTL_MS)
  return {
    imageId,
    image: `data:image/svg+xml;base64,${Buffer.from(createSvg(code)).toString('base64')}`
  }
}

/**
 * 校验图形验证码。
 *
 * 返回 `{ ok, code, message }` —— 调用方**必须**靠 `code` 区分两种失败：
 *
 *   CAPTCHA_EXPIRED  键不存在：真的过期，或（历史缺陷）前端根本没提交 imageId
 *   CAPTCHA_INVALID  键存在但码不对
 *
 * 为什么要把两者分开：以前只有一个「图形验证码已过期，请刷新」，
 * 用户看到"过期"会以为是自己手慢，其实可能是别的原因；而且前端无法据此
 * 决定"要不要自动换一张图"。分开之后前端才能在过期时自动刷新、
 * 在码错时提示重填，而不是让用户自己去点图片。
 *
 * 校验是**一次性**的（consume=true）：无论成功还是码错都会删键。
 * 码错也删是有意的 —— 否则同一个 imageId 可以被无限次暴力尝试。
 */
async function consume(redis, imageId, supplied) {
  const result = await new RedisVerificationStore(redis)
    .verifyCaptcha(imageId, supplied, true)
  if (result.missing) {
    return { ok: false, code: 'CAPTCHA_EXPIRED', message: '图形验证码已过期，请刷新' }
  }
  if (!result.ok) {
    return { ok: false, code: 'CAPTCHA_INVALID', message: '图形验证码错误' }
  }
  return { ok: true, code: '', message: '' }
}

module.exports = { issue, consume, CAPTCHA_TTL_MS }
