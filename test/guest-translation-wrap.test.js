'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const guest = fs.readFileSync(path.join(root, 'desktop/guest-inject.js'), 'utf8')

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = guest.match(new RegExp(escaped + '\\s*\\{([\\s\\S]*?)\\n\\s*\\}', 'm'))
  assert.ok(match, `找不到 ${selector} 样式`)
  return match[1]
}

test('长译文必须按客页可视宽度换行，不能从右侧被裁掉', () => {
  const trans = rule('.pix-trans')
  assert.match(trans, /max-width:\s*min\(100%,\s*calc\(100vw\s*-\s*48px\)\)/,
    '译文缺少视口宽度上限；宿主气泡较宽时长句会越过右边界')
  assert.match(trans, /overflow-wrap:\s*anywhere/,
    '没有连续空格的 CJK/长单词必须在任意位置允许断行')
  assert.match(trans, /word-break:\s*break-word/,
    '需要兼容 Chromium 对长译文的断词策略')
  assert.match(trans, /box-sizing:\s*border-box/,
    'padding/border 不能把译文总宽度再次撑出视口')
})

test('保留原文样式同样不能横向溢出', () => {
  const kept = rule('.pix-kept')
  assert.match(kept, /max-width:\s*min\(100%,\s*calc\(100vw\s*-\s*48px\)\)/)
  assert.match(kept, /overflow-wrap:\s*anywhere/)
})

