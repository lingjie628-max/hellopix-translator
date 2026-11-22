'use strict'

/**
 * 桌面客户端工单 IPC。
 *
 * 只暴露用户端工单需要的五个固定操作，绝不做“任意 API 转发”：
 * 那个口子一旦开出去，第三方页面或渲染层脚本就能借客户端登录态打
 * 任意商户接口。参数在进入主进程时也要再夹一次长度。
 */

const MAX_SUBJECT = 200
const MAX_BODY = 5000
const CATEGORIES = new Set(['recharge', 'translation', 'login', 'bug', 'feature', 'other'])
const STATUS = new Set(['open', 'new', 'in_progress', 'waiting_user', 'resolved', 'closed', 'all'])

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max)
}

function positiveId(value) {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : 0
}

function fail(msg) {
  return { success: false, msg: msg }
}

function registerTicketIpc(deps) {
  const { reg, actions } = deps

  reg.handle('tickets:list', async (_event, payload) => {
    const data = payload || {}
    const queried = String(data.status || 'open')
    const status = STATUS.has(queried) ? queried : 'open'
    const page = Math.max(1, Math.floor(Number(data.page) || 1))
    const rows = Math.min(50, Math.max(1, Math.floor(Number(data.rows) || 20)))
    const params = new URLSearchParams({ status: status, page: String(page), rows: String(rows) })
    return actions.api('/tickets?' + params.toString())
  })

  reg.handle('tickets:get', async (_event, value) => {
    const id = positiveId(value)
    if (!id) return fail('工单号不合法')
    return actions.api('/tickets/' + id)
  })

  reg.handle('tickets:create', async (_event, payload) => {
    const data = payload || {}
    const subject = text(data.subject, MAX_SUBJECT)
    const body = text(data.body, MAX_BODY)
    const category = CATEGORIES.has(String(data.category || '')) ? String(data.category) : 'other'
    if (subject.length < 2) return fail('请填写工单标题（至少 2 个字）')
    if (!body) return fail('请描述一下遇到的问题')
    return actions.api('/tickets/create', {
      method: 'POST',
      form: { subject: subject, body: body, category: category }
    })
  })

  reg.handle('tickets:reply', async (_event, payload) => {
    const data = payload || {}
    const id = positiveId(data.id)
    const body = text(data.body, MAX_BODY)
    if (!id) return fail('工单号不合法')
    if (!body) return fail('回复内容不能为空')
    return actions.api('/tickets/reply', {
      method: 'POST',
      form: { id: String(id), body: body }
    })
  })

  reg.handle('tickets:unread', () => actions.api('/tickets-unread'))
}

module.exports = { registerTicketIpc, text, positiveId }
