/**
 * 上游连接池：翻译链路提速的一部分。
 *
 * ## 为什么值得单独测
 *
 * `pooledFetch` 挂在**每一次翻译**的出站请求上。它一旦出错，翻译就整个挂掉 ——
 * 这是"性能优化引发的功能故障"的典型形态，比慢严重得多。所以这里守三条：
 *
 *   1. 能建池时必须真的把 dispatcher 传下去（否则等于没优化）；
 *   2. 建不出池（没有 undici、URL 非法）时**必须退化成裸 fetch**，不能抛；
 *   3. `warmUp` 失败静默 —— 预热是锦上添花，不能成为启动失败的借口。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const pool = require('../server/lib/http-pool')

/** 临时替换 globalThis.fetch，记录收到什么，跑完恢复。 */
async function withFakeFetch (impl, fn) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init })
    return impl ? impl(input, init) : { ok: true }
  }
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}

test('pooledFetch：合法 URL 会带上 dispatcher（否则等于没连池）', async () => {
  await withFakeFetch(null, async (calls) => {
    await pool.pooledFetch('https://api.deepseek.com/chat/completions', { method: 'POST' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.method, 'POST', '原有 init 必须保留')
    // 环境里有 undici 才谈得上 dispatcher
    if (pool._agentCount() > 0) {
      assert.ok(calls[0].init.dispatcher, '必须把 dispatcher 传下去')
    }
  })
})

test('pooledFetch：非法 URL 必须被拦，不能穿透到裸 fetch', async () => {
  // 语义变更（SSRF 防护）：以前非法 URL 直接退化成裸 fetch。
  // 现在 outbound-guard 会先判——无法解析的目标不允许出站，
  // 否则就是一条"用畸形 URL 绕到裸 fetch 再打内网"的旁路。
  await withFakeFetch(null, async (calls) => {
    await assert.rejects(
      () => pool.pooledFetch('not-a-url', { method: 'GET' }),
      /出站请求被拦截/
    )
    assert.equal(calls.length, 0, '被拦截后不应真的发出请求')
  })
})

test('pooledFetch：内网目标必须被拦', async () => {
  await withFakeFetch(null, async (calls) => {
    for (const url of [
      'https://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1:443/',
      'https://[::ffff:127.0.0.1]/'
    ]) {
      await assert.rejects(() => pool.pooledFetch(url, { method: 'GET' }), /出站请求被拦截/)
    }
    assert.equal(calls.length, 0)
  })
})

test('pooledFetch：input 是 Request 对象时也能认出来', async () => {
  await withFakeFetch(null, async (calls) => {
    await pool.pooledFetch({ url: 'https://api.openai.com/v1/chat/completions' }, { method: 'POST' })
    assert.equal(calls.length, 1)
  })
})

test('pooledFetch：同一个 origin 复用同一个池', async () => {
  await withFakeFetch(null, async () => {
    await pool.pooledFetch('https://api.deepseek.com/a', {})
    const n1 = pool._agentCount()
    await pool.pooledFetch('https://api.deepseek.com/b', {})
    assert.equal(pool._agentCount(), n1, '同域名不该重复建池')
  })
})

test('warmUp：任何人失败都不抛，也不影响其它域名', async () => {
  await withFakeFetch(async (input) => {
    if (String(input).includes('broken')) throw new Error('ECONNREFUSED')
    return { ok: true }
  }, async (calls) => {
    await pool.warmUp(['https://broken.example.com', 'https://api.deepseek.com'])
    // 两个都应该试过 —— 前一个失败不能打断后一个
    const urls = calls.map(c => String(c.input))
    assert.ok(urls.some(u => u.includes('broken')))
    assert.ok(urls.some(u => u.includes('deepseek')))
    // 预热请求不能带凭据
    calls.forEach(c => {
      const h = (c.init && c.init.headers) || {}
      assert.ok(!/authorization/i.test(Object.keys(h).join(',')), '预热不能带凭据')
    })
  })
})

test('warmUp：空输入 / 非数组直接返回', async () => {
  await pool.warmUp([])
  await pool.warmUp(null)
  await pool.warmUp(undefined)
})

test('closeAgents：清理后池计数归零，可重复调用', async () => {
  await withFakeFetch(null, async () => {
    await pool.pooledFetch('https://api.deepseek.com/x', {})
  })
  await pool.closeAgents()
  await pool.closeAgents()
  assert.equal(pool._agentCount(), 0)
})

test('翻译适配层用的是 poolFetch，不是裸 globalThis.fetch', () => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'server/services/translation-provider.js'), 'utf8')
  assert.ok(/require\('\.\.\/lib\/http-pool'\)/.test(src), '必须引入连接池')
  assert.ok(/fetch:\s*pooledFetch/.test(src), '默认 fetch 必须是池化版本')
  // 裸 fetch 只允许作为回退路径出现在 http-pool 内部
  assert.ok(!/fetch:\s*globalThis\.fetch/.test(src), '不能把默认值设回裸 fetch')
})
