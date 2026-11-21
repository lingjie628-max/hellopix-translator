'use strict'

const { asyncRoute, input, ok } = require('../../lib/http')

function registerAdminSignal(router, ctx) {
  const { signalIntegration } = ctx

  router.get('/admin/integrations/signal', asyncRoute(async (_req, res) => {
    res.json(await signalIntegration.adminState())
  }))

  router.post('/admin/integrations/signal/save', asyncRoute(async (req, res) => {
    const result = await signalIntegration.saveAdminSettings(
      req.pixAdmin,
      input(req),
      req.ip
    )
    ok(res, 'Signal 对接配置已保存', result)
  }))
}

module.exports = { registerAdminSignal }
