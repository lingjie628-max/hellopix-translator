'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { JSDOM } = require('jsdom')

const ROOT = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(ROOT, 'desktop/renderer/counter-center.js'), 'utf8')

function mount (overrides) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <button id="counterBtn"></button><span id="counterQueueBadge" class="hidden"></span>
    <div id="counterCenter" class="modal hidden">
      <div class="counter-center-card">
        <div id="counterCenterAlert" class="counter-center-alert hidden"></div>
        <div id="counterCenterBody"></div>
        <span id="counterCenterStatus"></span>
        <select id="counterRange"><option value="today">今天</option></select>
        <label id="counterArchiveWrap" class="counter-check hidden"><input id="counterIncludeArchived" type="checkbox"></label>
        <button id="counterRefreshBtn"></button>
        <button id="counterCenterClose"></button>
        <button id="counterCenterDone"></button>
        <nav>
          <button data-counter-view="overview" aria-selected="true"></button>
          <button data-counter-view="events" aria-selected="false"></button>
          <button data-counter-view="repeats" aria-selected="false"></button>
          <button data-counter-view="tickets" aria-selected="false"></button>
          <button data-counter-view="accounts" aria-selected="false"></button>
        </nav>
      </div>
    </div>
  </body></html>`, { runScripts: 'outside-only', url: 'https://pix.test/' })
  const win = dom.window
  const calls = []
  const toasts = []
  let updated = null
  const api = Object.assign({
    summary: async () => ({ new: 3, repeat: 2, total: 5, unique: 4 }),
    events: async () => ({ rows: [{
      id: 1,
      kind: 'new',
      customer_public_id: 'C_101',
      customer_id: 101,
      account_label: '巴西一号',
      push_name: 'Ana',
      phone_tail: '7471',
      first_msg_at: '2026-11-16T10:00:00.000Z',
      ticket_id: 9,
      ticket_code: 'IT-20261116-9'
    }] }),
    tickets: async () => ({ rows: [{
      id: 9,
      code: 'IT-20261116-9',
      title: '新粉跟进 · Ana',
      customer_public_id: 'C_101',
      status: 'open',
      priority: 'normal',
      fan_kind: 'new'
    }] }),
    queueStatus: async () => ({ pending: 0, failed: 0, lastError: '' }),
    tabs: async () => [{
      id: 'whatsapp-green-1',
      platform: 'whatsapp-green',
      name: '巴西一号',
      enableCounter: false,
      localTabId: '1:whatsapp-green-1'
    }],
    accounts: async () => [],
    toggleTab: async payload => {
      calls.push(['toggleTab', payload])
      return { success: true }
    },
    onUpdated: callback => { updated = callback }
  }, overrides || {})
  win.esc = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  win.toast = value => { toasts.push(value) }
  win.showOverlay = (el, on) => el.classList.toggle('hidden', !on)
  win.pix = {
    counter: api,
    onTabs: () => {},
    home: () => {},
    switchTab: () => {}
  }
  win.eval(source)
  return { dom, win, calls, toasts, emitUpdate: payload => updated && updated(payload) }
}

test('进粉中心打开后显示实时 KPI 和最新流水', async () => {
  const h = mount()
  try {
    h.win.document.getElementById('counterBtn').click()
    await new Promise(resolve => h.win.setTimeout(resolve, 20))
    const modal = h.win.document.getElementById('counterCenter')
    const body = h.win.document.getElementById('counterCenterBody')
    assert.equal(modal.classList.contains('hidden'), false)
    assert.match(body.textContent, /新粉/)
    assert.match(body.textContent, /3/)
    assert.match(body.textContent, /重粉/)
    assert.match(body.textContent, /最新进粉/)
    assert.match(body.textContent, /IT-20261116-9/)
  } finally {
    h.win.close()
  }
})

test('计数账号页默认关闭，切换后调用主进程开关', async () => {
  const h = mount()
  try {
    h.win.document.getElementById('counterBtn').click()
    await new Promise(resolve => h.win.setTimeout(resolve, 20))
    h.win.document.querySelector('[data-counter-view="accounts"]').click()
    await new Promise(resolve => h.win.setTimeout(resolve, 20))
    const input = h.win.document.querySelector('[data-counter-toggle="whatsapp-green-1"]')
    assert.ok(input, h.win.document.getElementById('counterCenterBody').innerHTML)
    assert.equal(input.checked, false)
    input.checked = true
    input.dispatchEvent(new h.win.Event('change', { bubbles: true }))
    await new Promise(resolve => h.win.setTimeout(resolve, 20))
    assert.equal(h.calls[0][0], 'toggleTab')
    assert.equal(h.calls[0][1].id, 'whatsapp-green-1')
    assert.equal(h.calls[0][1].enabled, true)
  } finally {
    h.win.close()
  }
})

test('后台实时事件会提示新粉并刷新看板', async () => {
  const h = mount()
  try {
    h.win.document.getElementById('counterBtn').click()
    await new Promise(resolve => h.win.setTimeout(resolve, 20))
    h.emitUpdate({ status: 'repeat', ticketId: 10 })
    await new Promise(resolve => h.win.setTimeout(resolve, 300))
    assert.ok(h.toasts.some(text => /重粉/.test(text)))
  } finally {
    h.win.close()
  }
})
