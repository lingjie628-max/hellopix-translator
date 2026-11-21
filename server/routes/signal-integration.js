'use strict'

const { input, ok } = require('../lib/http')
const { openApiError } = require('../services/signal-integration-service')

function errorResponse(res, error, requestId) {
  const mapped = openApiError(error, requestId)
  if (mapped.httpStatus === 429) res.set('Retry-After', '60')
  res.status(mapped.httpStatus).json(mapped.body)
}

function registerSignalIntegration(router, ctx) {
  const { signalIntegration } = ctx

  // 这是外部服务接入入口：不走网页 Cookie/CSRF，只认独立 Bearer Token。
  router.post('/v1/translate', async (req, res) => {
    const requestId = String(req.get('Idempotency-Key') || '').slice(0, 200)
    try {
      const result = await signalIntegration.translate(
        req,
        input(req),
        req.get('Idempotency-Key')
      )
      res.json(result)
    } catch (error) {
      errorResponse(res, error, requestId)
    }
  })

  router.post('/integrations/signal/workorder-events', async (req, res) => {
    try {
      const result = await signalIntegration.ingestEvent(req, input(req))
      ok(res, result.duplicate ? '事件已处理' : '事件已接收', result)
    } catch (error) {
      res.status(Number(error && (error.status || error.statusCode)) || 400).json({
        success: false,
        code: String((error && error.code) || 'SIGNAL_EVENT_FAILED'),
        msg: String((error && (error.message || error.msg)) || '事件处理失败')
      })
    }
  })
}

module.exports = { registerSignalIntegration, errorResponse }
