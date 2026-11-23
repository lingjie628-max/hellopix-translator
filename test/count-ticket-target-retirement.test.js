'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { normalizeTicket } = require('../server/services/count-ticket-service')

const ROOT = path.join(__dirname, '..')
const UI = fs.readFileSync(
  path.join(ROOT, 'src', 'components', 'count', 'CountTickets.vue'),
  'utf8'
)
const SERVICE = fs.readFileSync(
  path.join(ROOT, 'server', 'services', 'count-ticket-service.js'),
  'utf8'
)
const REPO = fs.readFileSync(
  path.join(ROOT, 'server', 'repositories', 'count-ticket-repository.js'),
  'utf8'
)
const MOCK = fs.readFileSync(path.join(ROOT, 'mock', 'index.js'), 'utf8')
const DOC = fs.readFileSync(
  path.join(ROOT, 'docs', '原生计数工单-实现说明.md'),
  'utf8'
)

test('★ 商户计数工单不再展示或提交单日/总目标', () => {
  assert.doesNotMatch(UI, /单日目标|总目标|单日 \/ 总目标/)
  assert.doesNotMatch(UI, /ticketForm\.(?:dayTarget|totalTarget)/)
  assert.doesNotMatch(UI, /\b(?:dayTarget|totalTarget)\s*:/)
})

test('★ 服务端不再归一化目标字段，旧客户端传值也会被忽略', () => {
  const normalized = normalizeTicket({
    title: '目标退役回归',
    platform: 'whatsapp-green',
    dayTarget: 99,
    totalTarget: 999,
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  assert.equal(Object.hasOwn(normalized, 'dayTarget'), false)
  assert.equal(Object.hasOwn(normalized, 'totalTarget'), false)
  assert.doesNotMatch(SERVICE, /\b(?:dayTarget|totalTarget)\s*:/)
})

test('★ 创建/编辑/列表 SQL 不再读写目标列，历史列保持原值', () => {
  assert.doesNotMatch(REPO, /\b(?:day_target|total_target)\b/)
  const saveStart = MOCK.indexOf("app.post('/apis/count-tickets/save'")
  const saveEnd = MOCK.indexOf("app.post('/apis/count-tickets/accounts/save'", saveStart)
  assert.ok(saveStart > 0 && saveEnd > saveStart)
  const saveHandler = MOCK.slice(saveStart, saveEnd)
  assert.doesNotMatch(saveHandler, /\b(?:dayTarget|totalTarget)\b/)
})

test('实现说明明确标记目标设置已退役', () => {
  assert.match(DOC, /目标设置.*退役|已退役.*目标/)
})
