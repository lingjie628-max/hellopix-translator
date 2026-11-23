'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const catalog = require('../server/lib/client-catalog')
const { normalizeTicket, normalizeAccount } = require('../server/services/count-ticket-service')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('计数筛粉只声明 WhatsApp 与 Telegram 为真实支持平台', () => {
  for (const id of ['whatsapp-green', 'whatsapp-pro', 'whatsapp-biz', 'telegram-z']) {
    assert.equal(catalog.supportsCounting(id), true, id + ' 应支持筛粉')
  }
  for (const id of ['line', 'zalo', 'instagram', 'facebook', 'discord', 'tiktok']) {
    assert.equal(catalog.supportsCounting(id), false, id + ' 目前没有客户身份采集')
  }
})

test('服务端拒绝为未接采集的平台建计数工单/账号', () => {
  assert.throws(
    () => normalizeTicket({ title: 'Line 测试', platform: 'line' }),
    error => error.code === 'COUNT_PLATFORM_UNSUPPORTED'
  )
  assert.throws(
    () => normalizeAccount({ platform: 'zalo', accountKey: 'a' }),
    error => error.code === 'COUNT_PLATFORM_UNSUPPORTED'
  )
})

test('计数工单前端只展示真实支持筛粉的平台，并明确提示', () => {
  const page = read('src/components/count/CountTickets.vue')
  assert.match(page, /countingSupported/, '平台下拉必须读取后端支持标记')
  assert.match(page, /仅 WhatsApp 与 Telegram 支持自动筛粉/)
})

test('平台 API 下发 countingSupported，供界面过滤', () => {
  const core = read('server/services/core-service.js')
  assert.match(core, /countingSupported:\s*catalog\.supportsCounting/)
})
