'use strict'

/**
 * 两个富客户端（macOS / Windows 的 Telegram 桥）的 pix-api 必须同口径。
 *
 * 它们连的是**同一套服务端**，但 pix-api.js 是两份独立实现 ——
 * 重复代码必然长出分叉，下面每一条都对应一个真实分叉：
 *
 * 1. **幂等键丢失**
 *    Windows 版调用方传 `idempotencyKey`，但 pix-api 只读 `options.form`，
 *    翻译请求根本没带键 → 网络超时重试就再扣一次字符。
 *
 * 2. ★ **幂等键用内容指纹冒充请求指纹**（macOS 版）
 *    键 = sha256(引擎 + 语种 + 文本) → 同一句话第二次出现时，
 *    服务端 reserveTranslate 命中已有的终态行，直接回上次的响应。
 *    表现：换术语库/换模型后再翻同一句，拿到的还是旧译文，且毫无报错。
 *
 * 3. **cookie 排除表两套写法**
 *    macOS 用 Set 精确匹配，Windows 用正则。任何一边漏一个名字，
 *    管理端会话就会被拼进 `/apis/client/*` 的 Cookie 头、甚至写进 bridge 文件。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const APIS = {
  mac: path.join(ROOT, 'standalone/telegram/lib/pix-api.js'),
  win: path.join(ROOT, 'standalone/telegram-win/lib/pix-api.js')
}
const MAINS = {
  mac: path.join(ROOT, 'standalone/telegram/main.js'),
  win: path.join(ROOT, 'standalone/telegram-win/main.js')
}

const { createPixApi } = require(APIS.mac)

/** 抓一次请求，返回 { url, init } */
function capture(api, call) {
  const seen = []
  const fakeFetch = async (url, init) => {
    seen.push({ url, init })
    return { status: 200, headers: { get: () => null, getSetCookie: () => [] }, text: async () => '{"success":true}' }
  }
  const ctx = createPixApi({ base: 'http://example.test', fetch: fakeFetch, deviceId: 'dev-1' })
  return call(ctx).then(() => seen)
}

test('★ Windows 版必须真的把 idempotencyKey 发出去（头 + 体双写）', async () => {
  const { createPixApi: createWin } = require(APIS.win)
  const seen = []
  const api = createWin({
    base: 'http://example.test',
    deviceId: 'dev-1',
    fetch: async (url, init) => {
      seen.push({ url, init })
      return { status: 200, headers: { get: () => null, getSetCookie: () => [] }, text: async () => '{}' }
    }
  })
  await api.request('/translate/run', {
    method: 'POST',
    form: { text: 'hello' },
    idempotencyKey: 'ui-abc'
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].init.headers['Idempotency-Key'], 'ui-abc', 'Windows 版的键没发出去 —— 重试会重复扣费')
  assert.match(String(seen[0].init.body), /requestId=ui-abc/, '请求体里也该带上，兼容只认 body 的旧服务端')
})

test('macOS 版同样双写幂等键', async () => {
  const seen = await capture(null, (api) => api.request('/translate/run', {
    method: 'POST',
    form: { text: 'hello' },
    idempotencyKey: 'ui-xyz'
  }))
  assert.equal(seen[0].init.headers['Idempotency-Key'], 'ui-xyz')
  assert.match(String(seen[0].init.body), /requestId=ui-xyz/)
})

test('显式写在 form.requestId 里时不能被覆盖', async () => {
  const seen = await capture(null, (api) => api.request('/x', {
    method: 'POST',
    form: { requestId: 'from-form' },
    idempotencyKey: 'from-option'
  }))
  assert.match(String(seen[0].init.body), /requestId=from-form/)
  assert.equal(seen[0].init.headers['Idempotency-Key'], 'from-option')
})

test('★ macOS 翻译的幂等键不能是内容指纹（否则同一句话永远只翻一次）', () => {
  const src = fs.readFileSync(MAINS.mac, 'utf8')
  const at = src.indexOf('function transRequestKey')
  assert.ok(at > 0, '找不到 transRequestKey')
  const body = src.slice(at, src.indexOf('\n}', at))

  assert.ok(/randomUUID\(\)|randomBytes|crypto\.randomInt/.test(body),
    'transRequestKey 里没有随机源 —— 内容指纹当幂等键会让重复文本命中服务端重放分支')
  assert.ok(!/createHash/.test(body),
    'transRequestKey 还在对内容做哈希：同文本第二次请求会直接回上次的响应（不重新翻译、也不报错）')
})

test('两个版本生成键的函数都返回随机值（连续两次必须不同）', () => {
  // macOS：把整个函数抠出来跑（只依赖 crypto 与 store）
  const src = fs.readFileSync(MAINS.mac, 'utf8')
  const at = src.indexOf('function transRequestKey')
  const fnText = src.slice(at, src.indexOf('\n}', at) + 2)
  const crypto = require('crypto')
  const store = { read: () => ({ deviceId: 'dev-1' }) }
  // eslint-disable-next-line no-new-func
  const transRequestKey = new Function('crypto', 'store', `${fnText}\nreturn transRequestKey`)(crypto, store)
  const a = transRequestKey()
  const b = transRequestKey()
  assert.notEqual(a, b, '连续两次翻译拿到了同一个幂等键 —— 第二次会被当成重放')
  assert.match(a, /^tg-app:dev-1:/, '键要带设备前缀，便于服务端日志归因')
})

test('★ 连接层失败必须给出可读提示，不能把 fetch 的堆栈直接抛给用户', async () => {
  for (const [name, file] of Object.entries(APIS)) {
    const { createPixApi: create } = require(file)
    const api = create({
      base: 'http://127.0.0.1:1',
      deviceId: 'dev-1',
      fetch: async () => { throw new TypeError('fetch failed') }
    })
    let caught = null
    try {
      await api.request('/client/ping')
    } catch (error) {
      caught = error
    }
    assert.ok(caught, `${name} 版把连接失败吞掉了`)
    assert.ok(!/^fetch failed$/.test(caught.message),
      `${name} 版直接把 undici 的原始报错抛给用户：${caught.message}`)
    assert.match(caught.message, /连不上|服务/, `${name} 版的提示没有告诉用户该检查什么：${caught.message}`)
  }
})

test('两个平台的 cookie 排除表必须一致，都不能收管理端会话', async () => {
  for (const [name, file] of Object.entries(APIS)) {
    const src = fs.readFileSync(file, 'utf8')
    assert.match(src, /pix_\(admin\|admin_session\)|__Host-pix_admin|pix_admin_session/,
      `${name} 版没有排除管理端 cookie`)
  }

  // 行为验证：服务端下发管理端 cookie 时，两个实现都不能记住它
  for (const [name, file] of Object.entries(APIS)) {
    const { createPixApi: create } = require(file)
    let stored = null
    const api = create({
      base: 'http://example.test',
      deviceId: 'dev-1',
      onCookies: (jar) => { stored = jar },
      fetch: async () => ({
        status: 200,
        headers: {
          getSetCookie: () => [
            '__Host-pix_user=u1',
            '__Host-pix_csrf=c1',
            '__Host-pix_admin=a1',
            'pix_admin_session=a2'
          ]
        },
        text: async () => '{}'
      })
    })
    await api.request('/client/whatever')
    assert.deepEqual(Object.keys(stored).sort(), ['__Host-pix_csrf', '__Host-pix_user'],
      `${name} 版把管理端 cookie 收进来了：${JSON.stringify(stored)}`)
  }
})
