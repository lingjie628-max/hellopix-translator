/**
 * 用户自助工单中心。
 *
 * 工单接口一直存在，但桌面客户端没有入口。这里直接复用主进程登录态，
 * 用户不需要另外打开网页登录；所有文案都用 textContent 渲染，避免工单
 * 内容里的 HTML 反过来注入外壳。
 */

const ticketState = {
  rows: [],
  current: null,
  unread: 0,
  timer: 0,
  loading: false,
  sending: false,
  creating: false
}

function ticketDate(value) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = n => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function ticketError(data, fallback) {
  return (data && (data.msg || data.message)) || fallback
}

function ticketSetBadge(value) {
  const badge = document.getElementById('ticketBadge')
  if (!badge) return
  ticketState.unread = Math.max(0, Number(value) || 0)
  badge.textContent = ticketState.unread > 99 ? '99+' : String(ticketState.unread)
  badge.classList.toggle('hidden', ticketState.unread <= 0)
}

function ticketShowCompose(on) {
  document.getElementById('ticketWorkspace').classList.toggle('hidden', on)
  document.getElementById('ticketCompose').classList.toggle('hidden', !on)
  document.getElementById('ticketComposeMsg').textContent = ''
  if (on) document.getElementById('ticketSubject').focus()
}

function ticketRenderList() {
  const list = document.getElementById('ticketList')
  list.innerHTML = ''
  if (!ticketState.rows.length) {
    const empty = document.createElement('div')
    empty.className = 'ticket-empty'
    empty.textContent = '还没有工单。点上方「新建工单」，把问题写清楚，客服会尽快回复。'
    list.appendChild(empty)
    return
  }
  ticketState.rows.forEach(row => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'ticket-item' + (ticketState.current && ticketState.current.id === row.id ? ' active' : '')
    const head = document.createElement('span')
    head.className = 'ticket-item-head'
    const subject = document.createElement('b')
    subject.textContent = row.subject || ('工单 #' + row.id)
    const badge = document.createElement('i')
    badge.textContent = row.statusLabel || row.status || ''
    head.appendChild(subject)
    head.appendChild(badge)
    const meta = document.createElement('span')
    meta.className = 'ticket-item-meta'
    meta.textContent = '#' + row.id + ' · ' + (row.categoryLabel || row.category || '其他') +
      ' · ' + ticketDate(row.lastReplyAt || row.createdAt)
    item.appendChild(head)
    item.appendChild(meta)
    item.onclick = () => ticketOpenDetail(row.id)
    list.appendChild(item)
  })
}

function ticketRenderDetail(data) {
  const detail = document.getElementById('ticketDetail')
  detail.innerHTML = ''
  const ticket = data && data.ticket
  if (!ticket) {
    const empty = document.createElement('div')
    empty.className = 'ticket-empty'
    empty.textContent = '选择左侧工单查看对话'
    detail.appendChild(empty)
    return
  }
  ticketState.current = ticket
  ticketRenderList()

  const head = document.createElement('div')
  head.className = 'ticket-detail-head'
  const title = document.createElement('div')
  const subject = document.createElement('b')
  subject.textContent = ticket.subject
  const meta = document.createElement('span')
  meta.textContent = '#' + ticket.id + ' · ' + (ticket.categoryLabel || ticket.category || '其他')
  title.appendChild(subject)
  title.appendChild(meta)
  const status = document.createElement('i')
  status.textContent = ticket.statusLabel || ticket.status
  head.appendChild(title)
  head.appendChild(status)
  detail.appendChild(head)

  const stream = document.createElement('div')
  stream.className = 'ticket-stream'
  ;(data.messages || []).forEach(message => {
    const line = document.createElement('div')
    line.className = 'ticket-message ' + String(message.authorType || 'user')
    const bubble = document.createElement('p')
    bubble.textContent = message.body || ''
    const who = document.createElement('span')
    const author = message.authorType === 'admin'
      ? ('客服' + (message.authorName ? ' ' + message.authorName : ''))
      : message.authorType === 'system' ? '系统' : (message.authorName || '我')
    who.textContent = author + ' · ' + ticketDate(message.createdAt)
    line.appendChild(bubble)
    line.appendChild(who)
    stream.appendChild(line)
  })
  detail.appendChild(stream)

  if (ticket.status === 'closed') {
    const closed = document.createElement('p')
    closed.className = 'ticket-closed'
    closed.textContent = '这张工单已关闭。如果问题还在，请新建一张工单并附上 #' + ticket.id
    detail.appendChild(closed)
    return
  }

  const reply = document.createElement('div')
  reply.className = 'ticket-reply'
  const input = document.createElement('textarea')
  input.id = 'ticketReply'
  input.maxLength = 5000
  input.rows = 3
  input.placeholder = '补充说明，Enter 换行'
  const send = document.createElement('button')
  send.type = 'button'
  send.className = 'primary'
  send.textContent = '发送'
  send.onclick = ticketSendReply
  reply.appendChild(input)
  reply.appendChild(send)
  detail.appendChild(reply)
}

async function ticketLoadList() {
  if (ticketState.loading) return
  ticketState.loading = true
  const list = document.getElementById('ticketList')
  list.innerHTML = '<div class="ticket-empty">正在加载工单…</div>'
  try {
    const data = await window.pix.ticketList({
      status: document.getElementById('ticketStatus').value,
      page: 1,
      rows: 30
    })
    if (data && Array.isArray(data.rows)) {
      ticketState.rows = data.rows
      ticketRenderList()
    } else {
      list.innerHTML = ''
      const failed = document.createElement('div')
      failed.className = 'ticket-empty'
      failed.textContent = ticketError(data, '工单加载失败')
      list.appendChild(failed)
    }
  } catch (error) {
    list.innerHTML = ''
    const failed = document.createElement('div')
    failed.className = 'ticket-empty'
    failed.textContent = (error && error.message) || '工单加载失败'
    list.appendChild(failed)
  } finally {
    ticketState.loading = false
  }
}

async function ticketOpenDetail(id) {
  try {
    const data = await window.pix.ticketGet(id)
    if (!data || !data.ticket) {
      toast(ticketError(data, '工单加载失败'), 'warn')
      return
    }
    ticketRenderDetail(data)
    await ticketRefreshUnread()
  } catch (error) {
    toast((error && error.message) || '工单加载失败', 'warn')
  }
}

async function ticketSubmitCreate() {
  if (ticketState.creating) return
  const subject = document.getElementById('ticketSubject').value.trim()
  const body = document.getElementById('ticketBody').value.trim()
  const message = document.getElementById('ticketComposeMsg')
  if (!subject) {
    message.textContent = '请填写标题'
    return
  }
  if (!body) {
    message.textContent = '请填写详细描述'
    return
  }
  ticketState.creating = true
  const button = document.getElementById('ticketSubmit')
  button.disabled = true
  button.textContent = '提交中…'
  try {
    const data = await window.pix.ticketCreate({
      category: document.getElementById('ticketCategory').value,
      subject: subject,
      body: body
    })
    if (!data || data.success !== 'success') {
      message.textContent = ticketError(data, '提交失败')
      return
    }
    document.getElementById('ticketSubject').value = ''
    document.getElementById('ticketBody').value = ''
    document.getElementById('ticketStatus').value = 'open'
    ticketShowCompose(false)
    await ticketLoadList()
    if (data.obj && data.obj.id) await ticketOpenDetail(data.obj.id)
    toast(data.msg || '工单已提交')
  } catch (error) {
    message.textContent = (error && error.message) || '提交失败'
  } finally {
    ticketState.creating = false
    button.disabled = false
    button.textContent = '提交工单'
  }
}

async function ticketSendReply() {
  if (ticketState.sending || !ticketState.current) return
  const input = document.getElementById('ticketReply')
  const body = String((input && input.value) || '').trim()
  if (!body) return toast('请输入回复内容', 'warn')
  ticketState.sending = true
  try {
    const data = await window.pix.ticketReply({ id: ticketState.current.id, body: body })
    if (!data || data.success !== 'success') {
      toast(ticketError(data, '回复失败'), 'warn')
      return
    }
    input.value = ''
    await ticketOpenDetail(ticketState.current.id)
    await ticketLoadList()
    toast('已回复')
  } catch (error) {
    toast((error && error.message) || '回复失败', 'warn')
  } finally {
    ticketState.sending = false
  }
}

async function ticketRefreshUnread() {
  if (!window.pix.ticketUnread) return
  try {
    const data = await window.pix.ticketUnread()
    ticketSetBadge(data && data.unread)
  } catch (error) {}
}

function ticketStart() {
  ticketRefreshUnread()
  if (ticketState.timer) clearInterval(ticketState.timer)
  ticketState.timer = setInterval(() => {
    if (!document.hidden) ticketRefreshUnread()
  }, 60000)
}

function ticketStop() {
  if (ticketState.timer) clearInterval(ticketState.timer)
  ticketState.timer = 0
  ticketSetBadge(0)
}

function ticketOpen() {
  ticketShowCompose(false)
  document.getElementById('ticketDetail').innerHTML = '<div class="ticket-empty">选择左侧工单查看对话</div>'
  ticketState.current = null
  showOverlay(document.getElementById('ticketPanel'), true)
  ticketLoadList()
  ticketRefreshUnread()
}

document.getElementById('ticketBtn').onclick = ticketOpen
document.getElementById('ticketClose').onclick = () => showOverlay(document.getElementById('ticketPanel'), false)
bindModalDismiss(document.getElementById('ticketPanel'))
document.getElementById('ticketNew').onclick = () => ticketShowCompose(true)
document.getElementById('ticketCancelCreate').onclick = () => ticketShowCompose(false)
document.getElementById('ticketSubmit').onclick = ticketSubmitCreate
document.getElementById('ticketReload').onclick = ticketLoadList
document.getElementById('ticketStatus').onchange = ticketLoadList
document.addEventListener('keydown', event => {
  const panel = document.getElementById('ticketPanel')
  if (event.key === 'Escape' && panel && !panel.classList.contains('hidden')) {
    showOverlay(panel, false)
  }
})
