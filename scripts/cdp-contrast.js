#!/usr/bin/env node
/**
 * 真实像素对比度审计 —— 找出"看不清"的文字。
 *
 * 为什么不用推算：本次已出现过两次「深色写死背景 + 日间近黑文字」的组合，
 * 靠读 CSS 判断很容易漏（渐变、叠加、backdrop-filter 都算不准）。
 * 这里直接截真实屏幕，再解码像素：
 *   背景色 = 文字元素外框内出现次数最多的颜色
 *            （外框内背景像素远多于字形像素，取众数即背景）
 *   对比度 = WCAG 相对亮度公式，文字色 vs 背景色
 *
 * 用法：
 *   CDP_PORT=9226 node scripts/cdp-contrast.js            # 默认阈值 4.5
 *   CDP_PORT=9226 node scripts/cdp-contrast.js --min 3    # 只看严重问题
 *   CDP_PORT=9226 node scripts/cdp-contrast.js --save /tmp/shot.png
 */
const fs = require('fs')
const http = require('http')
const path = require('path')
const zlib = require('zlib')
let WebSocket
try { WebSocket = require('ws') } catch (e) { WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws')) }

const PORT = Number(process.env.CDP_PORT || 9225)
const argv = process.argv.slice(2)
const MIN = Number((argv.includes('--min') ? argv[argv.indexOf('--min') + 1] : 0) || 4.5)
const SAVE = argv.includes('--save') ? argv[argv.indexOf('--save') + 1] : null

/* ---------- 最小 PNG 解码（8bit / 非隔行，Chrome 截图就是这个格式）---------- */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.slice(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]; interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8) throw new Error('只支持 8bit，实际 ' + bitDepth)
  if (interlace !== 0) throw new Error('不支持隔行 PNG')
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : -1
  if (channels < 0) throw new Error('不支持 colorType ' + colorType)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const out = Buffer.alloc(stride * h)
  let prev = Buffer.alloc(stride)
  let pos = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++]
    const line = raw.slice(pos, pos + stride); pos += stride
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[x] = v & 0xff
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  return { w, h, channels, data: out }
}

/* ---------- WCAG 相对亮度与对比度 ---------- */
function lum(r, g, b) {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function contrast(a, b) {
  const l1 = lum(a[0], a[1], a[2]), l2 = lum(b[0], b[1], b[2])
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}
function parseColor(s) {
  const m = String(s).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/)
  return m ? [+m[1], +m[2], +m[3]] : null
}

const getJson = url => new Promise((res, rej) => {
  http.get(url, r => { let b = ''; r.on('data', c => (b += c)); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej)
})

const COLLECT = `
const vis = el => {
  const c = getComputedStyle(el);
  if (c.display === 'none' || c.visibility === 'hidden' || +c.opacity === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width >= 8 && r.height >= 8 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
};
const out = [];
document.querySelectorAll('*').forEach((el, i) => {
  // 只看"直接含文字"的元素
  const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('').trim();
  if (!own) return;
  if (!vis(el)) return;
  const r = el.getBoundingClientRect();
  const c = getComputedStyle(el);
  out.push({
    i, tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 40),
    txt: own.slice(0, 26), color: c.color, fs: parseFloat(c.fontSize), fw: c.fontWeight,
    x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)
  });
});
return out;
`

;(async () => {
  const targets = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).filter(t => t.type === 'page')
  const target = targets.find(t => t.url.startsWith('file://')) || targets[0]
  if (!target) { console.error('没有可用 page target'); process.exit(1) }
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
  const pending = new Map(); let id = 0
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
  ws.on('message', raw => { let m; try { m = JSON.parse(raw) } catch (e) { return }
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  await send('Page.enable')
  await send('Runtime.enable')
  // 关键：先把窗口提到前台。被遮挡/最小化的窗口不产新帧，
  // captureScreenshot 会一直等下去（表现为挂死，而不是报错）。
  await send('Page.bringToFront').catch(() => {})
  await new Promise(r => setTimeout(r, 400))

  const ev = await send('Runtime.evaluate', { expression: `(function(){ ${COLLECT} })()`, returnByValue: true })
  const els = ev.result.value || []
  const dpr = (await send('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true })).result.value || 1
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const png = Buffer.from(shot.data, 'base64')
  if (SAVE) { fs.writeFileSync(SAVE, png); console.log('截图已存 ' + SAVE) }
  const img = decodePng(png)
  const scale = img.w / (await send('Runtime.evaluate', { expression: 'innerWidth', returnByValue: true })).result.value

  const results = []
  for (const el of els) {
    const fg = parseColor(el.color)
    if (!fg) continue
    if (fg[3] !== undefined && fg[3] === 0) continue
    // 取元素框内像素众数当背景
    const x0 = Math.max(0, Math.round(el.x * scale)), x1 = Math.min(img.w, Math.round((el.x + el.w) * scale))
    const y0 = Math.max(0, Math.round(el.y * scale)), y1 = Math.min(img.h, Math.round((el.y + el.h) * scale))
    if (x1 - x0 < 2 || y1 - y0 < 2) continue
    const counts = new Map()
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * img.w + x) * img.channels
        const a = img.channels === 4 ? img.data[o + 3] : 255
        if (a < 200) continue
        // 量化到 8 级，避免抗锯齿噪声把众数打散
        const key = ((img.data[o] >> 3) << 10) | ((img.data[o + 1] >> 3) << 5) | (img.data[o + 2] >> 3)
        counts.set(key, (counts.get(key) || 0) + 1)
      }
    }
    if (!counts.size) continue
    let bestKey = 0, bestN = -1
    for (const [k, n] of counts) if (n > bestN) { bestN = n; bestKey = k }
    const bg = [((bestKey >> 10) & 31) << 3 | 4, ((bestKey >> 5) & 31) << 3 | 4, (bestKey & 31) << 3 | 4]
    const ratio = contrast(fg, bg)
    results.push({ ...el, fg, bg, ratio: +ratio.toFixed(2), bgShare: +(bestN / (counts.size ? [...counts.values()].reduce((a, b) => a + b, 0) : 1)).toFixed(2) })
  }

  results.sort((a, b) => a.ratio - b.ratio)
  const bad = results.filter(r => r.ratio < MIN)
  console.log(`\n检查 ${results.length} 个含文字元素，对比度 < ${MIN} 的有 ${bad.length} 个：\n`)
  for (const r of bad.slice(0, 25)) {
    const big = r.fs >= 18.66 || (r.fs >= 14 && +r.fw >= 700)
    console.log(`  ${String(r.ratio).padStart(5)}:1  ${big ? '大字' : '    '} ${r.tag}.${r.cls}`)
    console.log(`          "${r.txt}"  ${r.fs}px/${r.fw}  文字 rgb(${r.fg.join(',')})  背景 rgb(${r.bg.join(',')})  背景占比 ${r.bgShare}`)
  }
  if (!bad.length) console.log('  ✓ 没有低于阈值的文字')
  ws.close()
})().catch(e => { console.error('审计失败:', e.message); process.exit(1) })
