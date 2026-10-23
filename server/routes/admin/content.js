'use strict'

/**
 * 后台 · 内容运营：邮件服务、客户档案、合并候选、撞号设置。
 *
 * 从 admin.js 拆出（原 1278 行按业务域拆成 6 个文件）。
 * 这些路由原本挨在 `registerAdminContent` 里，注册顺序未变。
 */

const { asyncRoute, input, pagination, ApiError } = require('../../lib/http')
const { objectSetting, readAlertTo, maskEmail } = require('../../lib/mailer')

function registerAdminContent(router, ctx) {
  const { repo, customers, accounts } = ctx


  router.get('/admin/mail', asyncRoute(async (_req, res) => {
    const settings = await repo.settings()
    // 键是扁平的 'mail.smtp'，不是 settings.mail.smtp —— 读错位置会永远显示"未配置"
    const smtp = objectSetting(settings, 'mail.smtp', {})
    const cfg = await accounts.mailer.config()
    res.json({
      host: smtp.host || '',
      port: smtp.port || 465,
      secure: smtp.secure !== false,
      user: smtp.user || '',
      pass: smtp.pass ? '********' : '',
      from: smtp.from || '',
      fromName: smtp.fromName || 'Hello Pix',
      // 只返回打码地址：前端只需要确认"告警发给谁"，不需要完整邮箱。
      // 完整地址永远是业主的私人邮箱，泄露一次就等于泄露真名。
      alertTo: maskEmail(readAlertTo(settings)),
      configured: cfg.configured,
      missing: cfg.missing
    })
  }))

  router.post('/admin/mail', asyncRoute(async (req, res) => {
    const data = input(req)
    const settings = await repo.settings()
    const current = objectSetting(settings, 'mail.smtp', {})
    const smtp = {
      host: String(data.host || '').trim(),
      port: Number(data.port) || 465,
      secure: data.secure !== false && data.secure !== 'false',
      user: String(data.user || '').trim(),
      // 提交的是掩码说明管理员没改密码 —— 保持原值，别把真密码覆盖成星号
      pass: data.pass === '********' ? (current.pass || '') : String(data.pass || ''),
      from: String(data.from || '').trim(),
      fromName: String(data.fromName || 'Hello Pix').trim()
    }
    // 与 /admin/settings/save 用同一套写法：事务 + 审计。
    // 仓储层没有 upsertSetting 这个方法（我先写了才发现），
    // 实际都是 inline 的 ON CONFLICT —— 抽出来反而会让两处行为分叉。
    await repo.transaction(async client => {
      await repo.query(
        `INSERT INTO app_settings(key,value,description) VALUES($1,$2::jsonb,$3)
         ON CONFLICT (key) DO UPDATE SET value=$2::jsonb`,
        ['mail.smtp', JSON.stringify(smtp), 'SMTP 服务器配置'], client
      )
      // 告警收件地址单独存：它可以在 SMTP 还没配好之前就先填上，
      // 而巡检脚本正是靠它把"服务挂了"这类消息发出去。
      //
      // ★ 不传该字段 = 保持原值，不是清空 ★
      //
      // 前端现在拿到的是**打码地址**（li***@gmail.com），它不再回填输入框：
      // 管理员只改端口时，payload 里根本没有 alertTo。原来这里
      // `String(data.alertTo || '')` 会把它存成空串，告警从此发不出去，
      // 而且界面上看不出来 —— 只有真出事时才暴露。
      // 想清空就明确传空串 `""`（前端"留空保持不变"依赖这个区分）。
      const alertToGiven = data.alertTo !== undefined
      const alertTo = String(data.alertTo || '').trim()
      if (alertToGiven) {
        await repo.query(
          `INSERT INTO app_settings(key,value,description) VALUES($1,$2::jsonb,$3)
           ON CONFLICT (key) DO UPDATE SET value=$2::jsonb`,
          ['mail.alert_to', JSON.stringify(alertTo), '运维告警收件地址'], client
        )
      }
      await repo.audit(client, req.pixAdmin, '修改邮件服务配置',
        smtp.host + ' / ' + smtp.from, req.ip, { type: 'settings' })
    })
    res.json({ ok: true, configured: await accounts.mailer.configured(), missing: (await accounts.mailer.config()).missing })
  }))

  router.post('/admin/mail/test', asyncRoute(async (req, res) => {
    const to = String((req.body && req.body.to) || '').trim()
    const result = await accounts.mailer.sendTest(to)
    if (result.ok) return res.json(result)
    const status = result.code === 'MAIL_NOT_CONFIGURED' ? 503
      : (result.code === 'BAD_EMAIL' ? 400 : 502)
    res.status(status).json(result)
  }))

  router.get('/admin/customers', asyncRoute(async (req, res) => {
    const { keyword } = req.query
    // listCustomers 自己就返回 { rows, total } ——
    // 不要再调 countCustomers：那是仓储层的方法，服务层没有透出，
    // 而且它跑的是同一条 count 查询，重复一次没有意义。
    const { limit, offset } = pagination(req, 50)
    res.json(await customers.listCustomers({ keyword, limit, offset }))
  }))

  router.get('/admin/customers/:id', asyncRoute(async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, '客户编号不正确', 'BAD_ID')
    const detail = await customers.customerDetail(id)
    if (!detail) throw new ApiError(404, '客户不存在', 'NOT_FOUND')
    res.json(detail)
  }))

  router.get('/admin/merge-candidates', asyncRoute(async (req, res) => {
    res.json({ rows: await customers.listMergeCandidates(req.query.status || 'pending') })
  }))

  router.post('/admin/merge-candidates/:id/resolve', asyncRoute(async (req, res) => {
    const id = Number(req.params.id)
    const action = String((req.body && req.body.action) || '')
    if (!['merge', 'reject'].includes(action)) {
      throw new ApiError(400, 'action 只能是 merge 或 reject', 'BAD_ACTION')
    }
    res.json(await customers.resolveMergeCandidate(id, action, req.pixAdmin && req.pixAdmin.id))
  }))

  router.get('/admin/collisions', asyncRoute(async (_req, res) => {
    res.json({ rows: await customers.collisionHistory(100) })
  }))

  router.get('/admin/collision-settings', asyncRoute(async (_req, res) => {
    res.json(await customers.collisionConfig())
  }))

  router.put('/admin/collision-settings', asyncRoute(async (req, res) => {
    res.json(await customers.saveCollisionConfig(input(req), req.pixAdmin && req.pixAdmin.id))
  }))

}

module.exports = { registerAdminContent }

/** 本文件包含的路由（仅供文档与调试参考）
 *   GET   /admin/mail
 *   POST  /admin/mail
 *   POST  /admin/mail/test
 *   GET   /admin/customers
 *   GET   /admin/customers/:id
 *   GET   /admin/merge-candidates
 *   POST  /admin/merge-candidates/:id/resolve
 *   GET   /admin/collisions
 *   GET   /admin/collision-settings
 *   PUT   /admin/collision-settings
 */
