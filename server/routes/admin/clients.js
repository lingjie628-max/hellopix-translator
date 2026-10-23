'use strict'

/**
 * 后台 · 客户端与翻译通道：版本发布、通道增删改、启用切换。
 *
 * 密钥走 `engines.api_key_ciphertext` / `secret_ciphertext`，AES-256-GCM 加密落盘；
 * 列表只回"是否已填"，永不回密钥本体。
 */

const { asyncRoute, input, pagination, page, ok, ApiError } = require('../../lib/http')
const { encryptSecret, credentialsKeyReady, KEY_ENV } = require('../../lib/credentials')
const { providers, channelStatus } = require('../../services/translation-provider')
const { bool } = require('../../services/core-service')
const { checkOutboundUrl } = require('../../lib/outbound-guard')

/**
 * 布尔字段：字面量解析，认不出就 400。
 *
 * 不能靠 `Number()` 猜：`Number('true')` / `Number('no')` / `Number(undefined)`
 * 全是 NaN，`Boolean(NaN)` 恒为 false —— 开关会被静默关掉。
 */
function strictBool(value, field) {
  const parsed = bool(value)
  if (parsed === null) {
    throw new ApiError(400, `${field} 必须是 true/false/1/0`, 'BAD_BOOLEAN')
  }
  return parsed
}

function registerAdminClients(router, ctx) {
  const { repo, core } = ctx

  async function activeEngineId() {
    const row = (await repo.query("SELECT value FROM app_settings WHERE key='translation.active_engine'")).rows[0]
    return row && row.value ? String(row.value) : ''
  }

  function normalizeCallParams(raw) {
    if (raw === undefined || raw === null || raw === '') return null
    let value = raw
    if (typeof value === 'string') {
      try { value = JSON.parse(value) } catch (_error) {
        throw new ApiError(400, '调用参数必须是 JSON 对象', 'BAD_CALL_PARAMS')
      }
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new ApiError(400, '调用参数必须是 JSON 对象', 'BAD_CALL_PARAMS')
    }
    const out = {}
    const numeric = { timeoutMs: [1000, 30000], maxRetries: [0, 2], maxOutputTokens: [0, 65536], maxInputTokens: [0, 1000000] }
    for (const [key, [min, max]] of Object.entries(numeric)) {
      if (value[key] === undefined || value[key] === null || value[key] === '') continue
      const parsed = Number(value[key])
      if (!Number.isFinite(parsed)) throw new ApiError(400, `调用参数 ${key} 必须是数字`, 'BAD_CALL_PARAMS')
      out[key] = Math.min(max, Math.max(min, Math.trunc(parsed)))
    }
    // temperature: null 是**有意的空值语义**（该模型不能收这个字段，如 Kimi K3），
    // 必须保留成 null 而不是被当成"没填"丢掉 —— 丢掉会让适配器把 0 发出去，
    // 而 K3 收到 temperature 会直接报错。
    if (Object.prototype.hasOwnProperty.call(value, 'temperature')) {
      if (value.temperature === null) out.temperature = null
      else {
        const parsed = Number(value.temperature)
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
          throw new ApiError(400, 'temperature 必须在 0~2 之间，或填 null 表示不发送该参数', 'BAD_CALL_PARAMS')
        }
        out.temperature = parsed
      }
    }
    if (value.extraBody !== undefined) {
      if (!value.extraBody || typeof value.extraBody !== 'object' || Array.isArray(value.extraBody)) {
        throw new ApiError(400, 'extraBody 必须是 JSON 对象', 'BAD_CALL_PARAMS')
      }
      out.extraBody = value.extraBody
    }
    return out
  }

  router.get('/admin/clients', asyncRoute(async (req, res) => {
    const paging = pagination(req)
    const result = await core.listClientReleases(input(req), paging)
    res.json(Object.assign(page(result.rows, result.total, paging), {
      groups: result.groups,
      standaloneApps: result.standaloneApps
    }))
  }))

  router.post('/admin/clients/save', asyncRoute(async (req, res) => {
    const result = await core.saveClientRelease(input(req))
    await repo.audit(null, req.pixAdmin, result.updated ? '编辑客户端版本' : '新增客户端版本', String(result.id), req.ip, {
      type: 'client', id: result.id
    })
    ok(res, result.updated ? '客户端版本已更新' : '客户端版本已创建', { id: result.id })
  }))

  router.get('/admin/engines', asyncRoute(async (_req, res) => {
    const rows = await repo.enginesForAdmin()
    const active = await activeEngineId()
    const credentials = {}
    for (const row of rows) credentials[row.id] = await repo.engineCredentials(row.id)
    const readiness = channelStatus(credentials).reduce((out, item) => {
      out[item.id] = item.credentialReady
      return out
    }, {})
    const packages = await repo.packages()
    res.json({
        rows: rows.map(row => ({
          id: row.id,
          name: row.name,
          provider: row.provider,
          tier: row.tier,
          costPerMillion: Number(row.costPerMillion || 0),
          model: row.model || '',
          endpoint: row.endpoint || '',
          note: row.note || '',
          callParams: row.callParams || {},
          enabled: Boolean(row.enabled),
          wired: Boolean(row.wired),
          // 已下架：对商户不可见，但仍在库里、历史日志仍指向它。
          // 后台保留可见是为了能重新上架，以及查"当初卖的是什么"。
          retired: Boolean(row.retiredAt),
          retiredAt: row.retiredAt || null,
          // 只暴露"够不够用"，不暴露密钥本身
          hasKey: Boolean(row.hasKey || row.hasSecret),
          credentialReady: Boolean(readiness[row.id]),
          wiredText: row.wired ? '已接通' : (Boolean(row.enabled) ? '未接通（缺凭据或未实现）' : '未启用'),
          active: row.id === active
        })),
        activeEngine: active,
        credentialsKeyReady: credentialsKeyReady(),
        packageBill: packages
          .map(item => `${item.title} ¥${Number(item.price || 0)}/${Math.round(Number(item.chars || 0) / 10000)}万`)
          .join(' · ')
    })
  }))

  router.post('/admin/engines/save', asyncRoute(async (req, res) => {
    const data = input(req)
    const id = String(data.id || '').trim()
    const engine = await repo.engineById(id)
    if (!engine) throw new ApiError(404, '通道不存在', 'ENGINE_NOT_FOUND')

    const endpoint = String(data.endpoint || '').trim()
    if (endpoint && !/^https:\/\//.test(endpoint)) {
      throw new ApiError(400, '接口地址必须是 https:// 开头', 'BAD_ENDPOINT')
    }
    // ★ SSRF 防护 ★
    //
    // 只校验 https:// 是不够的：攻击者（或拿到超管会话的人）可以把地址
    // 指向 169.254.169.254 读云元数据、指向 127.0.0.1 打内网、
    // 或指向自己的服务器把 apiKey 一起收走。
    //
    // 见 lib/outbound-guard.js：解析域名后逐个 IP 判断是否落在禁止网段。
    // 注意这里只是**第一道**闸；真正发起请求前还会再验一次（防 DNS rebinding）。
    if (endpoint) {
      const verdict = await checkOutboundUrl(endpoint)
      if (!verdict.ok) {
        throw new ApiError(400, `接口地址不被允许：${verdict.reason}`, 'ENDPOINT_BLOCKED')
      }
    }

    // 密钥非空才更新；留空表示保持原值（前端占位符就是这么写的）
    const apiKey = String(data.apiKey || '').trim()
    const secret = String(data.secret || '').trim()
    if ((apiKey || secret) && !credentialsKeyReady()) {
      throw new ApiError(503, `服务端未配置 ${KEY_ENV}，拒绝保存厂商密钥`, 'CREDENTIAL_KEY_MISSING')
    }

    const existing = await repo.engineCredentials(id)
    const effective = {
      apiKey: apiKey || existing.apiKey,
      secret: secret || existing.secret
    }
    // 下架：**不删行**，只打 retired_at 并停用。历史 translate_logs 仍指向它，
    // 已售权益的凭据也还在 package_engines 里 —— 删了就查不出"当初卖过什么"。
    //
    // ⚠️ 别写 `Boolean(Number(data.enabled))`：没传这个字段时是
    //    `Boolean(Number(undefined))` = `Boolean(NaN)` = **false** ——
    //    管理员只是改个备注/换个模型，渠道就被静默停用了，前台当场翻译不了。
    //    缺省一律"保持原值"，明确传了才改。
    const retired = data.retired === undefined || data.retired === ''
      ? Boolean(engine.retiredAt)
      : strictBool(data.retired, 'retired') === true
    const enabled = retired
      ? false
      : (data.enabled === undefined || data.enabled === ''
          ? Boolean(engine.enabled)
          : strictBool(data.enabled, 'enabled') === true)
    const adapter = providers[id]
    const ready = Boolean(adapter && adapter.configured(effective))
    // wired 不让人手填：适配器实现 + 凭据齐备才允许接通，与 CLI 脚本同一把尺子
    const wired = enabled && ready

    const callParams = normalizeCallParams(data.callParams)
    const model = String(data.model || '').trim() || null
    // 渠道换了真实模型就**必须显式可见**：台账、前台展示都读这个字段。
    // 这里不阻止改，但改了要在审计里留下前后值（下面写审计）。
    const modelChanged = (engine.model || '') !== (model || '')

    await repo.query(
      `UPDATE engines SET enabled=$2, wired=$3, cost_per_million=$4, model=$5, endpoint=$6, note=$7,
              call_params=COALESCE($10::jsonb, call_params),
              retired_at=${retired ? 'NOW()' : 'NULL'},
              api_key_ciphertext=COALESCE($8, api_key_ciphertext),
              secret_ciphertext=COALESCE($9, secret_ciphertext),
              updated_at=NOW()
       WHERE id=$1`,
      [id, enabled, wired,
        Math.max(0, Number(data.costPerMillion) || 0),
        model,
        endpoint || null,
        String(data.note || '').slice(0, 1000),
        apiKey ? encryptSecret(apiKey) : null,
        secret ? encryptSecret(secret) : null,
        callParams ? JSON.stringify(callParams) : null]
    )
    await repo.audit(null, req.pixAdmin, retired ? '下架翻译通道' : '配置翻译通道',
      `${engine.name}: enabled=${enabled} wired=${wired} retired=${retired}` +
      (modelChanged ? ` 模型 ${engine.model || '(空)'} → ${model || '(空)'}` : ''), req.ip, {
        type: 'engine', id
      })
    // 刚刚可能改了 Key：立刻让凭据缓存失效，不然要等到 TTL 过期才用上新 Key，
    // 用户在后台填完 Key 看到"已接通"，实测却仍是旧 Key —— 那种问题极难排查。
    try { core.invalidateCredentials(id) } catch (e) {}
    ok(res, retired
      ? `${engine.name} 已下架（历史日志与已售权益保留，未删除）`
      : (wired ? `${engine.name} 已接通` : `${engine.name} 已保存（未接通：${adapter ? '凭据未就绪' : '适配器未实现'}）`))
  }))

  router.post('/admin/engines/active', asyncRoute(async (req, res) => {
    const id = String(input(req).id || '').trim()
    const engine = await repo.engineById(id)
    if (!engine) throw new ApiError(404, '通道不存在', 'ENGINE_NOT_FOUND')
    if (engine.retiredAt) throw new ApiError(400, '该通道已下架，不能设为默认', 'ENGINE_RETIRED')
    if (!engine.enabled) throw new ApiError(400, '该通道未启用，不能设为默认', 'ENGINE_DISABLED')
    await repo.query(
      `INSERT INTO app_settings(key,value,description) VALUES('translation.active_engine',to_jsonb($1::text),'默认翻译引擎')
       ON CONFLICT (key) DO UPDATE SET value=to_jsonb($1::text)`,
      [id]
    )
    await repo.audit(null, req.pixAdmin, '设置默认翻译通道', engine.name, req.ip, { type: 'engine', id })
    ok(res, `默认通道已设为 ${engine.name}`)
  }))

}

module.exports = { registerAdminClients }

/** 本文件包含的路由（仅供文档与调试参考）
 *   GET   /admin/clients
 *   POST  /admin/clients/save
 *   GET   /admin/engines
 *   POST  /admin/engines/save
 *   POST  /admin/engines/active
 */
