#!/usr/bin/env node
/**
 * CDP 实测探针 —— 连到客户端调试端口，在真实 DOM 上求值。
 *
 * 为什么需要它：桌面端布局受原生视图（BrowserView）与 CSS 双重影响，
 * 靠读 CSS 推算尺寸不可靠；这里直接量真实渲染结果。
 *
 * 用法：
 *   node scripts/cdp-probe.js <file.js>        # 执行脚本文件里的表达式
 *   node scripts/cdp-probe.js --expr '<js>'    # 直接传表达式
 *   echo '<js>' | node scripts/cdp-probe.js    # 从 stdin 读
 *   node scripts/cdp-probe.js --list           # 只列 targets
 *
 * 表达式里可用：
 *   $  / $$      document.querySelector / querySelectorAll（返回数组）
 *   rect(el)     el.getBoundingClientRect() 的普通对象
 *   box(sel)     选择器 → 尺寸/位置摘要
 *   cs(el,prop)  getComputedStyle 取值
 *   info(el)     {sel, rect, fontSize, ...} 一次性摘要
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
let WebSocket
try { WebSocket = require('ws') } catch (e) { WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws')) }

const PORT = Number(process.env.CDP_PORT || 9225)
const MATCH = process.env.CDP_MATCH || ''   // 只选 url/title 含该子串的 target

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = ''
      res.on('data', c => (body += c))
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

const PRELUDE = `
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const rect = el => { if (!el) return null; const r = el.getBoundingClientRect();
  return { x:+r.x.toFixed(2), y:+r.y.toFixed(2), w:+r.width.toFixed(2), h:+r.height.toFixed(2),
           top:+r.top.toFixed(2), right:+r.right.toFixed(2), bottom:+r.bottom.toFixed(2), left:+r.left.toFixed(2) }; };
const cs = (el, p) => el ? getComputedStyle(el).getPropertyValue(p) : null;
const box = sel => { const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) return { sel: String(sel), missing: true }; const c = getComputedStyle(el);
  return { sel: String(sel), rect: rect(el),
    display: c.display, fontSize: c.fontSize, lineHeight: c.lineHeight, fontWeight: c.fontWeight,
    color: c.color, padding: c.padding, margin: c.margin, width: c.width, height: c.height,
    minHeight: c.minHeight, gridTemplateColumns: c.gridTemplateColumns, gap: c.gap, overflow: c.overflow }; };
const info = el => { if (!el) return null; const c = getComputedStyle(el);
  return { tag: el.tagName.toLowerCase(), cls: el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className,
    text: (el.textContent || '').trim().slice(0, 40), rect: rect(el), fontSize: c.fontSize, lineHeight: c.lineHeight,
    fontWeight: c.fontWeight, color: c.color, padding: c.padding, margin: c.margin, width: c.width, height: c.height,
    minHeight: c.minHeight, display: c.display, boxSizing: c.boxSizing }; };
`

async function main() {
  const argv = process.argv.slice(2)
  const targets = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).filter(t => t.type === 'page')
  if (argv.includes('--list') || !targets.length) {
    targets.forEach(t => console.log([t.type, t.title, t.url].join(' | ')))
    if (!targets.length) process.exit(1)
    return
  }
  // 默认选应用自己的页面（非 web.telegram.org 的 file:// 页面）
  let target = targets.find(t => MATCH && (t.url.includes(MATCH) || (t.title || '').includes(MATCH)))
  if (!target) target = targets.find(t => t.url.startsWith('file://') && (t.title || '').includes('Hello Pix'))
  if (!target) target = targets.find(t => t.url.startsWith('file://'))
  if (!target) target = targets[0]

  let expr
  if (argv[0] === '--expr') expr = argv[1]
  else if (argv[0] && argv[0] !== '-') expr = fs.readFileSync(argv[0], 'utf8')
  else expr = fs.readFileSync(0, 'utf8')

  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
  const pending = new Map()
  let id = 0
  const send = (method, params) => new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })

  ws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw) } catch (e) { return }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  })

  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })

  try {
    const res = await send('Runtime.evaluate', {
      expression: `(function(){ ${PRELUDE}\n return (function(){ ${expr} })(); })()`,
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
  }
}

main().catch(err => { console.error('探针失败:', err.message); process.exit(1) })
