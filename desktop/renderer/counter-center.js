/**
 * 原生进粉中心。
 *
 * 数据链路与服务端完全隔离：这里只调用 preload 暴露的 counter:* IPC，
 * 不接触页面世界，也不保存客户身份原文。列表中的客户号均为服务端 public_id。
 */
(() => {
  'use strict'

  const modal = document.getElementById('counterCenter')
  const entry = document.getElementById('counterBtn')
  const badge = document.getElementById('counterQueueBadge')
  const body = document.getElementById('counterCenterBody')
  const alertBox = document.getElementById('counterCenterAlert')
  const statusText = document.getElementById('counterCenterStatus')
  const rangeSelect = document.getElementById('counterRange')
  const includeArchived = document.getElementById('counterIncludeArchived')
  const archiveWrap = document.getElementById('counterArchiveWrap')
  const refreshBtn = document.getElementById('counterRefreshBtn')
  const closeBtn = document.getElementById('counterCenterClose')
  const doneBtn = document.getElementById('counterCenterDone')
  const tabs = Array.from(modal ? modal.querySelectorAll('[data-counter-view]') : [])
  if (!modal || !entry || !body) return

  let activeView = 'overview'
  let refreshTimer = null
  let badgeTimer = null
  let refreshSequence = 0
  let refreshQueued = false
  let accountRows = []
  let accountHistory = []
  let ticketRows = []
  let ticketDetail = null
  const state = {
    summary: null,
    events: [],
    repeats: [],
    tickets: [],
    queue: { pending: 0, failed: 0, lastError: '' },
    loadedAt: null
  }

  function dayValue(date) {
    const d = date instanceof Date ? date : new Date(date)
    const offset = d.getTimezoneOffset() * 60_000
    return new Date(d.getTime() - offset).toISOString().slice(0, 10)
  }

  function rangeQuery(range) {
    const value = range || rangeSelect.value || 'today'
    if (value === 'all') return {}
    const now = new Date()
    if (value === 'today') {
      const day = dayValue(now)
      return { from: day, to: day }
    }
    const days = value === '7d' ? 7 : 30
    const from = new Date(now)
    from.setDate(from.getDate() - (days - 1))
    return { from: dayValue(from), to: dayValue(now) }
  }

  function rangeLabel() {
    return {
      today: '今日',
      '7d': '近 7 天',
      '30d': '近 30 天',
      all: '历史累计'
    }[rangeSelect.value] || '今日'
  }

  function formatTime(value) {
    if (!value) return '-'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return String(value)
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date)
  }

  function formatClock(date) {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date || new Date())
  }

  function statusLabel(value) {
    return {
      open: '待处理',
      in_progress: '处理中',
      pending: '等待中',
      resolved: '已解决',
      closed: '已关闭'
    }[value] || value || '-'
  }

  function priorityLabel(value) {
    return {
      urgent: '紧急',
      high: '高',
      normal: '普通',
      low: '低'
    }[value] || value || '普通'
  }

  function apiValue(result, fallback) {
    if (result && result.success === false) throw new Error(result.msg || fallback || '请求失败')
    return result
  }

  function setAlert(text, tone) {
    if (!alertBox) return
    alertBox.className = 'counter-center-alert' + (tone ? ' ' + tone : '')
    alertBox.innerHTML = text || ''
    alertBox.classList.toggle('hidden', !text)
  }

  function setLoading(on) {
    body.setAttribute('aria-busy', on ? 'true' : 'false')
    refreshBtn.disabled = on
    refreshBtn.textContent = on ? '同步中' : '刷新'
    if (on) {
      statusText.textContent = '正在同步数据中心…'
      if (!body.innerHTML.trim()) body.innerHTML = '<div class="counter-loading"><i></i><span>正在读取进粉数据</span></div>'
    }
  }

  function emptyState(title, text, action) {
    return '<div class="counter-empty">' +
      '<span class="counter-empty-mark" aria-hidden="true"></span>' +
      '<b>' + esc(title) + '</b>' +
      '<p>' + esc(text) + '</p>' +
      (action ? '<button type="button" data-counter-action="' + esc(action) + '">' + esc(action === 'open-app' ? '去添加 WhatsApp' : '刷新') + '</button>' : '') +
      '</div>'
  }

  function table(headers, rows, empty, compact) {
    if (!rows) return emptyState(empty || '还没有数据', '新粉进入后会自动出现在这里。')
    return '<div class="counter-table-wrap"><table class="counter-table' + (compact ? ' compact' : '') + '">' +
      '<thead><tr>' + headers.map(item => '<th scope="col">' + esc(item) + '</th>').join('') + '</tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>'
  }

  function eventBadge(kind) {
    return '<span class="counter-kind ' + (kind === 'repeat' ? 'repeat' : 'new') + '">' +
      (kind === 'repeat' ? '重粉' : '新粉') + '</span>'
  }

  function eventRows(rows) {
    return (rows || []).map(row => {
      const customer = row.push_name || (row.phone_tail ? '尾号 ' + row.phone_tail : row.customer_public_id)
      return '<tr>' +
        '<td data-label="时间"><time datetime="' + esc(row.first_msg_at) + '">' + esc(formatTime(row.first_msg_at)) + '</time></td>' +
        '<td data-label="类型">' + eventBadge(row.kind) + '</td>' +
        '<td data-label="客户"><b>' + esc(customer) + '</b><small>' + esc(row.customer_public_id) + '</small></td>' +
        '<td data-label="计数账号">' + esc(row.account_label || '-') + '</td>' +
        '<td data-label="自动工单">' + (row.ticket_id
          ? '<button type="button" class="counter-link" data-ticket-id="' + esc(row.ticket_id) + '">' + esc(row.ticket_code) + '</button>'
          : '<span class="counter-muted">-</span>') + '</td>' +
        '</tr>'
    }).join('')
  }

  function ticketStatusBadge(value) {
    return '<span class="counter-ticket-status status-' + esc(value) + '">' + esc(statusLabel(value)) + '</span>'
  }

  function ticketRowsHtml(rows, compact) {
    return (rows || []).map(row => {
      return '<tr>' +
        '<td data-label="工单"><b>' + esc(row.code) + '</b><small>' + esc(row.title || '') + '</small></td>' +
        '<td data-label="类型">' + eventBadge(row.fan_kind || (row.priority === 'high' ? 'repeat' : 'new')) + '</td>' +
        (compact ? '' : '<td data-label="客户">' + esc(row.customer_public_id || '-') + '</td>') +
        '<td data-label="状态">' + ticketStatusBadge(row.status) + '</td>' +
        (compact ? '' : '<td data-label="优先级">' + esc(priorityLabel(row.priority)) + '</td>') +
        '<td data-label="操作"><button type="button" class="counter-link" data-ticket-id="' + esc(row.id) + '">查看</button></td>' +
        '</tr>'
    }).join('')
  }

  function queueNotice(queue) {
    const pending = Number(queue && queue.pending) || 0
    const failed = Number(queue && queue.failed) || 0
    if (!pending && !failed) {
      return '<div class="counter-sync-state healthy"><span></span><b>实时同步正常</b><p>新粉到达后会立即计数并生成自动工单。</p></div>'
    }
    return '<div class="counter-sync-state warning"><span></span><b>' +
      (failed ? failed + ' 条事件需要人工重试' : pending + ' 条事件等待补传') +
      '</b><p>' + esc(queue.lastError || '网络恢复后会自动重试，不会重复计数。') + '</p>' +
      '<button type="button" data-counter-action="retry-queue">立即重试</button></div>'
  }

  function renderOverview() {
    const summary = state.summary || { new: 0, repeat: 0, total: 0, unique: 0 }
    const label = rangeLabel()
    const tickets = state.tickets || []
    return '' +
      '<section class="counter-hero">' +
        '<div><p>LIVE COUNTING</p><h4>' + esc(label) + '进粉脉搏</h4></div>' +
        '<span>全局判重 · 自动建单 · 本地断网补传</span>' +
      '</section>' +
      '<section class="counter-kpis" aria-label="' + esc(label) + '进粉汇总">' +
        '<article class="counter-kpi primary"><span>新粉</span><b>' + Number(summary.new || 0) + '</b><small>首次进入当前主账号</small></article>' +
        '<article class="counter-kpi repeat"><span>重粉</span><b>' + Number(summary.repeat || 0) + '</b><small>主账号见过，本号首次见</small></article>' +
        '<article class="counter-kpi"><span>进粉总量</span><b>' + Number(summary.total || 0) + '</b><small>不含同号重复联系</small></article>' +
        '<article class="counter-kpi"><span>独立客户</span><b>' + Number(summary.unique || 0) + '</b><small>按客户去重</small></article>' +
      '</section>' +
      queueNotice(state.queue) +
      '<div class="counter-overview-grid">' +
        '<section class="counter-panel">' +
          '<header><div><span>REALTIME FEED</span><h4>最新进粉</h4></div><button type="button" data-counter-view-jump="events">查看全部</button></header>' +
          table(['时间', '类型', '客户', '账号', '自动工单'], eventRows(state.events), '暂无进粉') +
        '</section>' +
        '<section class="counter-panel">' +
          '<header><div><span>AUTO TICKETS</span><h4>待跟进工单</h4></div><button type="button" data-counter-view-jump="tickets">全部工单</button></header>' +
          table(['工单', '类型', '状态', '操作'], ticketRowsHtml(tickets, true), '暂无待处理工单', true) +
        '</section>' +
      '</div>'
  }

  function renderEvents() {
    return '<section class="counter-view-head"><div><span>INBOUND LEDGER</span><h4>' + esc(rangeLabel()) + '进粉流水</h4><p>每条新粉和重粉都会生成唯一自动工单；同一计数账号再次联系不重复计数。</p></div></section>' +
      table(['时间', '类型', '客户', '计数账号', '自动工单'], eventRows(state.events), '当前范围暂无进粉')
  }

  function renderRepeats() {
    const rows = (state.repeats || []).map(row => '<tr>' +
      '<td data-label="客户"><b>' + esc(row.push_name || ('尾号 ' + (row.phone_tail || '-'))) + '</b><small>' + esc(row.customer_public_id) + '</small></td>' +
      '<td data-label="命中账号">' + Number(row.account_count || 0) + ' 个</td>' +
      '<td data-label="计数次数">' + Number(row.seen_count || 0) + ' 次</td>' +
      '<td data-label="首次出现">' + esc(formatTime(row.first_at)) + '</td>' +
      '<td data-label="最近出现">' + esc(formatTime(row.last_at)) + '</td>' +
      '</tr>').join('')
    return '<section class="counter-view-head"><div><span>GLOBAL REPEAT POOL</span><h4>主账号全局重粉库</h4><p>跨设备、跨计数字号共享；只汇总在多个计数账号出现过的客户。</p></div></section>' +
      table(['客户', '命中账号', '计数次数', '首次出现', '最近出现'], rows, '暂无跨账号重粉')
  }

  function renderTicketDetail() {
    if (!ticketDetail) return ''
    const ticket = ticketDetail.ticket || {}
    const timeline = (ticketDetail.events || []).map(event => {
      return '<li><span>' + esc(formatTime(event.created_at)) + '</span><b>' + esc(event.kind) + '</b><p>' + esc(event.body || '-') + '</p></li>'
    }).join('')
    const actions = []
    if (ticket.status === 'open') actions.push(['in_progress', '开始处理'])
    if (ticket.status !== 'resolved' && ticket.status !== 'closed') actions.push(['resolved', '标记解决'])
    if (ticket.status !== 'closed') actions.push(['closed', '关闭工单'])
    if (ticket.status === 'closed') actions.push(['open', '重新打开'])
    return '<section class="counter-ticket-detail" aria-labelledby="counterTicketDetailTitle">' +
      '<header><div><span>' + esc(ticket.code || '') + '</span><h4 id="counterTicketDetailTitle">' + esc(ticket.title || '进粉工单') + '</h4></div>' +
      '<button type="button" class="counter-icon-btn" data-ticket-detail-close aria-label="关闭工单详情">×</button></header>' +
      '<div class="counter-ticket-meta">' +
        '<div><span>客户</span><b>' + esc(ticket.customer_public_id || '-') + '</b></div>' +
        '<div><span>计数账号</span><b>' + esc(ticket.account_label || '-') + '</b></div>' +
        '<div><span>状态</span><b>' + esc(statusLabel(ticket.status)) + '</b></div>' +
        '<div><span>优先级</span><b>' + esc(priorityLabel(ticket.priority)) + '</b></div>' +
        '<div><span>首次消息</span><b>' + esc(formatTime(ticket.first_msg_at)) + '</b></div>' +
        '<div><span>处理时限</span><b>' + esc(formatTime(ticket.due_at)) + '</b></div>' +
      '</div>' +
      '<div class="counter-ticket-actions">' + actions.map(item =>
        '<button type="button" data-ticket-status="' + esc(item[0]) + '">' + esc(item[1]) + '</button>'
      ).join('') + '</div>' +
      '<ol class="counter-timeline">' + (timeline || '<li><p>暂无处理记录</p></li>') + '</ol>' +
      '<form id="counterTicketReply" class="counter-reply"><label for="counterReplyBody">添加处理备注</label>' +
      '<textarea id="counterReplyBody" maxlength="5000" rows="3" placeholder="记录跟进结果，不会发送给客户"></textarea>' +
      '<button type="submit">保存备注</button></form>' +
      '</section>'
  }

  function renderTickets() {
    return '<section class="counter-view-head"><div><span>AUTO FOLLOW-UP</span><h4>进粉自动工单</h4><p>进粉事实与工单同事务创建；这里与商户客服工单完全分开。</p></div></section>' +
      table(['工单', '类型', '客户', '状态', '优先级', '操作'], ticketRowsHtml(state.tickets, false), '暂无自动工单') +
      renderTicketDetail()
  }

  function accountCard(tab) {
    const account = accountRows.find(row => String(row.local_tab_id || '') === String(tab.localTabId || '')) || null
    return '<article class="counter-account-card">' +
      '<div class="counter-account-main"><span class="counter-account-icon">WA</span><div><b>' + esc(tab.name) + '</b>' +
      '<small>' + esc(tab.platform) + (tab.hidden ? ' · 后台运行' : '') + '</small></div></div>' +
      '<div class="counter-account-stats">' +
        '<span><b>' + Number(account && account.new_fans || 0) + '</b>新粉</span>' +
        '<span><b>' + Number(account && account.repeat_fans || 0) + '</b>重粉</span>' +
        '<span><b>' + Number(account && account.total_fans || 0) + '</b>总量</span>' +
      '</div>' +
      '<div class="counter-account-actions">' +
        '<label class="counter-switch"><input type="checkbox" data-counter-toggle="' + esc(tab.id) + '"' +
          (tab.enableCounter ? ' checked' : '') + '><span>' + (tab.enableCounter ? '计数中' : '未计数') + '</span></label>' +
        '<button type="button" data-open-tab="' + esc(tab.id) + '">打开 WhatsApp</button>' +
      '</div>' +
      '</article>'
  }

  function renderAccounts() {
    const archived = (accountHistory || []).filter(row => !!row.archived_at)
    const archivedRows = archived.map(row => '<tr>' +
      '<td data-label="账号"><b>' + esc(row.label || row.local_tab_id) + '</b><small>' + esc(row.local_tab_id) + '</small></td>' +
      '<td data-label="新粉">' + Number(row.new_fans || 0) + '</td>' +
      '<td data-label="重粉">' + Number(row.repeat_fans || 0) + '</td>' +
      '<td data-label="归档时间">' + esc(formatTime(row.archived_at)) + '</td>' +
      '</tr>').join('')
    const current = accountHistory.filter(row => !row.archived_at)
    const activeSummary = '<div class="counter-account-summary"><span>当前有效计数账号</span><b>' +
      current.length + '</b><p>关闭最后一个计数账号后，当前汇总归零；历史流水仍保存在下方数据中心。</p></div>'
    return '<section class="counter-view-head"><div><span>COUNTING INSTANCES</span><h4>计数账号</h4><p>只对开启了计数器的 WhatsApp 实例统计；关闭账号不会删除历史。</p></div></section>' +
      activeSummary +
      (accountRows.length ? '<div class="counter-account-list">' + accountRows.map(accountCard).join('') + '</div>' :
        emptyState('还没有 WhatsApp 计数账号', '先打开一个 WhatsApp 实例，再在这里开启计数。', 'open-app')) +
      '<section class="counter-panel counter-archive-panel"><header><div><span>ARCHIVE</span><h4>已归档账号</h4></div></header>' +
      table(['账号', '新粉', '重粉', '归档时间'], archivedRows, '暂无已归档计数账号') + '</section>'
  }

  function markActiveTab() {
    tabs.forEach(tab => {
      const active = tab.dataset.counterView === activeView
      tab.setAttribute('aria-selected', active ? 'true' : 'false')
      tab.tabIndex = active ? 0 : -1
      tab.classList.toggle('active', active)
    })
    const showArchive = activeView === 'events' || activeView === 'repeats'
    archiveWrap.classList.toggle('hidden', !showArchive)
  }

  function render() {
    if (activeView === 'overview') body.innerHTML = renderOverview()
    else if (activeView === 'events') body.innerHTML = renderEvents()
    else if (activeView === 'repeats') body.innerHTML = renderRepeats()
    else if (activeView === 'tickets') body.innerHTML = renderTickets()
    else body.innerHTML = renderAccounts()
    markActiveTab()
    bindDynamicControls()
  }

  function bindDynamicControls() {
    const reply = document.getElementById('counterTicketReply')
    if (reply) {
      reply.addEventListener('submit', async event => {
        event.preventDefault()
        const text = document.getElementById('counterReplyBody').value.trim()
        if (!text || !ticketDetail || !ticketDetail.ticket) return
        try {
          apiValue(await window.pix.counter.replyTicket({ id: ticketDetail.ticket.id, body: text }), '保存备注失败')
          toast('处理备注已保存')
          await openTicket(ticketDetail.ticket.id)
        } catch (error) {
          setAlert(error.message || '保存备注失败', 'error')
        }
      })
    }

    body.querySelectorAll('[data-counter-toggle]').forEach(input => {
      input.addEventListener('change', async () => {
        const enabled = input.checked
        input.disabled = true
        const label = input.parentElement && input.parentElement.querySelector('span')
        if (label) label.textContent = enabled ? '开启中…' : '归档中…'
        try {
          const result = apiValue(await window.pix.counter.toggleTab({ id: input.dataset.counterToggle, enabled }), '更新计数账号失败')
          if (result && result.success === false) throw new Error(result.msg || '更新失败')
          toast(enabled ? '已开启进粉计数' : '已关闭计数，历史流水仍保留')
          await refresh()
        } catch (error) {
          input.checked = !enabled
          input.disabled = false
          if (label) label.textContent = input.checked ? '计数中' : '未计数'
          setAlert(error.message || '更新计数账号失败', 'error')
        }
      })
    })
  }

  function renderError(error) {
    body.innerHTML = emptyState('进粉中心暂时不可用', error.message || String(error), 'refresh')
    setAlert(error.message || '读取进粉数据失败', 'error')
    statusText.textContent = '同步失败 · ' + formatClock(new Date())
  }

  async function loadData() {
    const query = rangeQuery()
    if (activeView === 'overview') {
      const [summary, events, tickets, queue] = await Promise.all([
        window.pix.counter.summary(query),
        window.pix.counter.events(Object.assign({}, query, { rows: 10 })),
        window.pix.counter.tickets({ rows: 8 }),
        window.pix.counter.queueStatus()
      ])
      state.summary = apiValue(summary, '读取汇总失败')
      state.events = apiValue(events, '读取进粉流水失败').rows || []
      state.tickets = apiValue(tickets, '读取工单失败').rows || []
      state.queue = apiValue(queue, '读取同步状态失败') || state.queue
      return
    }
    if (activeView === 'events') {
      const result = apiValue(await window.pix.counter.events(Object.assign({}, query, {
        rows: 200,
        includeArchived: includeArchived.checked
      })), '读取进粉流水失败')
      state.events = result.rows || []
      return
    }
    if (activeView === 'repeats') {
      const result = apiValue(await window.pix.counter.repeats(Object.assign({}, query, {
        rows: 200,
        includeArchived: includeArchived.checked
      })), '读取重粉库失败')
      state.repeats = result.rows || []
      return
    }
    if (activeView === 'tickets') {
      const result = apiValue(await window.pix.counter.tickets({ rows: 200 }), '读取自动工单失败')
      state.tickets = result.rows || state.tickets
      ticketRows = state.tickets
      return
    }
    const [localTabs, accounts, queue] = await Promise.all([
      window.pix.counter.tabs(),
      window.pix.counter.accounts({ includeArchived: 1 }),
      window.pix.counter.queueStatus()
    ])
    accountRows = apiValue(localTabs, '读取本地计数实例失败') || []
    accountHistory = apiValue(accounts, '读取计数账号失败') || []
    state.queue = apiValue(queue, '读取同步状态失败') || state.queue
  }

  async function refresh() {
    if (modal.classList.contains('hidden')) return
    if (body.getAttribute('aria-busy') === 'true') {
      refreshQueued = true
      return
    }
    const sequence = ++refreshSequence
    setLoading(true)
    try {
      await loadData()
      if (sequence !== refreshSequence) return
      setAlert('')
      state.loadedAt = new Date()
      render()
      statusText.textContent = '最后更新 ' + formatClock(state.loadedAt) + ' · 自动同步'
      updateQueueBadge(state.queue)
    } catch (error) {
      if (sequence === refreshSequence) renderError(error)
    } finally {
      if (sequence === refreshSequence) setLoading(false)
      if (refreshQueued) {
        refreshQueued = false
        setTimeout(() => refresh(), 80)
      }
    }
  }

  async function openTicket(id) {
    try {
      ticketDetail = apiValue(await window.pix.counter.ticket(id), '读取工单详情失败')
      activeView = 'tickets'
      await refresh()
    } catch (error) {
      setAlert(error.message || '读取工单详情失败', 'error')
    }
  }

  async function switchView(view) {
    if (!tabs.some(tab => tab.dataset.counterView === view)) return
    activeView = view
    if (view !== 'tickets') ticketDetail = null
    markActiveTab()
    await refresh()
    body.scrollTop = 0
  }

  function updateQueueBadge(queue) {
    const queued = Number(queue && queue.pending) || 0
    const failed = Number(queue && queue.failed) || 0
    const total = queued + failed
    badge.textContent = total > 99 ? '99+' : String(total)
    badge.classList.toggle('hidden', !total)
    badge.classList.toggle('failed', failed > 0)
    entry.title = total
      ? (failed ? failed + ' 条进粉事件需要重试' : queued + ' 条进粉事件等待同步')
      : '查看 WhatsApp 进粉、重粉和自动工单'
    entry.setAttribute('aria-label', total
      ? '进粉中心，' + (failed ? failed + ' 条事件需要重试' : queued + ' 条事件等待同步')
      : '进粉中心：查看 WhatsApp 进粉、重粉和自动工单')
  }

  async function refreshBadge() {
    try {
      updateQueueBadge(apiValue(await window.pix.counter.queueStatus(), '读取同步状态失败'))
    } catch (e) {}
  }

  async function openCenter() {
    showOverlay(modal, true)
    document.activeElement && document.activeElement.blur()
    await refresh()
    const active = tabs.find(tab => tab.dataset.counterView === activeView)
    if (active) active.focus()
    clearInterval(refreshTimer)
    refreshTimer = setInterval(() => {
      if (!modal.classList.contains('hidden')) refresh()
    }, 5000)
  }

  function closeCenter() {
    showOverlay(modal, false)
    clearInterval(refreshTimer)
    refreshTimer = null
    entry.focus()
  }

  function trapFocus(event) {
    if (event.key !== 'Tab' || modal.classList.contains('hidden')) return
    const focusable = Array.from(modal.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]'))
      .filter(el => el.offsetParent !== null)
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  entry.addEventListener('click', openCenter)
  closeBtn.addEventListener('click', closeCenter)
  doneBtn.addEventListener('click', closeCenter)
  refreshBtn.addEventListener('click', refresh)
  rangeSelect.addEventListener('change', refresh)
  includeArchived.addEventListener('change', refresh)
  modal.addEventListener('click', event => {
    if (event.target === modal) closeCenter()
  })
  modal.addEventListener('keydown', trapFocus)
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) {
      event.preventDefault()
      closeCenter()
    }
  })

  tabs.forEach(tab => {
    tab.addEventListener('click', () => switchView(tab.dataset.counterView))
    tab.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const index = tabs.indexOf(tab)
      const next = event.key === 'ArrowRight'
        ? tabs[(index + 1) % tabs.length]
        : tabs[(index - 1 + tabs.length) % tabs.length]
      next.focus()
      switchView(next.dataset.counterView)
    })
  })

  body.addEventListener('click', event => {
    const jump = event.target.closest('[data-counter-view-jump]')
    if (jump) {
      switchView(jump.dataset.counterViewJump)
      return
    }
    const ticket = event.target.closest('[data-ticket-id]')
    if (ticket) {
      openTicket(ticket.dataset.ticketId)
      return
    }
    const closeDetail = event.target.closest('[data-ticket-detail-close]')
    if (closeDetail) {
      ticketDetail = null
      render()
      return
    }
    const status = event.target.closest('[data-ticket-status]')
    if (status && ticketDetail && ticketDetail.ticket) {
      const id = ticketDetail.ticket.id
      const next = status.dataset.ticketStatus
      status.disabled = true
      window.pix.counter.transitionTicket({ id, status: next }).then(result => {
        if (result && result.success === false) throw new Error(result.msg || '更新工单失败')
        toast('工单状态已更新')
        return openTicket(id)
      }).catch(error => {
        status.disabled = false
        setAlert(error.message || '更新工单失败', 'error')
      })
      return
    }
    const openTab = event.target.closest('[data-open-tab]')
    if (openTab) {
      window.pix.switchTab(openTab.dataset.openTab)
      closeCenter()
      return
    }
    const action = event.target.closest('[data-counter-action]')
    if (action) {
      if (action.dataset.counterAction === 'retry-queue') {
        action.disabled = true
        window.pix.counter.retryFailed().then(result => {
          if (result && result.success === false) throw new Error(result.msg || '重试失败')
          toast('已重新提交待同步事件')
          return refresh()
        }).catch(error => {
          action.disabled = false
          setAlert(error.message || '重试失败', 'error')
        })
      } else if (action.dataset.counterAction === 'open-app') {
        closeCenter()
        window.pix.home()
      } else {
        refresh()
      }
    }
  })

  if (window.pix && window.pix.counter && typeof window.pix.counter.onUpdated === 'function') {
    window.pix.counter.onUpdated(payload => {
      refreshBadge()
      if (modal.classList.contains('hidden')) return
      if (payload && (payload.status === 'new' || payload.status === 'repeat')) {
        toast(payload.status === 'repeat' ? '识别到一条重粉，已更新计数' : '识别到一条新粉，已更新计数')
      }
      setTimeout(() => refresh(), 240)
    })
  }
  if (window.pix && typeof window.pix.onTabs === 'function') {
    window.pix.onTabs(() => {
      refreshBadge()
      if (!modal.classList.contains('hidden') && activeView === 'accounts') refresh()
    })
  }

  refreshBadge()
  badgeTimer = setInterval(refreshBadge, 20_000)
  window.addEventListener('beforeunload', () => {
    clearInterval(refreshTimer)
    clearInterval(badgeTimer)
  }, { once: true })
})()
