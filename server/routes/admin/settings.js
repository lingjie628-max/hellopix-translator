'use strict'

/**
 * 后台 · 配置：套餐、系统设置、验证码通道。
 *
 * 写入逻辑大多已下沉到 services（package-service / settings-service），
 * 这里只负责路由外壳与小工具。
 */

const { asyncRoute, input, ok, ApiError } = require('../../lib/http')
const { objectSetting } = require('../../lib/mailer')

function registerAdminSettings(router, ctx) {
  const { repo, core, customers, accounts } = ctx
  const { packages, settings } = ctx.services

  async function packagesWithEngines() {
    const rows = await repo.packages()
    const links = await repo.query('SELECT package_id, engine_id FROM package_engines ORDER BY engine_id')
    const byPackage = {}
    for (const link of links.rows) {
      const key = String(link.package_id)
      if (!byPackage[key]) byPackage[key] = []
      byPackage[key].push(link.engine_id)
    }
    return rows.map(row => Object.assign(row, { engines: byPackage[String(row.id)] || [] }))
  }

  const VERIFY_DEFAULTS = [
    { id: 'email', name: '邮箱验证码', kind: '邮箱', provider: 'smtp', revealDemo: 0,
      resendSeconds: 60, expireMin: 10, digits: 6, note: '注册与找回密码的发信通道' },
    { id: 'sms', name: '短信验证码', kind: '短信', provider: 'local', revealDemo: 0,
      resendSeconds: 60, expireMin: 5, digits: 6, note: '短信通道未接入，保留配置位' }
  ]

  router.get('/admin/packages', asyncRoute(async (_req, res) => {
    res.json(await packagesWithEngines())
  }))

  router.post('/admin/packages/save', asyncRoute(async (req, res) => {
    // 校验、归一化与事务写入都在 services/package-service.js。
    // 这条路由原本有 178 行，把三件事揉在一起，改一个字段要读完整段。
    const saved = await packages.save(input(req), req.pixAdmin, req.ip)
    ok(res, input(req).id ? '套餐已更新' : '套餐已创建', { id: saved })
  }))

  router.post('/admin/packages/retire', asyncRoute(async (req, res) => {
    const title = await packages.retire(input(req), req.pixAdmin, req.ip)
    ok(res, `已下架「${title}」`)
  }))

  router.get('/admin/settings', asyncRoute(async (_req, res) => {
    res.json(await settings.read())
  }))

  router.post('/admin/settings/save', asyncRoute(async (req, res) => {
    await settings.save(input(req), req.pixAdmin, req.ip)
    ok(res, '设置已保存')
  }))

  router.get('/admin/verify', asyncRoute(async (_req, res) => {
    const row = (await repo.query("SELECT value FROM app_settings WHERE key='verify.channels'")).rows[0]
    const saved = row && Array.isArray(row.value) ? row.value : []
    const byId = saved.reduce((out, item) => { if (item && item.id) out[item.id] = item; return out }, {})
    const settings = await repo.settings()
    const smtp = objectSetting(settings, 'mail.smtp', {})
    const cfg = await accounts.mailer.config()
    const ready = cfg.configured

    const rows = VERIFY_DEFAULTS.map(item => {
      const merged = Object.assign({}, item, byId[item.id] || {})
      if (item.id !== 'email') {
        return Object.assign(merged, {
          providerName: '本地 SVG（不发短信）', wired: false, wiredText: '未接通', hasKey: false
        })
      }
      return Object.assign(merged, {
        providerName: ready ? 'SMTP（已接通）' : 'SMTP（未接通）',
        wired: ready,
        wiredText: ready ? '已接通' : '未接通',
        // 密钥是否已填：看的是真实配置，不是写死的 false
        hasKey: Boolean(smtp.pass && smtp.user),
        smtpHost: smtp.host || '',
        smtpPort: Number(smtp.port) || 465,
        smtpSecure: smtp.secure === false ? 0 : 1,
        smtpUser: smtp.user || '',
        smtpFrom: smtp.from || '',
        // 口令永不回传明文，只回"已配置"
        smtpPass: smtp.pass ? '********' : '',
        missing: ready ? [] : cfg.missing
      })
    })

    res.json({
      rows,
      smtpReady: ready,
      note: ready
        ? 'SMTP 已接通，注册与找回密码可正常发信'
        : 'SMTP 未接通，缺少：' + (cfg.missing.join('、') || '未知') +
          '。补齐后注册与找回密码立即生效。'
    })
  }))

  router.post('/admin/verify/save', asyncRoute(async (req, res) => {
    const data = input(req)
    const id = String(data.id || '').trim()
    if (!VERIFY_DEFAULTS.some(item => item.id === id)) {
      throw new ApiError(404, '验证通道不存在', 'VERIFY_CHANNEL_NOT_FOUND')
    }
    const row = (await repo.query("SELECT value FROM app_settings WHERE key='verify.channels'")).rows[0]
    const saved = row && Array.isArray(row.value) ? row.value.slice() : []
    const entry = {
      id,
      provider: String(data.provider || 'local').slice(0, 30),
      revealDemo: Number(data.revealDemo) ? 1 : 0,
      resendSeconds: Math.min(300, Math.max(10, Math.floor(Number(data.resendSeconds) || 60))),
      expireMin: Math.min(60, Math.max(1, Math.floor(Number(data.expireMin) || 10))),
      // 前端字段名叫 length，接口此前只认 digits —— 位数设置也被静默丢了。两个都收。
      digits: Math.min(8, Math.max(4, Math.floor(Number(data.digits || data.length) || 6)))
    }
    const index = saved.findIndex(item => item && item.id === id)
    if (index >= 0) saved[index] = entry
    else saved.push(entry)
    await repo.query(
      `INSERT INTO app_settings(key,value,description) VALUES('verify.channels',$1::jsonb,'验证码通道配置')
       ON CONFLICT (key) DO UPDATE SET value=$1::jsonb`,
      [JSON.stringify(saved)]
    )

    // 邮箱通道选 SMTP 时，把页面上那几个 SMTP 字段真正写进 mail.smtp。
    // 留空的字段沿用原值 —— 否则管理员只改端口会把主机和口令一起清掉。
    let smtpSaved = false
    if (id === 'email' && entry.provider === 'smtp') {
      const settings = await repo.settings()
      const current = objectSetting(settings, 'mail.smtp', {})
      const secureRaw = data.smtpSecure
      const keep = secureRaw === undefined || secureRaw === ''
      const nextPass = String(data.smtpPass || '').trim()
      const smtp = {
        host: String(data.smtpHost || '').trim() || current.host || '',
        port: Number(data.smtpPort) || current.port || 465,
        secure: keep ? current.secure !== false
          : !(secureRaw === 0 || secureRaw === '0' || secureRaw === false || secureRaw === 'false'),
        user: String(data.smtpUser || '').trim() || current.user || '',
        // 掩码或留空都表示"不改口令"
        pass: (!nextPass || nextPass === '********') ? (current.pass || '') : nextPass,
        from: String(data.smtpFrom || '').trim() || current.from || '',
        fromName: String(current.fromName || 'Hello Pix').trim()
      }
      await repo.transaction(async client => {
        await repo.query(
          `INSERT INTO app_settings(key,value,description) VALUES($1,$2::jsonb,$3)
           ON CONFLICT (key) DO UPDATE SET value=$2::jsonb`,
          ['mail.smtp', JSON.stringify(smtp), 'SMTP 服务器配置'], client
        )
        await repo.query(
          `INSERT INTO app_settings(key,value,description) VALUES('mail.enabled','true'::jsonb,'邮件服务总开关')
           ON CONFLICT (key) DO UPDATE SET value='true'::jsonb`, [], client
        )
        await repo.audit(client, req.pixAdmin, '配置验证码通道（含 SMTP）',
          `${id} / ${entry.provider} / ${smtp.host || '(空主机)'}`, req.ip, { type: 'verify', id })
      })
      smtpSaved = true
    } else {
      await repo.audit(null, req.pixAdmin, '配置验证码通道', JSON.stringify(entry), req.ip, { type: 'verify', id })
    }

    const cfg = await accounts.mailer.config()
    ok(res, smtpSaved
      ? (cfg.configured ? '已保存，SMTP 已接通' : '已保存，但 SMTP 仍未就绪：缺少 ' + cfg.missing.join('、'))
      : '已保存')
  }))

}

module.exports = { registerAdminSettings }

/** 本文件包含的路由（仅供文档与调试参考）
 *   GET   /admin/packages
 *   POST  /admin/packages/save
 *   GET   /admin/settings
 *   POST  /admin/settings/save
 *   GET   /admin/verify
 *   POST  /admin/verify/save
 */
