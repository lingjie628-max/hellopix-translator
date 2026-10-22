'use strict'

/**
 * Telegram 独立客户端（standalone/telegram）的会话 cookie 边界。
 *
 * ## 这里的三个问题都是真的
 *
 * 1. **管理端会话被收进客户端 jar**
 *    正则 `(?:__Host-)?pix_` 是前缀匹配，把 `__Host-pix_admin` 也放进来了。
 *    这个客户端永远不调管理员接口，那条 cookie 唯一的去向就是被拼进
 *    每个 `/apis/client/*` 的 Cookie 头。
 *
 * 2. **登出清不掉 cookie**
 *    服务端登出下发的是 `pix_user=; Max-Age=0`（空值）。把空值写进
 *    `state.cookies` 之后，`cookieHeader()` 会输出 `pix_user=` ——
 *    和"压根没有这条 cookie"是两回事。
 *
 * 3. **cookie 完全没有持久化（macOS 版）**
 *    Windows 版（telegram-win）一直把 cookies 存进 store 并在启动时恢复，
 *    macOS 版建 api 时只传了 deviceId。于是重启 Telegram 客户端 =
 *    掉 Hello Pix 登录态，用户每次都要重新登录。
 */

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const { createPixApi } = require(path.join(__dirname, '..', 'standalone', 'telegram', 'lib', 'pix-api.js'))

/** 造一个最小的 fetch Response 替身，只要 headers.getSetCookie。 */
function fakeResponse (setCookies, body) {
  return {
    headers: {
      getSetCookie: () => setCookies,
      get: (name) => (name.toLowerCase() === 'set-cookie' ? setCookies.join(', ') : null)
    },
    text: async () => JSON.stringify(body || { success: true })
  }
}

/** 替换全局 fetch，跑一次 request，返回当时的 Cookie 头。 */
async function runRequest (api, headersSeen, setCookies, body) {
  const original = global.fetch
  global.fetch = async (_url, init) => {
    headersSeen.push(Object.assign({}, init.headers))
    return fakeResponse(setCookies, body)
  }
  try {
    return await api.request('/client/session')
  } finally {
    global.fetch = original
  }
}

test('普通用户会话会被记住并带在下一次请求上', async () => {
  const api = createPixApi({ base: 'http://x', deviceId: 'd1' })
  const seen = []
  await runRequest(api, seen, ['__Host-pix_user=abc; Path=/; HttpOnly'])
  assert.equal(api.state.cookies['__Host-pix_user'], 'abc')

  await runRequest(api, seen, [])
  assert.match(seen[1].Cookie, /__Host-pix_user=abc/)
})

test('★ 管理端会话不得进入客户端 jar', async () => {
  const api = createPixApi({ base: 'http://x', deviceId: 'd1' })
  const seen = []
  await runRequest(api, seen, [
    '__Host-pix_user=user-token; Path=/; HttpOnly',
    '__Host-pix_admin=admin-token; Path=/; HttpOnly'
  ])

  assert.equal(api.state.cookies['__Host-pix_user'], 'user-token')
  assert.equal(api.state.cookies['__Host-pix_admin'], undefined,
    'admin 会话会跟着每一个客户端请求发出去')

  await runRequest(api, seen, [])
  assert.equal(/pix_admin/.test(seen[1].Cookie || ''), false)
})

test('★ 登出下发的空值必须把 cookie 删掉，而不是留一个空串', async () => {
  const api = createPixApi({ base: 'http://x', deviceId: 'd1' })
  const seen = []
  await runRequest(api, seen, ['__Host-pix_user=live; Path=/; HttpOnly'])
  assert.equal(api.state.cookies['__Host-pix_user'], 'live')

  await runRequest(api, seen, ['__Host-pix_user=; Path=/; Max-Age=0'])
  assert.equal('__Host-pix_user' in api.state.cookies, false,
    '留着空串会让 cookieHeader 输出 `pix_user=`，那和"没有登录"不是一回事')

  await runRequest(api, seen, [])
  assert.equal(/__Host-pix_user=($|;)/.test(seen[2].Cookie || ''), false,
    'Cookie 头里不能再出现空值的 pix_user')
})

test('★ 空值 cookie 根本不该出现在 Cookie 头里', async () => {
  const api = createPixApi({ base: 'http://x', deviceId: 'd1', cookies: { pix_user: '', pix_csrf: 'tok' } })
  const seen = []
  await runRequest(api, seen, [])
  assert.equal(/pix_user=($|;)/.test(seen[0].Cookie || ''), false)
  assert.match(seen[0].Cookie, /pix_csrf=tok/)
})

test('★ 从 options.cookies 恢复会话（重启后不掉登录态）', () => {
  const api = createPixApi({
    base: 'http://x',
    deviceId: 'd1',
    cookies: { '__Host-pix_user': 'restored', '__Host-pix_csrf': 'c1' }
  })
  assert.equal(api.state.cookies['__Host-pix_user'], 'restored')
  assert.equal(api.state.cookies['__Host-pix_csrf'], 'c1')
})

test('★ cookie 变化时必须回调 onCookies（供上层落盘）', async () => {
  const saved = []
  const api = createPixApi({
    base: 'http://x',
    deviceId: 'd1',
    onCookies: (cookies) => saved.push(cookies)
  })
  await runRequest(api, [], ['__Host-pix_user=abc; Path=/'])

  assert.equal(saved.length, 1, '没有回调就没办法持久化，重启必掉登录态')
  assert.equal(saved[0]['__Host-pix_user'], 'abc')
})

test('cookie 值没变时不该重复回调（避免无谓写盘）', async () => {
  const saved = []
  const api = createPixApi({
    base: 'http://x',
    deviceId: 'd1',
    onCookies: (cookies) => saved.push(cookies)
  })
  await runRequest(api, [], ['__Host-pix_user=abc; Path=/'])
  await runRequest(api, [], ['__Host-pix_user=abc; Path=/'])
  assert.equal(saved.length, 1)
})

test('登出清空 cookie 也要回调（否则磁盘上留着旧会话）', async () => {
  const saved = []
  const api = createPixApi({
    base: 'http://x',
    deviceId: 'd1',
    cookies: { '__Host-pix_user': 'old' },
    onCookies: (cookies) => saved.push(cookies)
  })
  await runRequest(api, [], ['__Host-pix_user=; Max-Age=0'])
  assert.equal(saved.length, 1)
  assert.equal('__Host-pix_user' in saved[0], false)
})

test('onCookies 抛错不能把请求本身搞挂', async () => {
  const api = createPixApi({
    base: 'http://x',
    deviceId: 'd1',
    onCookies: () => { throw new Error('disk full') }
  })
  const result = await runRequest(api, [], ['__Host-pix_user=abc; Path=/'], { success: true, ok: 1 })
  assert.equal(result.ok, 1, '落盘失败不该影响正在进行的请求')
})

test('别的系统的 cookie 不许混进来', async () => {
  const api = createPixApi({ base: 'http://x', deviceId: 'd1' })
  await runRequest(api, [], ['sessionid=abc; Path=/', '__Host-other=x; Path=/'])
  assert.deepEqual(Object.keys(api.state.cookies), [])
})
