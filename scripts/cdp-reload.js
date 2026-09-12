#!/usr/bin/env node
/**
 * 重载桌面端渲染层（等价按 Cmd+R），改完 CSS/HTML 后用它让改动生效。
 * 会自动跳过 Telegram 等嵌入页，只重载应用自己的页面。
 *
 * 用法：node scripts/cdp-reload.js
 */
const http = require('http')
const path = require('path')
let WebSocket
try { WebSocket = require('ws') } catch (e) { WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws')) }

const PORT = Number(process.env.CDP_PORT || 9225)
const getJson = u => new Promise((res, rej) => {
  http.get(u, r => { let b = ''; r.on('data', c => (b += c)); r.on('end', () => res(JSON.parse(b))) }).on('error', rej)
})

;(async () => {
  const targets = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).filter(t => t.type === 'page')
  const target = targets.find(t => t.url.startsWith('file://') && (t.title || '').includes('Hello Pix'))
    || targets.find(t => t.url.startsWith('file://'))
  if (!target) throw new Error('没找到应用页面')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const pend = new Map(); let id = 0
  ws.on('message', raw => {
    const m = JSON.parse(raw)
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
  })
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  await new Promise(r => ws.on('open', r))
  const done = new Promise(r => { ws.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Page.loadEventFired') r() }) })
  await send('Page.enable')
  await send('Page.reload', { ignoreCache: true })
  await Promise.race([done, new Promise(r => setTimeout(r, 8000))])
  console.log('已重载:', target.title)
  ws.close()
})().catch(e => { console.error('重载失败:', e.message); process.exit(1) })
