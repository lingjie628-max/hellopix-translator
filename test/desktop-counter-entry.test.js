'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('进粉中心按钮打开的是计数工单，不是客服对话工单', () => {
  const app = read('desktop/renderer/app.js')
  assert.match(app, /counterBtn\.onclick/, '进粉中心必须有真实点击绑定')
  assert.match(app, /platformId:\s*'tickets'/, '进粉中心必须打开计数工单页')
  assert.doesNotMatch(read('desktop/renderer/index.html'), /工单中心|ticket-center\.js/)
})

test('计数工单平台隐藏于添加应用网格，桌面地址指向 hash 路由', () => {
  const platforms = read('desktop/shared/platforms.js')
  const main = read('desktop/main.js')
  assert.match(platforms, /id:\s*'tickets'[\s\S]*listed:\s*false/,
    '计数工单不能被当成普通平台出现在添加应用里')
  assert.match(main, /\/#\/count\/tickets/, '必须直达商户计数工单页面')
})

test('计数工单页面沿用客户端登录态，且不携带凭据到页面 URL', () => {
  const main = read('desktop/main.js')
  const preload = read('desktop/ticket-preload.js')
  assert.match(main, /prepareTicketSession/)
  assert.match(main, /ses\.cookies\.set/)
  assert.match(preload, /sessionStorage\.setItem\('user'/)
  assert.doesNotMatch(main, /\/#\/count\/tickets\?.*(?:token|password|cookie)=/i)
})

test('计数工单 preload 把最小用户快照写入 sessionStorage', () => {
  let saved = ''
  const profile = { username: 'alice', counterSuite: 1 }
  const arg = '--pix-ticket-user=' + encodeURIComponent(JSON.stringify(profile))
  vm.runInNewContext(read('desktop/ticket-preload.js'), {
    process: { argv: ['electron', arg] },
    window: { sessionStorage: { setItem: (key, value) => { saved = key + ':' + value } } },
    JSON: JSON,
    decodeURIComponent: decodeURIComponent
  })
  assert.match(saved, /^user:/)
  assert.match(saved, /"username":"alice"/)
  assert.doesNotMatch(saved, /password|cookie|token/i)
})
