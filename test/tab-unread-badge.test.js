const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
const appSrc = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'app.js'), 'utf8')

function extract(src, name) {
  const at = src.indexOf('function ' + name + '(')
  assert.ok(at >= 0, '找不到 ' + name)
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error('未闭合：' + name)
}

// eslint-disable-next-line no-new-func
const unreadFromTitle = new Function(extract(mainSrc, 'unreadFromTitle') + '; return unreadFromTitle')()

test('标题里的未读数：各家常见格式都能读出来', () => {
  assert.equal(unreadFromTitle('(3) WhatsApp'), 3)
  assert.equal(unreadFromTitle('(12) Messenger'), 12)
  assert.equal(unreadFromTitle('(99+) Facebook'), 99)
  assert.equal(unreadFromTitle('WhatsApp (5)'), 5)
  assert.equal(unreadFromTitle('7 • Telegram'), 7)
  assert.equal(unreadFromTitle('[4] Zalo'), 4)
})

test('没有未读 / 标题里只是普通数字 → 0（不显示错的数）', () => {
  assert.equal(unreadFromTitle('WhatsApp'), 0)
  assert.equal(unreadFromTitle(''), 0)
  assert.equal(unreadFromTitle(null), 0)
  assert.equal(unreadFromTitle('Telegram Web'), 0)
  assert.equal(unreadFromTitle('2024 - 年度总结'), 0)
  assert.equal(unreadFromTitle('张三 发来了一条消息'), 0)
  assert.equal(unreadFromTitle('Room 101 chat'), 0)
})

test('选项卡开关关闭时不下发未读数；全局角标只算开了全局提示的标签', () => {
  assert.match(mainSrc, /unread: \(t\.settings && t\.settings\.tabUnread === false\) \? 0 : \(t\.unread \|\| 0\)/)
  assert.match(extract(mainSrc, 'syncGlobalUnread'), /globalUnread === false/)
  assert.match(extract(mainSrc, 'sendTabs'), /syncGlobalUnread\(\)/)
})

test('未读数为 0 时界面不输出角标元素', () => {
  const fn = extract(appSrc, 'makeTabEl')
  assert.match(fn, /unread > 0\s*\n?\s*\? '<span class="tab-unread"/)
  assert.match(fn, /unread > 99 \? '99\+'/)
})
