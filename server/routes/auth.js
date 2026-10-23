'use strict'

/**
 * 认证路由：商户端登录、客户端登录、超管登录与两步验证。
 *
 * 从 `production.js` 拆出。**纯搬移** —— 逻辑、SQL、响应格式全部保持原样。
 *
 * ## 为什么认证单独一个文件
 *
 * 它是全站安全边界最集中的地方：图形验证码、限流、会话下发、
 * 两步验证票据。任何一处改动都应该能在一个文件里看清楚。
 * 混在 2000 行里时，评审很难确认"这次改动没碰认证逻辑"。
 *
 * ## 为什么要分两段注册
 *
 * 原文件里认证路由**不是连在一起**的：
 *
 * ```
 *   /login, /user/captcha, /logout, /client/*        ← 前段
 *   /client/platforms … /customer/reminders          ← 中间夹着一堆业务路由
 *   /admin/login, /admin/totp/*, /admin/logout       ← 后段
 *   /admin/stats …
 * ```
 *
 * Express 按注册顺序匹配，把两段合并到最前面会改变匹配语义
 * （参数化路由与静态路由的相对位置一变，就可能出现"列表请求被单条路由吞掉"）。
 * 所以拆成 `registerUserAuth` 与 `registerAdminAuth`，
 * 由 production.js 在原来的两个位置分别调用，顺序**逐条不变**。
 */

const { asyncRoute, input, ok, ApiError } = require('../lib/http')
const captcha = require('../lib/captcha')

/**
 * 前段：商户端与客户端认证。
 * 在原文件中位于 `router.use(security.csrf)` 之后、`/client/platforms` 之前。
 *
 * @param {import('express').Router} router
 * @param {object} ctx 见 routes/context.js
 */
function registerUserAuth(router, ctx) {
  const { auth, core, security, limits, publicUser } = ctx

  router.post('/login',
    limits.loginIp, limits.loginAccount,
    asyncRoute(async (req, res) => {
      const data = input(req)
      const captchaCheck = await captcha.consume(core.redis, data.imageId, data.imageCode)
      if (!captchaCheck.ok) throw new ApiError(400, captchaCheck.message, captchaCheck.code)
      const session = await auth.loginUser(req, res, data, false)
      res.json({ success: true, msg: '登录成功', obj: publicUser(session) })
    }))

  router.get('/user/captcha', limits.captcha, asyncRoute(async (_req, res) => {
    res.json(Object.assign({ success: true }, await captcha.issue(core.redis)))
  }))

  router.post('/logout', asyncRoute(async (req, res) => {
    await security.destroySession(req, res, 'user')
    ok(res, '已退出')
  }))

  router.post('/client/login',
    limits.clientLoginIp, limits.loginAccount,
    asyncRoute(async (req, res) => {
      const session = await auth.loginUser(req, res, input(req), true)
      res.json({ success: true, msg: '登录成功', obj: core.profile(session) })
    }))

  router.get('/client/session', asyncRoute(async (req, res) => {
    res.json({ success: true, obj: core.profile(req.pixUser) })
  }))

  router.post('/client/logout', asyncRoute(async (req, res) => {
    await security.destroySession(req, res, 'user')
    ok(res, '已退出')
  }))
}

/**
 * 后段：超管登录与两步验证。
 * 在原文件中位于 `/client/lines` 之后、`/admin/stats` 之前。
 */
function registerAdminAuth(router, ctx) {
  const { auth, core, security, limits, services } = ctx
  const { adminTotp } = services

  router.post('/admin/login',
    limits.adminLoginIp, limits.loginAccount,
    asyncRoute(async (req, res) => {
      const data = input(req)
      // 图形验证码：超管是全站最高价值目标，前置阻力不能比商户端还弱
      const captchaCheck = await captcha.consume(core.redis, data.imageId, data.imageCode)
      if (!captchaCheck.ok) throw new ApiError(400, captchaCheck.message, captchaCheck.code)

      const admin = await auth.verifyAdminCredentials(req, data)

      if (admin.totpEnabled) {
        // 已开两步验证：这一步只发一次性票据，**不给会话**
        const { ticket, expiresInMs } = await adminTotp.issueLoginTicket(admin)
        return res.json({
          success: true,
          needTotp: true,
          ticket,
          expiresInMs,
          msg: '请输入验证器上的 6 位动态码'
        })
      }

      await auth.startAdminSession(req, res, admin)
      res.json({
        success: true,
        obj: {
          // id 必须回：前端要靠它判断"正在编辑的是不是自己"，
          // 才能正确锁住「唯一超管不能降级自己」那个选项。
          // 不回的话前端只能靠 username 猜，而 username 不区分大小写，
          // 猜错一次就锁不住 —— 这类"看起来有保护其实没生效"最危险。
          id: Number(admin.id),
          username: admin.username,
          nickname: admin.nickname,
          role: admin.role || 'superadmin',
          totpEnabled: false
        }
      })
    }))

  router.post('/admin/login/totp', limits.adminTotp, asyncRoute(async (req, res) => {
    const data = input(req)
    const { admin, usedRecovery } = await adminTotp.completeLogin(data.ticket, data.code, req.ip)
    await auth.startAdminSession(
      req, res, admin, usedRecovery ? '使用恢复码登录超管后台' : '登录超管后台（两步验证）'
    )
    res.json({
      success: true,
      usedRecovery: !!usedRecovery,
      obj: {
        // 同 /admin/login：id 是前端判断"在编辑自己"的依据
        id: Number(admin.id),
        username: admin.username,
        nickname: admin.nickname,
        role: admin.role || 'superadmin',
        totpEnabled: true
      }
    })
  }))

  router.get('/admin/totp', limits.adminTotpOp, asyncRoute(async (req, res) => {
    res.json(Object.assign({ success: true }, await adminTotp.status(req.pixAdmin)))
  }))

  router.post('/admin/totp/setup', limits.adminTotpOp, asyncRoute(async (req, res) => {
    res.json(Object.assign({ success: true }, await adminTotp.beginSetup(req.pixAdmin)))
  }))

  router.post('/admin/totp/enable', limits.adminTotpOp, asyncRoute(async (req, res) => {
    const { recoveryCodes } = await adminTotp.enable(req.pixAdmin, input(req).code, req.ip)
    // 恢复码只在此刻返回一次，之后库里只有哈希，谁也取不回明文
    res.json({ success: true, recoveryCodes, msg: '两步验证已开启' })
  }))

  router.post('/admin/totp/disable', limits.adminTotpOp, asyncRoute(async (req, res) => {
    await adminTotp.disable(req.pixAdmin, input(req).code, req.ip)
    // 与同组其它端点保持一致用 success:true。
    // 项目里的 ok() 辅助返回的是 success:'success'（字符串），两种风格并存，
    // 前端靠真值判断都能用，但同一组接口混着来迟早会坑到调用方。
    res.json({ success: true, msg: '两步验证已关闭' })
  }))

  router.post('/admin/totp/recovery', limits.adminTotpOp, asyncRoute(async (req, res) => {
    const { recoveryCodes } = await adminTotp.regenerateRecovery(req.pixAdmin, input(req).code, req.ip)
    res.json({ success: true, recoveryCodes, msg: '恢复码已重新生成' })
  }))

  router.post('/admin/logout', asyncRoute(async (req, res) => {
    await security.destroySession(req, res, 'admin')
    ok(res, '已退出')
  }))
}

module.exports = { registerUserAuth, registerAdminAuth }
