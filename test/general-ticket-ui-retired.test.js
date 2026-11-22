'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('商户与超管界面不再展示客服对话工单', () => {
  const home = read('src/components/Home.vue')
  const admin = read('src/components/admin/AdminLayout.vue')
  const router = read('src/router/index.js')
  assert.doesNotMatch(home, /index="\/user\/tickets"|tickets-unread|pix-user-ticket-read/)
  assert.doesNotMatch(admin, /index="\/admin\/tickets"|admin\/tickets-unread|pix-ticket-read/)
  assert.doesNotMatch(router, /path: '\/user\/tickets'|path: '\/admin\/tickets'/)
})

test('计数工单入口仍然保留', () => {
  const home = read('src/components/Home.vue')
  const admin = read('src/components/admin/AdminLayout.vue')
  const router = read('src/router/index.js')
  assert.match(home, /index="\/count\/tickets"/)
  assert.match(admin, /index="\/admin\/count-tickets"/)
  assert.match(router, /path: '\/count\/tickets'/)
})
