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
    // 唯一约束冲突。
    //
    // 最常见的一种是**下单撞尾数**：两个请求几乎同时通过 allocate() 的
    // 无锁预检、选中同一个 paid_amount，后插入的那个撞
    // `recharges_pending_amount_uq`。这**不是**"数据已存在"那种用户做错了的
    // 语义 —— 用户什么都没做错，换一个尾数再来一次就能成。
    // 把这种情况说成"数据已存在"，用户只会以为账号出了问题、反复重试同一张单，
    // 而每次重试预算里都在重新摇尾数，他看到的却是同一个失败。
    //
    // 这里区分两件事：
    //   · 撞的是订单金额唯一键 → 409 + 明确"请重试"，告诉前端可以自动重发一次
    //   · 其它唯一键（用户名/邮箱/幂等键）→ 保持原来的语义
    const constraint = String(err.constraint || '')
    if (constraint === 'recharges_pending_amount_uq') {
      return res.status(409).json({
        success: false,
        code: 'AMOUNT_COLLISION',
        retryable: true,
        msg: '下单请求撞上了另一个订单的金额，请直接再点一次（系统会重新分配）'
      })
    }
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

/**
 * 开关字段：只认 1/0 的真假形态，其余返回 null 由调用方报 400。
 *
 * 为什么不用 `number()` / `Number()`：
 *   · `Number('')`、`Number(null)`、`Number([])` **全是 0** —— 前端漏传字段
 *     等于"关闭"，而且回一句"已停用"，看起来完全正常；
 *   · `Number('true')`、`Number('no')` 是 NaN，`Boolean(NaN)` 恒为 false。
 *
 * 这个函数与 `core-service.bool()` 的区别：`bool()` 认 "yes"/"on"/"off" 等
 * 更宽的写法（给 README 里那种宽松场景用），`toggle()` 只认开关 UI 真正会发出的值。
 */
function toggle(raw) {
  if (raw === 1 || raw === '1' || raw === true) return 1
  if (raw === 0 || raw === '0' || raw === false) return 0
  return null
}

module.exports = { ApiError, input, pagination, page, ok, asyncRoute, sendError, stub, toggle }
