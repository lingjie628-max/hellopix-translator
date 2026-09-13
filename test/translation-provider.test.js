'use strict'

// 翻译通道适配层测试。
// 重点不是"能翻译"，而是**失败时绝不产生译文、绝不产生计费**：
// 凭据缺失、厂商报错码、HTTP 错误、超时、返回体损坏，任何一种都必须 ok:false。

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const provider = require('../server/services/translation-provider')

const CREDENTIAL_KEYS = ['PIX_YOUDAO_APP_KEY', 'PIX_YOUDAO_APP_SECRET', 'PIX_DEEPSEEK_API_KEY']

async function withCredentials(values, run) {
  const saved = {}
  for (const key of CREDENTIAL_KEYS) {
    saved[key] = process.env[key]
    if (values && values[key] !== undefined) process.env[key] = values[key]
    else delete process.env[key]
  }
  try {
    // 必须 await：否则 async 用例在第一次 await 之后凭据就被还原了
    return await run()
  } finally {
    for (const key of CREDENTIAL_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  }
}

/** 与 withCredentials 同一套隔离，只是针对 DeepSeek 的单个环境变量。 */
function withDeepseekKey(value, run) {
  return withCredentials({ PIX_DEEPSEEK_API_KEY: value === null ? undefined : value }, run)
}

function captureFetch(response) {
  const calls = []
  const impl = async (url, options) => {
    calls.push({ url, options })
    if (response instanceof Error) throw response
    return response
  }
  return { calls, impl }
}

const youdao = { id: 'youdao', name: '有道翻译', enabled: true, wired: true }
const payload = { text: 'hello', from: 'auto', to: 'zh', detected: 'en' }

test('missing credentials fail closed without touching the network', async () => {
  await withCredentials(null, async () => {
    const { calls, impl } = captureFetch(jsonResponse({ errorCode: '0', translation: ['你好'] }))
    const result = await provider.translate(youdao, payload, { fetch: impl })
    assert.equal(result.ok, false)
    assert.match(result.msg, /凭据未配置/)
    assert.equal(calls.length, 0, '凭据缺失时不允许发出任何请求')
  })
})

test('youdao success returns the vendor translation', async () => {
  await withCredentials({ PIX_YOUDAO_APP_KEY: 'k', PIX_YOUDAO_APP_SECRET: 's' }, async () => {
    const { impl } = captureFetch(jsonResponse({ errorCode: '0', translation: ['你好', '世界'] }))
    const result = await provider.translate(youdao, payload, { fetch: impl })
    assert.equal(result.ok, true)
    assert.equal(result.text, '你好世界')
  })
})

test('youdao request carries a v3 signature over the documented string', async () => {
  await withCredentials({ PIX_YOUDAO_APP_KEY: 'app-key', PIX_YOUDAO_APP_SECRET: 'app-secret' }, async () => {
    const { calls, impl } = captureFetch(jsonResponse({ errorCode: '0', translation: ['译文'] }))
    await provider.translate(youdao, payload, { fetch: impl })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://openapi.youdao.com/api')
    assert.equal(calls[0].options.method, 'POST')

    const form = new URLSearchParams(calls[0].options.body)
    assert.equal(form.get('q'), 'hello')
    assert.equal(form.get('appKey'), 'app-key')
    assert.equal(form.get('signType'), 'v3')
    assert.equal(form.get('from'), 'auto')
    assert.equal(form.get('to'), 'zh-CHS', 'zh 必须映射成有道自己的 zh-CHS')

    // 独立复算签名，验证 truncate 规则与拼接顺序
    const expected = crypto
      .createHash('sha256')
      .update('app-key' + 'hello' + form.get('salt') + form.get('curtime') + 'app-secret')
      .digest('hex')
    assert.equal(form.get('sign'), expected)
  })
})

test('youdao long text签名用 前10+长度+后10 截断', async () => {
  await withCredentials({ PIX_YOUDAO_APP_KEY: 'k', PIX_YOUDAO_APP_SECRET: 's' }, async () => {
    const long = 'a'.repeat(15) + 'MIDDLE' + 'b'.repeat(15) // 长度 36 > 20
    const { calls, impl } = captureFetch(jsonResponse({ errorCode: '0', translation: ['x'] }))
    await provider.translate(youdao, Object.assign({}, payload, { text: long }), { fetch: impl })

    const form = new URLSearchParams(calls[0].options.body)
    const truncated = long.slice(0, 10) + String(long.length) + long.slice(-10)
    const expected = crypto
      .createHash('sha256')
      .update('k' + truncated + form.get('salt') + form.get('curtime') + 's')
      .digest('hex')
    assert.equal(form.get('sign'), expected)
  })
})

test('youdao error codes become actionable messages', async () => {
  await withCredentials({ PIX_YOUDAO_APP_KEY: 'k', PIX_YOUDAO_APP_SECRET: 's' }, async () => {
    const { impl } = captureFetch(jsonResponse({ errorCode: '202' }))
    const result = await provider.translate(youdao, payload, { fetch: impl })
    assert.equal(result.ok, false)
    assert.match(result.msg, /签名校验失败/)

    const unknown = captureFetch(jsonResponse({ errorCode: '999' }))
    const other = await provider.translate(youdao, payload, { fetch: unknown.impl })
    assert.equal(other.ok, false)
    assert.match(other.msg, /999/)
  })
})

test('transport failures never surface as a translation', async () => {
  await withCredentials({ PIX_YOUDAO_APP_KEY: 'k', PIX_YOUDAO_APP_SECRET: 's' }, async () => {
    const http500 = captureFetch(jsonResponse({}, 500))
    const failed = await provider.translate(youdao, payload, { fetch: http500.impl })
    assert.equal(failed.ok, false)
    assert.match(failed.msg, /HTTP 500/)

    const broken = captureFetch({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })
    const parsed = await provider.translate(youdao, payload, { fetch: broken.impl })
    assert.equal(parsed.ok, false)
    assert.match(parsed.msg, /无法解析/)

    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    const aborted = captureFetch(timeout)
    const timedOut = await provider.translate(youdao, payload, { fetch: aborted.impl })
    assert.equal(timedOut.ok, false)
    assert.match(timedOut.msg, /超时/)

    const empty = captureFetch(jsonResponse({ errorCode: '0', translation: [] }))
    const nothing = await provider.translate(youdao, payload, { fetch: empty.impl })
    assert.equal(nothing.ok, false)
    assert.match(nothing.msg, /未返回译文/)
  })
})

test('unknown and disabled channels are rejected', async () => {
  const missing = await provider.translate({ id: 'nope', enabled: true }, payload, {})
  assert.equal(missing.ok, false)
  assert.match(missing.msg, /通道不存在/)

  const disabled = await provider.translate(
    { id: 'youdao', name: '有道翻译', enabled: false },
    payload,
    {}
  )
  assert.equal(disabled.ok, false)
  assert.match(disabled.msg, /已关闭/)
})

test('unwired channels stay fail-closed even if wired is mistakenly true', async () => {
  const result = await provider.translate(
    { id: 'papago', name: 'Papago 翻译', enabled: true, wired: true },
    payload,
    {}
  )
  assert.equal(result.ok, false)
  assert.match(result.msg, /尚未接入/)
})

test('every engine seeded in migrations has an adapter entry', () => {
  const dir = path.join(__dirname, '../migrations')
  const seeded = new Set()
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.js'))) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
    // 形如 ('papago', 'Papago 翻译', ...) 的 engines 插入行
    for (const match of sql.matchAll(/\(\s*'([a-z0-9_-]+)',\s*'[^']*',\s*'[^']*',\s*'(?:basic|advanced|pro)'/g)) {
      seeded.add(match[1])
    }
  }
  assert.ok(seeded.size >= 10, `解析到的通道数偏少(${seeded.size})，迁移写法可能变了`)
  const missing = [...seeded].filter(id => !provider.providers[id])
  assert.deepEqual(missing, [], `这些通道在数据库里有、适配层没有: ${missing.join(', ')}`)
})

test('channelStatus reports credential readiness per channel', async () => {
  await withCredentials({ PIX_YOUDAO_APP_KEY: 'k', PIX_YOUDAO_APP_SECRET: 's' }, () => {
    const rows = provider.channelStatus()
    const youdaoRow = rows.find(row => row.id === 'youdao')
    assert.equal(youdaoRow.credentialReady, true)
    const others = rows.filter(row => row.id !== 'youdao')
    assert.ok(others.every(row => row.credentialReady === false))
  })
  await withCredentials(null, () => {
    assert.equal(provider.channelStatus().find(row => row.id === 'youdao').credentialReady, false)
  })
})

// --- 谷歌极速：公共端点必须显式放行 ------------------------------------------

const googleFast = { id: 'google-fast', name: '谷歌极速', enabled: true, wired: true }

async function withPublicNetwork(value, run) {
  const saved = process.env.PIX_ALLOW_PUBLIC_TRANSLATION
  if (value === undefined) delete process.env.PIX_ALLOW_PUBLIC_TRANSLATION
  else process.env.PIX_ALLOW_PUBLIC_TRANSLATION = value
  try {
    return await run()
  } finally {
    if (saved === undefined) delete process.env.PIX_ALLOW_PUBLIC_TRANSLATION
    else process.env.PIX_ALLOW_PUBLIC_TRANSLATION = saved
  }
}

test('google-fast stays offline unless the public network switch is on', async () => {
  await withPublicNetwork(undefined, async () => {
    const { calls, impl } = captureFetch(jsonResponse([['你好', 'hello']]))
    const result = await provider.translate(googleFast, payload, {
      allowPublicNetwork: false,
      fetch: impl
    })
    assert.equal(result.ok, false)
    assert.match(result.msg, /未启用/)
    assert.equal(calls.length, 0, '开关关闭时不允许发出任何请求')
  })
})

test('google-fast parses the nested gtx response when allowed', async () => {
  await withPublicNetwork(undefined, async () => {
    const body = [[['你好', 'hello', null, null, 10], ['世界', 'world', null, null, 3]], null, 'en']
    const { calls, impl } = captureFetch(jsonResponse(body))
    const result = await provider.translate(googleFast, payload, {
      allowPublicNetwork: true,
      fetch: impl
    })
    assert.equal(result.ok, true)
    assert.equal(result.text, '你好世界')

    const url = new URL(calls[0].url)
    assert.equal(url.origin + url.pathname, 'https://translate.googleapis.com/translate_a/single')
    assert.equal(url.searchParams.get('client'), 'gtx')
    assert.equal(url.searchParams.get('tl'), 'zh-CN', 'zh 必须映射成 gtx 的 zh-CN')
    assert.equal(url.searchParams.get('q'), 'hello')
  })
})

test('google-fast rejects malformed or empty payloads', async () => {
  await withPublicNetwork(undefined, async () => {
    const malformed = captureFetch(jsonResponse({ error: 'nope' }))
    const bad = await provider.translate(googleFast, payload, {
      allowPublicNetwork: true,
      fetch: malformed.impl
    })
    assert.equal(bad.ok, false)
    assert.match(bad.msg, /结构异常/)

    const empty = captureFetch(jsonResponse([[['', 'hello', null, null, 0]]]))
    const nothing = await provider.translate(googleFast, payload, {
      allowPublicNetwork: true,
      fetch: empty.impl
    })
    assert.equal(nothing.ok, false)
    assert.match(nothing.msg, /未返回译文/)
  })
})

test('google-fast readiness follows the public network switch', async () => {
  await withPublicNetwork('1', () => {
    assert.equal(provider.channelStatus().find(row => row.id === 'google-fast').credentialReady, true)
  })
  await withPublicNetwork('0', () => {
    assert.equal(provider.channelStatus().find(row => row.id === 'google-fast').credentialReady, false)
  })
})

test('detectLang and countBillableChars keep their billing semantics', () => {
  assert.equal(provider.detectLang('你好'), 'zh')
  assert.equal(provider.detectLang('こんにちは'), 'ja')
  assert.equal(provider.detectLang('안녕'), 'ko')
  assert.equal(provider.detectLang('hello'), 'en')
  // 中文按 2 字符计费，其余按 1
  assert.equal(provider.countBillableChars('你好ab'), 6)
  assert.equal(provider.countBillableChars(''), 0)
})

test('admin-configured credentials take precedence over environment', async () => {
  // 只有管理后台配置的密钥
  await withCredentials(null, async () => {
    const { calls, impl } = captureFetch(jsonResponse({ errorCode: '0', translation: ['来自后台'] }))
    const result = await provider.translate(youdao, payload, {
      fetch: impl,
      credentials: { apiKey: 'db-key', secret: 'db-secret' }
    })
    assert.equal(result.ok, true)
    const form = new URLSearchParams(calls[0].options.body)
    assert.equal(form.get('appKey'), 'db-key')
  })

  // 后台与 env 都有 -> 后台优先
  await withCredentials({ PIX_YOUDAO_APP_KEY: 'env-key', PIX_YOUDAO_APP_SECRET: 'env-secret' }, async () => {
    const { calls, impl } = captureFetch(jsonResponse({ errorCode: '0', translation: ['x'] }))
    await provider.translate(youdao, payload, { fetch: impl, credentials: { apiKey: 'db-key', secret: 'db-secret' } })
    assert.equal(new URLSearchParams(calls[0].options.body).get('appKey'), 'db-key')
  })

  // 后台为空时回落到 env
  await withCredentials({ PIX_YOUDAO_APP_KEY: 'env-key', PIX_YOUDAO_APP_SECRET: 'env-secret' }, async () => {
    const { calls, impl } = captureFetch(jsonResponse({ errorCode: '0', translation: ['x'] }))
    await provider.translate(youdao, payload, { fetch: impl, credentials: { apiKey: '', secret: '' } })
    assert.equal(new URLSearchParams(calls[0].options.body).get('appKey'), 'env-key')
  })
})

test('channelStatus reflects admin-configured credentials', async () => {
  await withCredentials(null, () => {
    const rows = provider.channelStatus({ youdao: { apiKey: 'k', secret: 's' } })
    assert.equal(rows.find(row => row.id === 'youdao').credentialReady, true)
    assert.equal(provider.channelStatus({}).find(row => row.id === 'youdao').credentialReady, false)
  })
})

// --- DeepSeek（对话式翻译，与有道那类专用翻译 API 的约定不同）------------------
// 契约差异：返回体是对话补全结构（choices[0].message.content），
// 语言控制靠 system 提示词，且必须同时有 apiKey 与 model。

const deepseek = { id: 'deepseek', name: 'DeepSeek 翻译', enabled: true, wired: true, model: 'deepseek-flash' }

test('deepseek：凭据缺失时 fail-closed，不发任何请求', async () => {
  await withDeepseekKey(null, async () => {
    const { calls, impl } = captureFetch(jsonResponse({ choices: [{ message: { content: '你好' } }] }))
    const result = await provider.translate(deepseek, payload, { fetch: impl })
    assert.equal(result.ok, false)
    assert.match(result.msg, /凭据未配置/)
    assert.equal(calls.length, 0, '凭据缺失时不允许发出任何请求')
  })
})

test('deepseek：成功时取 choices[0].message.content', async () => {
  await withDeepseekKey('sk-test', async () => {
    const { calls, impl } = captureFetch(jsonResponse({
      choices: [{ message: { role: 'assistant', content: '  你好世界  ' } }]
    }))
    const result = await provider.translate(deepseek, Object.assign({}, payload, { text: 'hello world' }), { fetch: impl })
    assert.equal(result.ok, true)
    assert.equal(result.text, '你好世界', '译文应去掉首尾空白')

    // 请求形状：官方端点、Bearer 鉴权、模型与温度
    assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions')
    assert.equal(calls[0].options.method, 'POST')
    assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test')
    const body = JSON.parse(calls[0].options.body)
    assert.equal(body.model, 'deepseek-flash')
    assert.equal(body.stream, false)
    assert.equal(body.temperature, 0, '翻译要稳定，温度必须为 0')
    // 思考模式默认开启且会让 temperature 失效（官方文档明确），翻译场景必须显式关闭
    assert.deepEqual(body.thinking, { type: 'disabled' }, '必须显式关闭思考模式')
    assert.equal(body.messages.length, 2)
    assert.equal(body.messages[0].role, 'system')
    assert.equal(body.messages[1].content, 'hello world')
    assert.match(body.messages[0].content, /中文/, '目标语言应出现在提示词里')
  })
})

test('deepseek：接口地址可在后台覆盖（自建网关/代理）', async () => {
  await withDeepseekKey('sk-test', async () => {
    const { calls, impl } = captureFetch(jsonResponse({ choices: [{ message: { content: 'x' } }] }))
    const custom = Object.assign({}, deepseek, { endpoint: 'https://gateway.example.com/v1/chat/completions' })
    await provider.translate(custom, payload, { fetch: impl })
    assert.equal(calls[0].url, 'https://gateway.example.com/v1/chat/completions')
  })
})

test('deepseek：模型可用后台配置覆盖，缺省回落 deepseek-flash', async () => {
  await withDeepseekKey('sk-test', async () => {
    const { calls, impl } = captureFetch(jsonResponse({ choices: [{ message: { content: 'x' } }] }))
    await provider.translate(Object.assign({}, deepseek, { model: 'deepseek-reasoner' }), payload, { fetch: impl })
    assert.equal(JSON.parse(calls[0].options.body).model, 'deepseek-reasoner')

    // 行里没有 model 时用常量兜底
    await provider.translate({ id: 'deepseek', name: 'x', enabled: true, wired: true }, payload, { fetch: impl })
    assert.equal(JSON.parse(calls[1].options.body).model, 'deepseek-flash')
  })
})

test('deepseek：HTTP 错误带出厂商原因，且不产生译文', async () => {
  await withDeepseekKey('sk-test', async () => {
    const unauthorized = captureFetch(jsonResponse({ error: { message: 'Authentication Fails' } }, 401))
    const r1 = await provider.translate(deepseek, payload, { fetch: unauthorized.impl })
    assert.equal(r1.ok, false)
    assert.match(r1.msg, /HTTP 401/)
    assert.match(r1.msg, /Authentication Fails/, '厂商原因应透出，便于排查')
    assert.equal(r1.text, undefined)

    const insufficient = captureFetch(jsonResponse({ error: { message: 'Insufficient Balance' } }, 402))
    const r2 = await provider.translate(deepseek, payload, { fetch: insufficient.impl })
    assert.equal(r2.ok, false)
    assert.match(r2.msg, /Insufficient Balance/)
  })
})

test('deepseek：超时/网络错误/返回体损坏/空译文都转成 ok:false', async () => {
  await withDeepseekKey('sk-test', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const r1 = await provider.translate(deepseek, payload, { fetch: captureFetch(timeout).impl })
    assert.equal(r1.ok, false)
    assert.match(r1.msg, /超时/)

    const r2 = await provider.translate(deepseek, payload, { fetch: async () => { throw new Error('ECONNREFUSED') } })
    assert.equal(r2.ok, false)
    assert.match(r2.msg, /ECONNREFUSED/)

    const broken = captureFetch({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })
    const r3 = await provider.translate(deepseek, payload, { fetch: broken.impl })
    assert.equal(r3.ok, false)
    assert.match(r3.msg, /无法解析/)

    const empty = captureFetch(jsonResponse({ choices: [{ message: { content: '   ' } }] }))
    const r4 = await provider.translate(deepseek, payload, { fetch: empty.impl })
    assert.equal(r4.ok, false)
    assert.match(r4.msg, /未返回译文/)
  })
})

test('deepseek：登进注册表、凭据状态可查', async () => {
  await withDeepseekKey(null, () => {
    assert.equal(provider.providers.deepseek.name, 'DeepSeek 翻译')
    assert.equal(provider.providers.deepseek.configured({}), false)
    assert.equal(provider.providers.deepseek.configured({ apiKey: 'k' }), true)
    const rows = provider.channelStatus({ deepseek: { apiKey: 'k' } })
    assert.equal(rows.find(row => row.id === 'deepseek').credentialReady, true)
  })
})
