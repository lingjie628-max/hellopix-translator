'use strict'

/**
 * 机房失联应急公告页的拦截行为（PIX_MAINTENANCE）。
 *
 * ## 为什么必须测「拦截发生在注册顺序的哪一步」
 *
 * 这个中间件第一版写在了 `api.register()` **之后**。语法没错、逻辑没错，
 * 但 express 按注册顺序匹配路由，于是 `/apis/*` 全部被 API 路由先接走了，
 * 公告页对登录接口完全无效 —— 用户照样能走到"账号不存在"的错误。
 *
 * 实测证据（第一版）：`/apis/user/captcha` 返回 200，根路径返回 503。
 * 也就是说只测根路径的用例会**全绿**，而漏洞依然存在。
 * 所以这里必须同时断言页面路由和 API 路由，且必须跑真实的 createApp。
 *
 * ## 为什么放行静态资源
 *
 * 公告页本身是内联样式、零外部依赖，但仍需放行 js/css —— 浏览器会预取，
 * 且后续若要给公告页加图表/字体，全拦掉会让公告页自己白屏。
 * 这条同时守住"别把拦截写得太宽把静态资源也吞了"。
 */

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')

/** 起真实服务（mock API，不连库），返回 { base, close }。 */
async function bootServer (env) {
  const saved = {}
  const keys = ['PIX_MAINTENANCE']
  for (const k of keys) {
    saved[k] = process.env[k]
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }

  // 每次都重新 require，让 env 在模块加载期生效（与线上 launchd 重启语义一致）
  delete require.cache[require.resolve('../server/index')]
  const { createApp } = require('../server/index')

  const app = await createApp({ production: false, usePersistent: false, port: 0 })
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    base: `http://127.0.0.1:${port}`,
    async close () {
      // keep-alive 连接不主动断的话 server.close 会一直等，测试进程挂住不退出
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      delete require.cache[require.resolve('../server/index')]
    }
  }
}

function get (base, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + path, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('timeout')))
  })
}

test('开关打开：首页回 503 且是公告页内容', async () => {
  const s = await bootServer({ PIX_MAINTENANCE: '1' })
  try {
    const res = await get(s.base, '/')
    assert.equal(res.status, 503)
    assert.match(res.body, /系统维护中/)
    // 禁用缓存，否则恢复后用户浏览器里还钉着公告页
    assert.match(String(res.headers['cache-control'] || ''), /no-store/)
  } finally {
    await s.close()
  }
})

test('开关打开：API 必须一起拦（回归：装错注册位置的漏洞）', async () => {
  const s = await bootServer({ PIX_MAINTENANCE: '1' })
  try {
    // 这几个是用户最容易撞到的入口。任意一个漏了，用户就会看到
    // "账号不存在"这类误导性错误，以为数据丢了。
    for (const path of ['/apis/user/captcha', '/apis/site/info', '/apis/user/login']) {
      const res = await get(s.base, path)
      assert.equal(res.status, 503, `${path} 没被拦，泄漏到 API 路由了`)
      assert.match(res.body, /系统维护中/, `${path} 返回了非公告页内容`)
    }
  } finally {
    await s.close()
  }
})

test('开关打开：/health 与静态资源必须放行', async () => {
  const s = await bootServer({ PIX_MAINTENANCE: '1' })
  try {
    const health = await get(s.base, '/health')
    assert.equal(health.status, 200, '/health 被拦会让外部监控误判成彻底宕机')
    assert.ok(JSON.parse(health.body).ok === true)

    // 静态产物放行（不 503 即可，具体文件可能不存在回 404）
    for (const path of ['/theme.js', '/css/anything.css']) {
      const res = await get(s.base, path)
      assert.notEqual(res.status, 503, `${path} 不该被公告页拦掉`)
    }
  } finally {
    await s.close()
  }
})

test('开关关闭：正常服务，不出现公告页', async () => {
  const s = await bootServer({ PIX_MAINTENANCE: undefined })
  try {
    const health = await get(s.base, '/health')
    assert.equal(health.status, 200)

    // 首页正常出页面（官网或主应用），绝不能是公告页
    const home = await get(s.base, '/')
    assert.notEqual(home.status, 503)
    assert.doesNotMatch(home.body, /系统维护中/, '开关关闭时不该出现公告页')
  } finally {
    await s.close()
  }
})

// createApp 会起服务的后台定时器（会话清理、结算扫描等），HTTP server 关了它们还在，
// 导致 `node --test` 收尾时进程不退出、CI 一直挂。断言全跑完之后显式退出。
// 用 after 而不是在每个用例里 exit，保证所有用例都执行到。
test.after(() => {
  setImmediate(() => process.exit(process.exitCode || 0))
})
