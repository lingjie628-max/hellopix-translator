'use strict'

/**
 * Telegram 独立端：退出登录必须把服务端会话一起清掉。
 *
 * ## 真实故障
 *
 * A 账号登录 → 退出 → B 账号登录，结果进去的是 **A 账号**。
 *
 * 原因在 `pix:logout`：它只把 `store` 里的 `data.pix` 置 null，而
 * `pix-api` 的 `state.cookies` 里还留着 A 的 `pix_user` / `pix_csrf`。
 * 下一次 `pix:login` 带着这组旧 cookie 去请求，服务端看到"已有有效会话"
 * 就直接复用 —— 登录接口收下的是 B 的账号密码，返回的却是 A 的身份。
 * 共享设备/多开场景下这就是串号。
 *
 * 这里做的是**行为测试**：真跑 lp 模块，看 cookie 是否被真正清掉，
 * 而不是断言"源码里出现过 clearSession 这几个字"。
 */

const test = require('node:test')
const assert = require('node:assert')

const { createPixApi } = require('../standalone/telegram/lib/pix-api')

function fakeFetch(response) {
  return async function () {
    return {
      status: 200,
      headers: {
        getSetCookie: () => (response || ['pix_user=alice-session; Path=/']),
        get: () => null,
        forEach: () => {}
      },
      text: async () => JSON.stringify({ success: true })
    }
  }
}

test('clearSession：内存里的 cookie 必须清空', async () => {
  const api = createPixApi({ fetch: fakeFetch() })
  await api.request('/client/login')
  assert.ok(Object.keys(api.state.cookies).length > 0, '前提：登录后应该有 cookie')

  api.clearSession()
  assert.deepStrictEqual(api.state.cookies, {}, '退出后 cookie 还在，下一个账号会带着旧会话登进去')
})

test('clearSession：必须把清空后的状态落盘（否则重启后旧 cookie 又回来）', async () => {
  const saved = []
  const api = createPixApi({
    fetch: fakeFetch(),
    onCookies: cookies => saved.push(cookies)
  })
  await api.request('/client/login')
  const before = saved.length

  api.clearSession()
  assert.ok(saved.length > before, 'clearSession 没有触发 onCookies，磁盘上仍是旧 cookie')
  const last = saved[saved.length - 1]
  assert.deepStrictEqual(last, {}, '落盘的 cookie 不是空的')
})

test('clearSession 之后请求不再携带旧会话 cookie', async () => {
  const headersSeen = []
  const api = createPixApi({
    fetch: async (url, init) => {
      headersSeen.push(Object.assign({}, init.headers))
      return {
        status: 200,
        headers: { getSetCookie: () => ['pix_user=alice; Path=/'], get: () => null, forEach: () => {} },
        text: async () => JSON.stringify({ success: true })
      }
    }
  })
  // 第一次请求拿到 cookie
  await api.request('/client/login')
  // 第二次请求必须带上它（证明 cookie 真的在生效）
  await api.request('/client/session')
  assert.match(headersSeen[1].Cookie || '', /pix_user=alice/, '前提：登录之后的请求应该带 cookie')

  api.clearSession()
  await api.request('/client/session')
  assert.strictEqual(headersSeen[2].Cookie, undefined, '清会话之后仍带着旧 cookie 发请求')
})

test('clearSession 不能被重复调用搞出异常', () => {
  const api = createPixApi({ fetch: fakeFetch() })
  api.clearSession()
  api.clearSession()
  assert.deepStrictEqual(api.state.cookies, {})
})
