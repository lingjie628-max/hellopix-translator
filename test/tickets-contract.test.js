'use strict'

/**
 * Ticket UI/API contract guards.
 *
 * These are source-level tests because the current frontend test harness does
 * not mount the Vue 2 ticket pages. They lock the exact mistakes found in the
 * audit: Axios response unwrapping, server pagination names, timestamp field
 * names, and the row-lock/transaction boundary around a state change.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

test('user ticket create/reply unwrap Axios response.data', () => {
  const src = read('src/components/user/UserTickets.vue')
  assert.match(src, /const data = \(resp && resp\.data\) \|\| \{\}/)
  assert.match(src, /data\.success === 'success'/)
  assert.doesNotMatch(src, /resp\.success === 'success'/)
})

test('admin ticket pagination uses page/rows and maps createdAt', () => {
  const src = read('src/components/admin/AdminTickets.vue')
  assert.match(src, /page:\s*this\.page/)
  assert.match(src, /rows:\s*this\.size/)
  assert.doesNotMatch(src, /offset:\s*this\.page/)
  assert.doesNotMatch(src, /createTime/)
  assert.match(src, /lastReplyAt \|\| row\.createdAt/)
  assert.match(src, /m\.createdAt/)
})

test('ticket writes lock the row and use a transaction', () => {
  const admin = read('server/routes/admin/tickets.js')
  const user = read('server/routes/user-tickets.js')
  assert.match(admin, /FOR UPDATE/)
  assert.match(admin, /repo\.transaction/)
  assert.match(user, /FOR UPDATE/)
  assert.match(user, /repo\.transaction/)
})
