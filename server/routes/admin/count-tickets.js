'use strict'

/**
 * 超管只读查看计数工单。
 *
 * 这里没有写接口：工单归属和账号绑定由商户自己维护。超管只排查数据、
 * 核对统计，不替商户改账。涉及粉丝明细，能力统一使用 admin.data.customers，
 * 普通 operator 不可见。
 */
const { asyncRoute, input } = require('../../lib/http')

function registerAdminCountTickets(router, ctx) {
  const { countTickets } = ctx

  router.get('/admin/count-tickets', asyncRoute(async (req, res) => {
    res.json(await countTickets.list(null, input(req)))
  }))

  router.get('/admin/count-tickets/:id', asyncRoute(async (req, res) => {
    res.json(await countTickets.detail(req.params.id, { admin: true }))
  }))

  router.get('/admin/count-tickets/:id/fans', asyncRoute(async (req, res) => {
    res.json(await countTickets.fans(req.params.id, { admin: true }, input(req)))
  }))
}

module.exports = { registerAdminCountTickets }
