'use strict'

/**
 * 两个独立客户端（macOS / Windows）的 cookie 边界**必须一致**。
 *
 * ## 为什么要跨平台跑同一套断言
 *
 * 这两份 `lib/pix-api.js` 是**独立实现**，不是共享模块。历史事实：
 *
 *   · macOS 版忘了持久化 cookie        → 重启掉登录态（Windows 版早就有）
 *   · Windows 版忘了过滤管理端 cookie  → 管理端会话漏进 bridge 文件
 *
 * 每次都是"只修了一边"。人会忘，测试不会 —— 所以这里对两个目录跑完全相同的
 * 用例，谁落后谁当场红。
 *
 * ## 覆盖的四个边界
 *
 *   1. 退出登录必须清空内存 + 落盘（否则跨账号串号）
 *   2. 空值 cookie 必须删除，不能留空串
 *   3. 空串 cookie 不能出现在 Cookie 头里
 *   4. 管理端 cookie（pix_admin / __Host-pix_admin）不许进客户端 jar
 */

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')

const ROOT = path.join(__dirname, '..')

const IMPLEMENTATIONS = [
  { name: 'macOS', file: 'standalone/telegram/lib/pix-api.js' },
  { name: 'Windows', file: 'standalone/telegram-win/lib/pix-api.js' }
]

function fakeResponse(setCookies) {
  return {
    status: 200,
    headers: {
      getSetCookie: () => setCookies,
      get: name => (String(name).toLowerCase() === 'set-cookie' ? setCookies.join(', ') : null),
      forEach: () => {}
    },
    text: async () => JSON.stringify({ success: true })
  }
}

/** 跑一个 request，返回它发出的 headers。 */
function harness(setCookies) {
  const seen = []
  const saved = []
  const fetchImpl = async (_url, init) => {
    seen.push(Object.assign({}, init.headers))
    return fakeResponse(setCookies)
  }
  return { seen, saved, fetchImpl }
}

for (const impl of IMPLEMENTATIONS) {
  const { createPixApi } = require(path.join(ROOT, impl.file))

  test('[' + impl.name + '] 退出登录：内存 cookie 必须清空', async () => {
    const h = harness(['pix_user=alice; Path=/'])
    const api = createPixApi({ fetch: h.fetchImpl })
    await api.request('/client/login')
    assert.ok(Object.keys(api.state.cookies).length > 0, '前提：登录后应有 cookie')

    api.clearSession()
    assert.deepStrictEqual(api.state.cookies, {},
      '退出后 cookie 还在 —— 下一个账号会带着旧会话登进去（跨账号串号）')
  })

  test('[' + impl.name + '] 退出登录：清空必须落盘', async () => {
    const h = harness(['pix_user=alice; Path=/'])
    const api = createPixApi({ fetch: h.fetchImpl, onCookies: c => h.saved.push(c) })
    await api.request('/client/login')
    const before = h.saved.length

    api.clearSession()
    assert.ok(h.saved.length > before, 'clearSession 没有触发 onCookies，磁盘上仍是旧 cookie')
    assert.deepStrictEqual(h.saved[h.saved.length - 1], {})
  })

  test('[' + impl.name + '] 清会话之后请求不再带旧 cookie', async () => {
    const h = harness(['pix_user=alice; Path=/'])
    const api = createPixApi({ fetch: h.fetchImpl })
    await api.request('/client/login')
    await api.request('/client/session')
    assert.match(h.seen[1].Cookie || '', /pix_user=alice/, '前提：登录后请求应带 cookie')

    api.clearSession()
    await api.request('/client/session')
    assert.strictEqual(h.seen[2].Cookie, undefined, '清会话之后仍带着旧 cookie')
  })

  test('[' + impl.name + '] 服务端下发的空值 cookie 必须删除而不是留空串', async () => {
    const h = harness(['pix_user=alice; Path=/'])
    const api = createPixApi({ fetch: h.fetchImpl })
    await api.request('/client/login')
    assert.ok('pix_user' in api.state.cookies)

    // 登出：服务端回 pix_user=; Max-Age=0
    const logout = harness(['pix_user=; Max-Age=0; Path=/'])
    const api2 = createPixApi({ fetch: logout.fetchImpl, cookies: { pix_user: 'alice' } })
    await api2.request('/client/logout', { method: 'POST', form: {} })
    assert.ok(!('pix_user' in api2.state.cookies),
      '空值得写成"删掉这条"，不能留一个空串 —— cookieHeader 会输出 pix_user=')
  })

  test('[' + impl.name + '] 空串 cookie 不能出现在 Cookie 头里', async () => {
    const h = harness([])
    const api = createPixApi({ fetch: h.fetchImpl, cookies: { pix_user: '', pix_device: 'dev-1' } })
    await api.request('/client/session')
    const header = h.seen[0].Cookie || ''
    assert.ok(!/pix_user=/.test(header), '空 cookie 被发出去了：' + header)
    assert.match(header, /pix_device=dev-1/)
  })

  test('[' + impl.name + '] 管理端 cookie 不许进客户端 jar', async () => {
    const h = harness([
      'pix_user=alice; Path=/',
      '__Host-pix_admin=super-secret; Path=/',
      'pix_admin_session=also-secret; Path=/'
    ])
    const api = createPixApi({ fetch: h.fetchImpl })
    await api.request('/client/login')
    assert.ok('pix_user' in api.state.cookies, '前提：普通会话要能收下')
    assert.ok(!('__Host-pix_admin' in api.state.cookies), '管理端会话混进了客户端 jar')
    assert.ok(!('pix_admin_session' in api.state.cookies), '管理端会话混进了客户端 jar')
  })
}

test('两份实现的 clearSession 都存在（防止再次只修一边）', () => {
  for (const impl of IMPLEMENTATIONS) {
    const mod = require(path.join(ROOT, impl.file))
    const api = mod.createPixApi({ fetch: async () => fakeResponse([]) })
    assert.equal(typeof api.clearSession, 'function', impl.name + ' 版缺少 clearSession')
  }
})
