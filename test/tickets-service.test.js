'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const tickets = require('../server/services/ticket-service')

test('closed ticket is terminal and cannot be reopened by the state machine', () => {
  assert.equal(tickets.canTransition('closed', 'in_progress'), false)
  assert.throws(
    () => tickets.nextState({ status: 'closed' }, 'in_progress'),
    error => error.code === 'TICKET_BAD_TRANSITION'
  )
})

test('resolved timestamp is written once and not erased when reopened', () => {
  const resolvedAt = new Date('2026-11-15T12:00:00Z')
  const resolved = tickets.nextState({ status: 'in_progress', resolved_at: null }, 'resolved', resolvedAt)
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.resolvedAt.getTime(), resolvedAt.getTime())

  const reopened = tickets.nextState({
    status: 'resolved',
    resolved_at: resolvedAt
  }, 'in_progress')
  assert.equal(reopened.resolvedAt.getTime(), resolvedAt.getTime())
})

test('user reply moves waiting/resolved tickets back to in_progress only', () => {
  assert.equal(tickets.afterUserReply('waiting_user'), 'in_progress')
  assert.equal(tickets.afterUserReply('resolved'), 'in_progress')
  assert.equal(tickets.afterUserReply('new'), 'new')
  assert.equal(tickets.afterUserReply('in_progress'), 'in_progress')
})
