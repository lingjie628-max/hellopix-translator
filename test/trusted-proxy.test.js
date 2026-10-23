'use strict'

/**
 * 客户端 IP 必须可信 —— 否则所有按 IP 的防护都是装饰品。
 *
 * ## 发现过程
 *
 * 2026-10-23 重做授权时顺手验了一下代理配置，发现 nginx 用的是
 *
 *     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
 *
 * 这是**追加**语义：攻击者请求里自带 `X-Forwarded-For: 1.2.3.4`，
 * nginx 会把它拼成 `1.2.3.4, <真实IP>`。而 Express 取最左值 —— 实测确认：
 *
 *     伪造 XFF 时 req.ip = 203.0.113.5   ← 攻击者填的
 *     正常请求   req.ip = 203.0.113.5
 *
 * 后果是全链路的：
 *   · 登录/注册/翻译限流 —— 每次换一个假 IP 就能无限刷
 *   · 审计日志的 IP —— 全是攻击者写的假值，事后溯源全废
 *   · 会话 IP 绑定 —— 形同虚设
 *   · 新 IP 登录告警 —— 永远不触发
 *
 * 也就是：**只要这一行没改，本次加固的一大半都不生效。**
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const NGINX_CONF = path.join(__dirname, '..', 'deploy', 'nginx', 'hello-pix.conf')
const INDEX = path.join(__dirname, '..', 'server', 'index.js')

test('nginx 不能用 $proxy_add_x_forwarded_for（追加语义可被伪造）', () => {
  const conf = fs.readFileSync(NGINX_CONF, 'utf8')
  assert.doesNotMatch(
    conf, /proxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for/,
    '这行会让攻击者自带的 X-Forwarded-For 生效，req.ip 可被任意伪造'
  )
})

test('nginx 必须用 $remote_addr 覆盖 X-Forwarded-For', () => {
  const conf = fs.readFileSync(NGINX_CONF, 'utf8')
  const matches = conf.match(/proxy_set_header\s+X-Forwarded-For\s+\$remote_addr/g) || []
  assert.ok(matches.length >= 2, '两处 /apis location 都要覆盖（实际 ' + matches.length + ' 处）')
})

test('Express 的 trust proxy 只信任回环（不能信任任意上游）', () => {
  const source = fs.readFileSync(INDEX, 'utf8')
  assert.match(source, /app\.set\('trust proxy',\s*'loopback'\)/,
    'trust proxy 必须是 loopback：信任面越窄越好')
  assert.doesNotMatch(source, /app\.set\('trust proxy',\s*true\)/,
    'trust proxy: true 等于信任任何上游转发的 XFF，可被伪造')
})

// ── 行为验证：伪造的 XFF 不能改变 req.ip ─────────────────

test('实测：伪造 XFF 时 Express 仍取真实对端（loopback 信任下）', async () => {
  const express = require('express')
  const app = express()
  app.set('trust proxy', 'loopback')
  app.get('/t', (req, res) => res.json({ ip: req.ip }))
  const server = await new Promise(resolve => {
    const v = app.listen(0, '127.0.0.1', () => resolve(v))
  })
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const res = await fetch(base + '/t', {
      headers: { 'X-Forwarded-For': '9.9.9.9, 203.0.113.5' }
    })
    const ip = (await res.json()).ip
    // 回环是受信任的上游，所以 Express 会取 XFF 里**最后一跳之外**的值，
    // 也就是最左值。这里是 loopback 单层场景，取到的就是 203.0.113.5。
    // 关键结论：单靠 Express 挡不住伪造 —— 必须由 nginx 覆盖（上面两条测试）。
    assert.equal(ip, '203.0.113.5',
      '记录当前真实行为：Express 端挡不住伪造，所以 nginx 覆盖是**唯一**防线')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
