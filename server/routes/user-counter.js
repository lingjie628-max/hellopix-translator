'use strict'

const { asyncRoute, input } = require('../lib/http')

function registerUserCounter(router, ctx) {
  const service = ctx.services && ctx.services.counter
  if (!service) throw new Error('缺少 CounterService')

  router.post('/counter/accounts/register', asyncRoute(async (req, res) => {
    res.json(await service.registerAccount(req.pixUser, input(req)))
  }))

  router.get('/counter/accounts', asyncRoute(async (req, res) => {
    res.json(await service.listAccounts(req.pixUser, input(req)))
  }))

  router.post('/counter/accounts/archive', asyncRoute(async (req, res) => {
    res.json(await service.archiveAccount(req.pixUser, input(req).id))
  }))

  router.post('/counter/inbound', ctx.limits.counterEventIp, ctx.limits.counterEventAccount,
    asyncRoute(async (req, res) => {
      res.json(await service.ingest(req.pixUser, input(req)))
    }))

  router.get('/counter/summary', asyncRoute(async (req, res) => {
    res.json(await service.summary(req.pixUser, input(req)))
  }))

  router.get('/counter/events', asyncRoute(async (req, res) => {
    res.json(await service.events(req.pixUser, input(req)))
  }))

  router.get('/counter/repeats', asyncRoute(async (req, res) => {
    res.json(await service.repeats(req.pixUser, input(req)))
  }))

  router.get('/counter/tickets', asyncRoute(async (req, res) => {
    res.json(await service.listTickets(req.pixUser, input(req)))
  }))

  router.get('/counter/tickets/:id', asyncRoute(async (req, res) => {
    res.json(await service.getTicket(req.pixUser, req.params.id))
  }))

  router.post('/counter/tickets/transition', asyncRoute(async (req, res) => {
    res.json(await service.transitionTicket(req.pixUser, input(req)))
  }))

  router.post('/counter/tickets/reply', asyncRoute(async (req, res) => {
    res.json(await service.replyTicket(req.pixUser, input(req)))
  }))
}

module.exports = { registerUserCounter }
