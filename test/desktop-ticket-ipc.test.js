'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { registerTicketIpc } = require('../desktop/src/ipc/tickets')

const root = path.join(__dirname, '..', 'desktop')

function fixture() {
  const handlers = new Map()
  const calls = []
  const reg = { handle: (name, fn) => handlers.set(name, fn) }
  const actions = {
    api: async (pathname, opts) => {
      calls.push({ pathname, opts })
      return { success: 'success', obj: { pathname } }
    }
  }
  registerTicketIpc({ reg, actions })
  return { handlers, calls }
}

test('工单 IPC 只暴露固定的五个用户端操作', () => {
  const { handlers } = fixture()
  assert.deepEqual(Array.from(handlers.keys()).sort(), [
    'tickets:create', 'tickets:get', 'tickets:list', 'tickets:reply', 'tickets:unread'
  ])
})

test('列表参数受控，非法状态回退到进行中', async () => {
  const { handlers, calls } = fixture()
  const out = await handlers.get('tickets:list')(null, { status: '../../admin', rows: 9999 })
  assert.equal(out.success, 'success')
  assert.equal(calls[0].pathname, '/tickets?status=open&page=1&rows=50')
})

test('建单在 IPC 边界再次裁长度并校验分类', async () => {
  const { handlers, calls } = fixture()
  const out = await handlers.get('tickets:create')(null, {
    subject: '  充值没到账  ',
    body: 'x'.repeat(6000),
    category: 'not-a-category'
  })
  assert.equal(out.success, 'success')
  assert.equal(calls[0].pathname, '/tickets/create')
  assert.equal(calls[0].opts.form.subject, '充值没到账')
  assert.equal(calls[0].opts.form.body.length, 5000)
  assert.equal(calls[0].opts.form.category, 'other')
})

test('详情与回复必须使用正整数工单号', async () => {
  const { handlers, calls } = fixture()
  const bad = await handlers.get('tickets:get')(null, '../admin/logs')
  assert.equal(bad.success, false)
  assert.equal(calls.length, 0)

  await handlers.get('tickets:get')(null, 42)
  await handlers.get('tickets:reply')(null, { id: 42, body: '补充信息' })
  assert.equal(calls[0].pathname, '/tickets/42')
  assert.deepEqual(calls[1].opts.form, { id: '42', body: '补充信息' })
})

test('桌面入口、preload 与主进程接线完整', () => {
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8')
  assert.match(html, /id="ticketBtn"/, '工具栏必须有工单入口')
  assert.match(html, /id="ticketPanel"/, '必须有建单与对话面板')
  assert.match(html, /ticket-center\.js/, '工单 UI 脚本必须加载')
  for (const method of ['ticketList', 'ticketGet', 'ticketCreate', 'ticketReply', 'ticketUnread']) {
    assert.match(preload, new RegExp(method + ':'), `preload 缺少 ${method}`)
  }
  assert.match(renderer, /ticketStart\(\)/, '登录后必须启动未读轮询')
  assert.match(renderer, /ticketStop\(\)/, '退出登录必须停止轮询并清角标')
})
