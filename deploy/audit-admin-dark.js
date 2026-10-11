#!/usr/bin/env node
/**
 * 后台夜间模式系统性审计。
 *
 * 为什么需要：之前是"用户截图指出哪就修哪"，属于打地鼠。
 * 这个脚本登录超管后台后逐个访问所有页面，在夜间模式下扫描
 * **背景仍然接近白色**的可见元素 —— 深色主题下大块亮底基本都是漏改的组件。
 *
 * 用法：node audit-admin-dark.js
 */
const http = require('http')
let WebSocket
try { WebSocket = require('ws') } catch (e) {
  WebSocket = require('/Users/lingjie/Desktop/皮克斯多开翻译软件/node_modules/ws')
}
const totpLib = require('/Users/lingjie/Desktop/皮克斯多开翻译软件/server/lib/totp')
const PORT = Number(process.env.CDP_PORT || 9333)
const HOST = process.env.ADMIN_HOST || 'lindufyht.com'
const USER = process.env.ADMIN_USER
const PASS = process.env.ADMIN_PASS

const PAGES = [
  ['总览', '/admin/dashboard'],
  ['商户管理', '/admin/users'],
  ['在线账号', '/admin/accounts'],
  ['进粉统计', '/admin/fans'],
  ['分流链接', '/admin/links'],
  ['话术回复', '/admin/scripts'],
  ['套餐管理', '/admin/packages'],
  ['充值流水', '/admin/recharges'],
  ['翻译计费', '/admin/translate'],
  ['翻译通道', '/admin/engines'],
  ['客户端版本', '/admin/clients'],
  ['公告管理', '/admin/notices'],
  ['帮助与客服', '/admin/support'],
  ['验证码接口', '/admin/verify'],
  ['系统设置', '/admin/settings'],
  ['登录与审计', '/admin/logs'],
  ['超管账号', '/admin/staff'],
  ['账号安全', '/admin/security']
]

const getJson = u => new Promise((r, j) => http.get(u, s => {
  let b = ''; s.on('data', c => b += c); s.on('end', () => { try { r(JSON.parse(b)) } catch (e) { j(e) } })
}).on('error', j))

/** 在页面里执行：找出夜间模式下背景仍然很亮的可见元素 */
const SCAN = `
(function () {
  const lum = (r, g, b) => {
    const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const parse = s => { const m = String(s).match(/rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)(?:[,\\s/]+([\\d.]+))?/); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null }
  const out = new Map()
  document.querySelectorAll('body *').forEach(el => {
    const c = getComputedStyle(el)
    if (c.display === 'none' || c.visibility === 'hidden' || +c.opacity === 0) return
    const r = el.getBoundingClientRect()
    if (r.width < 24 || r.height < 16) return            // 太小的忽略（图标、圆点）
    const bg = parse(c.backgroundColor)
    if (!bg || bg[3] < 0.5) return                        // 透明的交给祖先
    if (lum(bg[0], bg[1], bg[2]) < 0.55) return           // 够暗就正常
    const key = el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ').filter(Boolean).slice(0, 3).join('.')
    if (!out.has(key)) {
      out.set(key, {
        元素: key,
        背景: c.backgroundColor,
        尺寸: Math.round(r.width) + 'x' + Math.round(r.height),
        文字色: c.color,
        文字示例: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 26)
      })
    }
  })
  return JSON.stringify(Array.from(out.values()))
})()
`

;(async () => {
  if (!USER || !PASS) { console.error('需要 ADMIN_USER / ADMIN_PASS'); process.exit(1) }
  const targets = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).filter(t => t.type === 'page')
  const t = targets[targets.length - 1]
  const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false })
  const pending = new Map(); let id = 0
  const send = (m, p) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw) } catch (e) { return }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  await send('Page.enable'); await send('Runtime.enable')

  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text)
    return r.result && r.result.value
  }
  const wait = ms => new Promise(r => setTimeout(r, ms))

  // ---- 登录 ----
  await send('Page.navigate', { url: `https://${HOST}/` })
  await wait(12000)
  const logged = await evaluate(`(function(){
    const inputs = document.querySelectorAll('.admin-login input');
    if (!inputs.length) return document.querySelector('.admin-header') ? 'already' : 'no-form';
    const img = document.querySelector('.admin-login .captcha');
    const code = img ? [...atob(img.src.split(',')[1]).matchAll(/<text[^>]*>([^<]+)<\\/text>/g)].map(m=>m[1]).join('') : '';
    const setVal = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      s.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})) };
    setVal(inputs[0], ${JSON.stringify(USER)});
    setVal(inputs[1], ${JSON.stringify(PASS)});
    if (inputs[2]) setVal(inputs[2], code);
    const btn = Array.from(document.querySelectorAll('.admin-login button')).find(b => /登录/.test(b.innerText));
    if (btn) btn.click();
    return 'submitted';
  })()`)
  await wait(6000)

  // 若管理员开了两步验证：第一步后页面会停在动态码输入，用密钥生成验证码补上。
  // 密钥来自数据库 —— 这也说明**有库权限的人可以绕过 2FA**，是 TOTP 的固有特性。
  if (process.env.TOTP_SECRET) {
    const needTotp = await evaluate(`!!document.querySelector('.admin-login input[maxlength="11"]')`)
    if (needTotp) {
      const code = totpLib.totp(process.env.TOTP_SECRET)
      await evaluate(`(function(){
        const el = document.querySelector('.admin-login input[maxlength="11"]');
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
        s.call(el, ${JSON.stringify('CODE_PLACEHOLDER')});
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
        const btn = Array.from(document.querySelectorAll('.admin-login button')).find(b => /验证并登录/.test(b.innerText));
        if (btn) btn.click();
        return 'totp-submitted';
      })()`.replace('CODE_PLACEHOLDER', code))
      await wait(6000)
    }
  }

  const after = await evaluate(`document.querySelector('.admin-header') ? 'ok' : 'fail'`)
  console.log(`登录：${logged} → ${after}`)
  if (after !== 'ok') { console.log('登录失败，终止'); ws.close(); process.exit(1) }

  // ---- 切夜间 ----
  await evaluate(`localStorage.setItem('pix-web-theme','dark');
    document.documentElement.setAttribute('data-theme','dark');
    document.dispatchEvent(new CustomEvent('pix-theme-change', { detail: { dark: true } }));
    'dark'`)
  await wait(1200)

  // ---- 逐页扫描 ----
  const all = new Map()
  for (const [name, path] of PAGES) {
    await evaluate(`location.hash = '#${path}'; 'go'`)
    await wait(3200)
    // 必须补发事件：后台侧栏菜单的配色是 JS 状态（AdminLayout 监听 pix-theme-change），
    // 只改 <html> 属性不会更新它，会造成误报（实测踩过）。
    await evaluate(`document.documentElement.setAttribute('data-theme','dark');
      document.dispatchEvent(new CustomEvent('pix-theme-change', { detail: { dark: true } }));
      void document.body.offsetHeight; 'dark'`)
    await wait(400)
    let rows = []
    try { rows = JSON.parse(await evaluate(SCAN)) } catch (e) { rows = [] }
    const real = rows.filter(r => r.文字示例 || /el-/.test(r.元素))
    if (real.length) {
      console.log(`\n【${name}】${path}  —  ${real.length} 处亮块`)
      real.forEach(r => console.log(`   ${r.背景.padEnd(22)} ${r.尺寸.padEnd(11)} ${r.元素.slice(0, 52)}  「${r.文字示例}」`))
      real.forEach(r => { if (!all.has(r.元素)) all.set(r.元素, { ...r, 页面: name }) })
    } else {
      console.log(`\n【${name}】${path}  ✓ 无亮块`)
    }
  }

  console.log('\n================ 汇总（按元素去重）================')
  if (!all.size) console.log('  ✓ 后台夜间模式没有发现未跟随主题的亮块')
  else Array.from(all.values()).forEach(r => console.log(`  ${r.元素.slice(0, 60)}\n      背景 ${r.背景}  尺寸 ${r.尺寸}  首次出现于「${r.页面}」`))
  ws.close()
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
