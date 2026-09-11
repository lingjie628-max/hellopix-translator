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

const CREDENTIAL_KEYS = ['PIX_YOUDAO_APP_KEY', 'PIX_YOUDAO_APP_SECRET']

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

test('detectLang and countBillableChars keep their billing semantics', () => {
  assert.equal(provider.detectLang('你好'), 'zh')
  assert.equal(provider.detectLang('こんにちは'), 'ja')
  assert.equal(provider.detectLang('안녕'), 'ko')
  assert.equal(provider.detectLang('hello'), 'en')
  // 中文按 2 字符计费，其余按 1
  assert.equal(provider.countBillableChars('你好ab'), 6)
  assert.equal(provider.countBillableChars(''), 0)
})
