'use strict'

class ApiError extends Error {
  constructor(status, message, code, details) {
    super(message)
    this.status = status
    this.code = code || 'API_ERROR'
    // 可选的结构化补充数据（如"删除会波及哪些表、各多少条"）。
    // 前端要据此渲染"你确定要删吗"的二次确认弹窗，光有 msg 一句话不够。
    this.details = details || null
  }
}

function input(req) {
  return Object.assign({}, req.query || {}, req.body || {})
}

function positiveInt(value, fallback, max) {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(number, max || Number.MAX_SAFE_INTEGER)
}

function pagination(req, defaults) {
  const data = input(req)
  const size = positiveInt(data.rows || data.pageSize || data.limit, (defaults && defaults.size) || 20, 100)
  const page = positiveInt(data.page || data.pageNum, 1)
  return { page, size, offset: (page - 1) * size }
}

function page(rows, total, paging) {
  return { rows, total: Number(total || 0), page: paging.page, pageSize: paging.size }
}

function ok(res, msg, extra) {
  res.json(Object.assign({ success: 'success', msg: msg || '操作成功' }, extra || {}))
}

function asyncRoute(handler) {
  return function route(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next)
  }
}

function sendError(err, _req, res, next) {
  if (res.headersSent) return next(err)
  if (err instanceof ApiError) {
    const body = { success: false, code: err.code, msg: err.message }
    if (err.details) body.details = err.details
    return res.status(err.status).json(body)
  }
  if (err && err.code === '23505') {
    return res.status(409).json({ success: false, code: 'CONFLICT', msg: '数据已存在' })
  }
  next(err)
}

function stub(module, reason) {
  return function notMigrated(_req, res) {
    res.status(503).json({
      success: false,
      code: 'NOT_MIGRATED',
      module,
      retryable: false,
      msg: reason || '该模块尚未迁移到正式持久化服务'
    })
  }
}

module.exports = { ApiError, input, pagination, page, ok, asyncRoute, sendError, stub }
