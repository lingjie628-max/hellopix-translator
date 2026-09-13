#!/usr/bin/env node
/**
 * 无头浏览器探针：用 Playwright 自带的 Chromium 打开网页端页面并求值。
 *
 * 用途：网页端（登录页 / 超管后台）的主进程侧没有调试端口可用，
 * 但主题、Element 变量这类东西必须看真实渲染才能确认。
 *
 * 用法：
 *   node scripts/web-probe.js <url> <expr-file|--expr 'js'>
 *   node scripts/web-probe.js http://127.0.0.1:3000/ --expr 'return document.title'
 *
 * 前置：先用 headless Chromium 起一个调试端口（见文件末尾注释的命令）。
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
let WebSocket
try { WebSocket = require('ws') } catch (e) { WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws')) }

const PORT = Number(process.env.CDP_PORT || 9333)

function req(method, urlPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method }, res => {
      let b = ''
      res.on('data', c => (b += c))
      res.on('end', () => resolve(b))
    })
    r.on('error', reject)
    r.end()
  })
}

async function main() {
  const [target, ...rest] = process.argv.slice(2)
  if (!target) {
    console.error('用法: node scripts/web-probe.js <url> <expr-file|--expr js>')
    process.exit(1)
  }
  // 用法里选项可出现在任意位置，这里按名字取值，剩下的第一个非选项即表达式
  const valOf = name => { const i = argvAll.indexOf(name); return i > -1 ? argvAll[i + 1] : null }
  const argvAll = process.argv.slice(2)
  let expr = valOf('--expr')
  if (expr === null) {
    const file = argvAll.filter(a => a !== '--expr' && a !== '--seed-theme' && a !== target && a !== valOf('--seed-theme'))[0]
    expr = file ? fs.readFileSync(file, 'utf8') : 'return { title: document.title }'
  }

  // --seed-theme dark|light：先在同一浏览器里种下主题偏好，再真实导航到目标页，
  // 用于验证"预热脚本能否在首帧前恢复用户选择"。必须用真实导航（而非新开标签），
  // 否则测不出预热时机。
  const seed = valOf('--seed-theme')

  const created = JSON.parse(await req('PUT', '/json/new?' + encodeURIComponent(target)))
  const ws = new WebSocket(created.webSocketDebuggerUrl, { perMessageDeflate: false })
  const pending = new Map()
  let id = 0
  const send = (method, params) => new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
  ws.on('message', raw => {
    let m
    try { m = JSON.parse(raw) } catch (e) { return }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
    }
  })
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })

  try {
    // 等页面真正就绪（Vue 挂载后才有我们要测的 DOM）
    for (let i = 0; i < 40; i++) {
      const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })
      if (r.result && r.result.value === 'complete') break
      await new Promise(res => setTimeout(res, 150))
    }
    await new Promise(res => setTimeout(res, 600))   // 给 Vue 一点挂载时间

    if (seed) {
      await send('Runtime.evaluate', {
        expression: `localStorage.setItem('pix-web-theme', ${JSON.stringify(seed)})`
      })
      await send('Page.enable')
      await send('Page.navigate', { url: target })
      // 等这次导航真正加载完
      await new Promise(resolve => {
        const onMsg = raw => {
          try {
            const m = JSON.parse(raw)
            if (m.method === 'Page.loadEventFired') { ws.off('message', onMsg); resolve() }
          } catch (e) {}
        }
        ws.on('message', onMsg)
        setTimeout(() => { ws.off('message', onMsg); resolve() }, 8000)
      })
      await new Promise(res => setTimeout(res, 800))
    }

    const res = await send('Runtime.evaluate', {
      expression: `(function(){ return (function(){ ${expr} })(); })()`,
      returnByValue: true,
      awaitPromise: true
    })
    if (res.exceptionDetails) {
      console.error('页面内异常:', JSON.stringify(res.exceptionDetails.exception || res.exceptionDetails, null, 2))
      process.exitCode = 1
    } else {
      const v = res.result && res.result.value
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
    }
  } finally {
    ws.close()
    await req('GET', '/json/close/' + created.id).catch(() => {})
  }
}

main().catch(e => { console.error('失败:', e.message); process.exit(1) })
