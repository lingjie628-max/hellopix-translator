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

const CREDENTIAL_KEYS = [
  'PIX_YOUDAO_APP_KEY', 'PIX_YOUDAO_APP_SECRET',
  'PIX_DEEPSEEK_API_KEY', 'PIX_GOOGLE_API_KEY', 'PIX_GEMINI_API_KEY'
]

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

/** 谷歌官方 API 的 Key 隔离。 */
function withGoogleKey(value, run) {
  return withCredentials({ PIX_GOOGLE_API_KEY: value === null ? undefined : value }, run)
}

/** Gemini 的 Key 隔离。 */
function withGeminiKey(value, run) {
  return withCredentials({ PIX_GEMINI_API_KEY: value === null ? undefined : value }, run)
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

// 唯一仍带真实适配实现的通道（有道已下架），通用契约用例都打它
  const deepseek = { id: 'deepseek', name: 'DeepSeek 翻译', enabled: true, wired: true, model: 'deepseek-flash' }
const payload = { text: 'hello', from: 'auto', to: 'zh', detected: 'en' }

test('unknown and disabled channels are rejected', async () => {
  const missing = await provider.translate({ id: 'nope', enabled: true }, payload, {})
  assert.equal(missing.ok, false)
  assert.match(missing.msg, /通道不存在/)

  const disabled = await provider.translate(
    { id: 'deepseek', name: 'DeepSeek 翻译', enabled: false },
    payload,
    {}
  )
  assert.equal(disabled.ok, false)
  assert.match(disabled.msg, /已关闭/)
})

// 这条原来的语义是「未实现的通道即使被误标 wired=true 也必须失败」。
// 现在 9 个通道**全部实现了**，没有「未实现」的通道可测，
// 所以改成更根本的一条：**没有凭据时，即使 wired=true 也必须失败**。
// 这才是 fail-closed 的真正含义 —— 标了接通不等于真能调通。
test('没有凭据时即使 wired=true 也必须失败（fail-closed）', async () => {
  for (const id of Object.keys(provider.providers)) {
    const result = await provider.translate(
      { id, name: provider.providers[id].name, enabled: true, wired: true },
      payload,
      {}   // 刻意不传 credentials
    )
    assert.equal(result.ok, false, `${id} 在无凭据时不该成功`)
    assert.ok(result.msg && result.msg.length > 0, `${id} 失败时必须有可读原因`)
  }
})

test('每个通道都必须是真实现，不能留着 notWired 占位', () => {
  // 占位通道的表现是 configured() 恒为 false —— 填了 key 也用不了，
  // 但界面上看起来「有这个选项」。这正是之前百度的问题。
  for (const [id, p] of Object.entries(provider.providers)) {
    assert.equal(typeof p.translate, 'function', `${id} 缺 translate`)
    assert.equal(typeof p.configured, 'function', `${id} 缺 configured`)
    // 传一个假凭据进去，真实现会认，占位会一律返回 false
    assert.equal(p.configured({ apiKey: 'x', secret: 'y' }), true,
      `${id} 收到凭据后仍判定未配置 —— 很可能还是 notWired 占位`)
  }
})

test('every engine seeded in migrations has an adapter entry', () => {
  const dir = path.join(__dirname, '../migrations')
  const seeded = new Set()
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.js'))) {
    const full = path.join(dir, file)
    const raw = fs.readFileSync(full, 'utf8')
    // **只扫 exports.up**：只有 up 会真正往库里种数据。
    // 回滚函数里出现的通道（例如 018 的 down 会把百度放回去）
    // 不该被当成「已种下的通道」，否则删掉一个通道就会让这个测试永久失败。
    const upAt = raw.indexOf('exports.up')
    const downAt = raw.indexOf('exports.down')
    const sql = upAt < 0 ? '' : raw.slice(upAt, downAt > upAt ? downAt : raw.length)
    // 形如 ('papago', 'Papago 翻译', ...) 的 engines 插入行
    for (const match of sql.matchAll(/\(\s*'([a-z0-9_-]+)',\s*'[^']*',\s*'[^']*',\s*'(?:basic|advanced|pro)'/g)) {
      seeded.add(match[1])
    }
    /**
     * 还有一种写法：迁移把通道行当**数据**导出（migration 031 就是），
     * 由 up() 在运行时拼 SQL（备注很长、还带转义，写字面量既容易写错又难维护）。
     * 这种迁移的正则扫不到 —— 与其为了迁就正则把同一份数据写两遍，
     * 不如直接读导出的数据。require 迁移模块无副作用（只返回 up/down 与常量）。
     */
    for (const row of (require(full).engines || [])) {
      if (row && row.id) seeded.add(row.id)
    }
  }
  assert.ok(seeded.size >= 11, `解析到的通道数偏少(${seeded.size})，迁移写法可能变了`)
  const missing = [...seeded].filter(id => !provider.providers[id])
  assert.deepEqual(missing, [], `这些通道在数据库里有、适配层没有: ${missing.join(', ')}`)
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
  const okBody = jsonResponse({ choices: [{ message: { content: '来自后台' } }] })

  // 只有管理后台配置的密钥
  await withDeepseekKey(null, async () => {
    const { calls, impl } = captureFetch(okBody)
    const result = await provider.translate(deepseek, payload, {
      fetch: impl,
      credentials: { apiKey: 'db-key' }
    })
    assert.equal(result.ok, true)
    assert.equal(calls[0].options.headers.Authorization, 'Bearer db-key')
  })

  // 后台与 env 都有 -> 后台优先
  await withDeepseekKey('env-key', async () => {
    const { calls, impl } = captureFetch(okBody)
    await provider.translate(deepseek, payload, { fetch: impl, credentials: { apiKey: 'db-key' } })
    assert.equal(calls[0].options.headers.Authorization, 'Bearer db-key')
  })

  // 后台为空时回落到 env
  await withDeepseekKey('env-key', async () => {
    const { calls, impl } = captureFetch(okBody)
    await provider.translate(deepseek, payload, { fetch: impl, credentials: { apiKey: '' } })
    assert.equal(calls[0].options.headers.Authorization, 'Bearer env-key')
  })
})

// --- DeepSeek（对话式翻译，与有道那类专用翻译 API 的约定不同）------------------
// 契约差异：返回体是对话补全结构（choices[0].message.content），
// 语言控制靠 system 提示词，且必须同时有 apiKey 与 model。

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

test('deepseek：接口地址只填域名时自动补 /chat/completions', async () => {
  // 实测踩过：后台"接口地址"只填 https://api.deepseek.com 会 404，
  // 且错误体不是 JSON，光看现象排查不出来。
  await withDeepseekKey('sk-test', async () => {
    const { calls, impl } = captureFetch(jsonResponse({ choices: [{ message: { content: 'x' } }] }))
    const bare = Object.assign({}, deepseek, { endpoint: 'https://api.deepseek.com' })
    await provider.translate(bare, payload, { fetch: impl })
    assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions')

    // 已写完整路径的原样保留
    await provider.translate(deepseek, payload, { fetch: impl })
    assert.equal(calls[1].url, 'https://api.deepseek.com/chat/completions')

    // 自定义网关的非根路径不被改写
    const gateway = Object.assign({}, deepseek, { endpoint: 'https://gw.example.com/v1/proxy' })
    await provider.translate(gateway, payload, { fetch: impl })
    assert.equal(calls[2].url, 'https://gw.example.com/v1/proxy')
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

// --- 谷歌翻译：官方 Cloud Translation API --------------------------------------
// 与公共端点版本的关键差别：要凭据、且**必须显式传 format:'text'** ——
// 该参数默认是 html，不传的话译文里的引号会变成 &quot; 直接显示给商户。

const google = { id: 'google', name: '谷歌翻译', enabled: true, wired: true }

test('谷歌：凭据缺失时 fail-closed，不发任何请求', async () => {
  await withGoogleKey(null, async () => {
    const { calls, impl } = captureFetch(jsonResponse({ data: { translations: [{ translatedText: '你好' }] } }))
    const result = await provider.translate(google, payload, { fetch: impl })
    assert.equal(result.ok, false)
    assert.match(result.msg, /凭据未配置/)
    assert.equal(calls.length, 0, '凭据缺失时不允许发出任何请求')
  })
})

test('谷歌：请求打到官方端点，带 key 与 format=text', async () => {
  await withGoogleKey('gk-test', async () => {
    const { calls, impl } = captureFetch(jsonResponse({
      data: { translations: [{ translatedText: '  你好世界  ', detectedSourceLanguage: 'en' }] }
    }))
    const result = await provider.translate(google, Object.assign({}, payload, { text: 'hello world' }),
      { fetch: impl })

    assert.equal(result.ok, true)
    assert.equal(result.text, '你好世界', '译文应去掉首尾空白')

    assert.match(calls[0].url, /^https:\/\/translation\.googleapis\.com\/language\/translate\/v2\?key=gk-test$/)
    assert.equal(calls[0].options.method, 'POST')
    const body = JSON.parse(calls[0].options.body)
    assert.deepEqual(body.q, ['hello world'])
    // 中文必须映射成 zh-CN；直接送 'zh' 谷歌会报不支持
    assert.equal(body.target, 'zh-CN', 'zh 应映射为 zh-CN')
    // 这个参数漏了就会把 &quot; 之类的实体直接显示给商户
    assert.equal(body.format, 'text', '必须显式要求纯文本，否则译文会被 HTML 转义')
    // from=auto 不能作为 source 送出去
    assert.equal(body.source, undefined, 'auto 不应作为 source 参数')
  })
})

test('谷歌：指定源语言时带上 source，且映射为目标语言码', async () => {
  await withGoogleKey('gk-test', async () => {
    const { calls, impl } = captureFetch(jsonResponse({ data: { translations: [{ translatedText: 'Hello' }] } }))
    await provider.translate(google, { text: '你好', from: 'zh', to: 'en' }, { fetch: impl })
    const body = JSON.parse(calls[0].options.body)
    assert.equal(body.source, 'zh-CN')
    assert.equal(body.target, 'en')
  })
})

test('谷歌：厂商错误原因透出，且不产生译文', async () => {
  await withGoogleKey('bad-key', async () => {
    const denied = captureFetch(jsonResponse(
      { error: { code: 403, message: 'API key not valid. Please pass a valid API key.', status: 'PERMISSION_DENIED' } }, 403))
    const result = await provider.translate(google, payload, { fetch: denied.impl })
    assert.equal(result.ok, false)
    assert.match(result.msg, /HTTP 403/)
    assert.match(result.msg, /API key not valid/, '应带出厂商的可读原因')
    assert.equal(result.text, undefined, '失败时绝不能带译文')
  })
})

test('谷歌：空译文、坏 JSON、超时都转成 ok:false', async () => {
  await withGoogleKey('gk-test', async () => {
    const empty = captureFetch(jsonResponse({ data: { translations: [] } }))
    assert.equal((await provider.translate(google, payload, { fetch: empty.impl })).ok, false)

    const broken = captureFetch({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })
    const parsed = await provider.translate(google, payload, { fetch: broken.impl })
    assert.equal(parsed.ok, false)
    assert.match(parsed.msg, /无法解析/)

    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const timedOut = await provider.translate(google, payload, { fetch: captureFetch(timeout).impl })
    assert.equal(timedOut.ok, false)
    assert.match(timedOut.msg, /超时/)
  })
})

// --- Gemini 翻译 ---------------------------------------------------------------
// 最容易出错的两点：2.5 系列默认开思考（必须关掉），
// 以及开思考时 parts 里会混入 thought:true 的推理片段（必须过滤）。

const gemini = { id: 'gemini', name: 'Gemini 翻译', enabled: true, wired: true, model: 'gemini-2.5-flash' }

test('Gemini：凭据缺失时 fail-closed，不发任何请求', async () => {
  await withGeminiKey(null, async () => {
    const { calls, impl } = captureFetch(jsonResponse({
      candidates: [{ content: { parts: [{ text: '你好' }] } }]
    }))
    const result = await provider.translate(gemini, payload, { fetch: impl })
    assert.equal(result.ok, false)
    assert.match(result.msg, /凭据未配置/)
    assert.equal(calls.length, 0)
  })
})

test('Gemini：请求结构正确，且显式关闭思考模式', async () => {
  await withGeminiKey('gm-test', async () => {
    const { calls, impl } = captureFetch(jsonResponse({
      candidates: [{ content: { parts: [{ text: '  你好世界  ' }], role: 'model' }, finishReason: 'STOP' }]
    }))
    const result = await provider.translate(gemini, Object.assign({}, payload, { text: 'hello world' }),
      { fetch: impl })

    assert.equal(result.ok, true)
    assert.equal(result.text, '你好世界')

    assert.match(calls[0].url,
      /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent\?key=gm-test$/)
    const body = JSON.parse(calls[0].options.body)
    // Gemini 用 contents/parts，不是 messages/content
    assert.equal(body.contents.length, 1)
    assert.equal(body.contents[0].role, 'user')
    assert.equal(body.contents[0].parts[0].text, 'hello world')
    // system 指令是顶层字段，不占 contents
    assert.ok(body.systemInstruction, 'system 指令必须走顶层 systemInstruction')
    assert.match(body.systemInstruction.parts[0].text, /中文/, '目标语言应出现在指令里')
    assert.equal(body.generationConfig.temperature, 0, '翻译要稳定，温度必须为 0')
    // 开着思考会变慢、token 翻倍，且让 temperature 失效
    assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0, '必须显式关闭思考模式')
  })
})

test('Gemini：过滤掉 thought 推理片段，只返回正文', async () => {
  await withGeminiKey('gm-test', async () => {
    // 真实场景：开思考时 parts 里会先出现 thought:true 的推理，再出现正文
    const { impl } = captureFetch(jsonResponse({
      candidates: [{
        content: {
          role: 'model',
          parts: [
            { thought: true, text: '让我想想这句话怎么翻……' },
            { text: '你好世界' }
          ]
        },
        finishReason: 'STOP'
      }]
    }))
    const result = await provider.translate(gemini, payload, { fetch: impl })
    assert.equal(result.ok, true)
    assert.equal(result.text, '你好世界', '推理过程绝不能当译文返回给商户')
    assert.doesNotMatch(result.text, /让我想想/)
  })
})

test('Gemini：内容被安全策略拦下时给出可读原因', async () => {
  await withGeminiKey('gm-test', async () => {
    const { impl } = captureFetch(jsonResponse({
      promptFeedback: { blockReason: 'SAFETY' }
    }))
    const result = await provider.translate(gemini, payload, { fetch: impl })
    assert.equal(result.ok, false)
    assert.match(result.msg, /SAFETY/)
  })
})

test('Gemini：厂商错误、空译文、超时都转成 ok:false', async () => {
  await withGeminiKey('gm-test', async () => {
    const denied = captureFetch(jsonResponse(
      { error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT' } }, 400))
    const failed = await provider.translate(gemini, payload, { fetch: denied.impl })
    assert.equal(failed.ok, false)
    assert.match(failed.msg, /API key not valid/)

    const empty = captureFetch(jsonResponse({ candidates: [{ content: { parts: [{ text: '   ' }] } }] }))
    assert.equal((await provider.translate(gemini, payload, { fetch: empty.impl })).ok, false)

    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const timedOut = await provider.translate(gemini, payload, { fetch: captureFetch(timeout).impl })
    assert.equal(timedOut.ok, false)
    assert.match(timedOut.msg, /超时/)
  })
})

test('谷歌与 Gemini：模型/端点可在后台覆盖', async () => {
  await withGeminiKey('gm-test', async () => {
    const { calls, impl } = captureFetch(jsonResponse({
      candidates: [{ content: { parts: [{ text: '好' }] } }]
    }))
    // 后台只填到域名时，应自动补出完整路径（与 deepseek 同样的坑）
    await provider.translate(
      { id: 'gemini', name: 'Gemini 翻译', enabled: true, wired: true, model: 'gemini-2.5-pro', endpoint: 'https://generativelanguage.googleapis.com' },
      payload, { fetch: impl })
    assert.match(calls[0].url, /\/v1beta\/models\/gemini-2\.5-pro:generateContent/)
  })
})

test('谷歌与 Gemini：登进注册表、凭据状态可查', async () => {
  assert.equal(provider.providers.google.name, '谷歌翻译')
  assert.equal(provider.providers.gemini.name, 'Gemini 翻译')

  await withGoogleKey(null, () => {
    assert.equal(provider.providers.google.configured({}), false)
    assert.equal(provider.providers.google.configured({ apiKey: 'k' }), true)
  })
  await withGeminiKey(null, () => {
    assert.equal(provider.providers.gemini.configured({}), false)
    assert.equal(provider.providers.gemini.configured({ apiKey: 'k' }), true)
  })
})
