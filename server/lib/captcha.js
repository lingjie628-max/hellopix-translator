'use strict'

const crypto = require('crypto')
const { RedisVerificationStore } = require('../stores')

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

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
  await new RedisVerificationStore(redis).setCaptcha(imageId, code)
  return {
    imageId,
    image: `data:image/svg+xml;base64,${Buffer.from(createSvg(code)).toString('base64')}`
  }
}

async function consume(redis, imageId, supplied) {
  const result = await new RedisVerificationStore(redis)
    .verifyCaptcha(imageId, supplied, true)
  if (result.missing) return '图形验证码已过期，请刷新'
  return result.ok ? '' : '图形验证码错误'
}

module.exports = { issue, consume }
