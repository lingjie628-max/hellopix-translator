'use strict'

function detectLang(text) {
  const value = String(text || '')
  if (/[\u4e00-\u9fff]/.test(value)) return 'zh'
  if (/[\u3040-\u30ff]/.test(value)) return 'ja'
  if (/[\uac00-\ud7af]/.test(value)) return 'ko'
  return 'en'
}

function countBillableChars(text) {
  let count = 0
  for (const char of String(text || '')) {
    count += /[\u4e00-\u9fff]/.test(char) ? 2 : 1
  }
  return count
}

async function translate() {
  return { ok: false, msg: '真实翻译通道尚未配置' }
}

module.exports = { detectLang, countBillableChars, translate }
