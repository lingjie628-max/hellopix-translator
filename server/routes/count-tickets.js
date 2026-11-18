'use strict'

/**
 * 商户端原生计数工单。
 *
 * 归属统一取 session.parent.id：主账号和子账号都操作同一个商户的数据，
 * 但绝不接受前端传入的 user_id。分页和详情每次都会再校验归属。
 */
const { asyncRoute, input, ok, ApiError } = require('../lib/http')

function ownerOf(req, countTickets) {
  const session = req.pixUser
  if (!session || !session.parent || !session.parent.id) {
    throw new ApiError(401, '请先登录', 'USER_AUTH_REQUIRED')
  }
  if (!countTickets.isEntitled(session.parent)) {
    throw new ApiError(403, '当前套餐不包含计数工单，请升级专业版', 'COUNT_PLAN_REQUIRED')
  }
  return Number(session.parent.id)
}

function registerCountTickets(router, ctx) {
  const { countTickets } = ctx

  router.get('/count-tickets', asyncRoute(async (req, res) => {
    res.json(await countTickets.list(ownerOf(req, countTickets), input(req)))
  }))

  // 静态路径必须排在 /:id 之前，否则 "available-accounts" 会被当成工单号。
  router.get('/count-tickets/available-accounts', asyncRoute(async (req, res) => {
    res.json({ rows: await countTickets.availableAccounts(ownerOf(req, countTickets)) })
  }))

  router.get('/count-tickets/:id', asyncRoute(async (req, res) => {
    res.json(await countTickets.detail(req.params.id, {
      userId: ownerOf(req, countTickets)
    }))
  }))

  router.get('/count-tickets/:id/fans', asyncRoute(async (req, res) => {
    res.json(await countTickets.fans(req.params.id, {
      userId: ownerOf(req, countTickets)
    }, input(req)))
  }))

  router.post('/count-tickets/save', asyncRoute(async (req, res) => {
    const result = await countTickets.saveTicket(ownerOf(req, countTickets), input(req))
    ok(res, result.id ? '计数工单已保存' : '计数工单已创建', { id: result.id })
  }))

  router.post('/count-tickets/accounts/save', asyncRoute(async (req, res) => {
    await countTickets.saveAccount(ownerOf(req, countTickets), input(req))
    ok(res, '账号已绑定')
  }))

  router.post('/count-tickets/accounts/remove', asyncRoute(async (req, res) => {
    await countTickets.removeAccount(ownerOf(req, countTickets), input(req))
    ok(res, '账号已停用')
  }))
}

module.exports = { registerCountTickets }
