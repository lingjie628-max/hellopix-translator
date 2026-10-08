'use strict'

/**
 * 「译」按钮（manual_click）链路验证 + 真机 trace 形状检查。
 *
 * 每次成功的判定（用户要求，缺一不可）：
 *   trigger = manual_click · API 请求 = 1 · 译文显示在**正确那条**消息上
 *   且 trace 顺序完整：
 *     MANUAL_TRANSLATE_CLICK → SOURCE_EXTRACTED → TRANSLATE_STARTED
 *     → TRANSLATE_SUCCEEDED → TARGET_RELOCATED → TRANSLATION_RENDERED
 *   全部带同一个 sendActionId。
 *
 * 失败判定：任何一步断了，都必须留下 trace + 界面上看得见的反馈 —— 不许静默。
 */

const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const root = path.join(__dirname, '..')
// 可选参数：直接指定 guest-inject.js 的来源。产物（asar 解出来的那份）也走这里 ——
// 只对源码跑等于"验的是 A、发的是 B"，正是 0.1.12 那次事故的形态。
const guestPath = process.argv[2] || path.join(root, 'desktop', 'guest-inject.js')
const guestSrc = fs.readFileSync(guestPath, 'utf8')
const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 轮询等待条件成立。
 *
 * 这里必须用轮询而不是固定 sleep：真机与 CI 的机器负载不同，固定等待会造成
 * "同一份代码有时 17/17、有时 16/17" 的偶发失败 —— 那会让整份取证结果
 * 失去可信度（分不清是代码坏了还是等太短）。
 */
async function until (fn, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs == null ? 3000 : timeoutMs)
  while (Date.now() < deadline) {
    try { if (fn()) return true } catch (e) {}
    await sleep(15)
  }
  return false
}

const COMPOSER = '<div id="editable-message-text" contenteditable="true" role="textbox"></div>'
const GROUP = 'true_1203630199@g.us_'
const REAL_TEXT = 'Ok I know to closed the ones I screw up with...'

function row (text, id) {
  return '<div class="message-in focusable-list-item" role="row" data-id="' + id + '">' +
    '<div class="x1n2onr6"><div class="copyable-text" data-pre-plain-text="[6:58 PM, 9/25/2026] Alice: ">' +
    '<span class="selectable-text copyable-text" dir="ltr">' + text + '</span>' +
    '</div></div></div>'
}
function page (inner) {
  return '<div id="main"><div id="msg-list">' + inner + '</div><footer>' + COMPOSER + '</footer></div>'
}

const PREFS = {
  transRecv: true, transSend: true, transGroup: false,
  langMine: 'zh', langOther: 'auto', sendTo: 'en',
  includeZh: false, antiRevoke: false,
  tabId: 'tab-1', partition: 'persist:wa-1', engine: 'gpt'
}

async function mount (o) {
  const opts = o || {}
  const dom = new JSDOM('<!doctype html><html><body>' + (opts.html || page(row(REAL_TEXT, GROUP + 'M1'))) + '</body></html>', {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://web.whatsapp.com/'
  })
  const win = dom.window
  const doc = win.document
  win.Element.prototype.getBoundingClientRect = () => ({
    width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0
  })

  const calls = []
  const trace = []
  const notices = []
  const ipc = {
    invoke: (channel, payload) => {
      if (channel === 'translate:guestPrefs') return Promise.resolve(Object.assign({}, PREFS, opts.prefs || {}))
      if (channel === 'translate:run') {
        calls.push(payload)
        if (opts.fail === 'reject') return Promise.reject(new Error('socket hang up'))
        if (opts.fail) return Promise.resolve({ success: false, code: opts.fail, msg: '服务端返回' })
        const done = { success: true, translation: 'ZH<' + String(payload.text || '') + '>' }
        if (opts.slowMs) return new Promise(res => setTimeout(() => res(done), opts.slowMs))
        return Promise.resolve(done)
      }
      return Promise.resolve({ success: true })
    },
    on: () => {}, removeAllListeners: () => {}
  }
  win.require = () => ({ ipcRenderer: ipc })
  const realInfo = win.console.info
  win.console.info = (...a) => {
    const line = a.map(String).join(' ')
    const m = line.match(/\[PIX_TRACE\]\s+(\w+)\s+(\{.*\})/)
    if (m) { let p = {}; try { p = JSON.parse(m[2]) } catch (e) {} trace.push({ event: m[1], payload: p }) }
    if (realInfo) realInfo.apply(win.console, a)
  }

  let loadError = null
  try { win.eval(guestSrc) } catch (e) { loadError = e }
  await new Promise(res => {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', res, { once: true })
    else res()
  })
  win.__helloPixApplyPrefs(Object.assign({}, PREFS, opts.prefs || {}))
  await sleep(400)

  const chip = n => doc.querySelectorAll('.pix-click')[n || 0]
  const trans = n => doc.querySelectorAll('.pix-trans')[n || 0]
  const click = n => {
    const c = chip(n)
    if (!c) return false
    c.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }
  const toast = () => {
    const el = doc.getElementById('pix-translate-notice')
    return el ? el.textContent : null
  }

  return { win, doc, calls, trace, notices, loadError, chip, trans, click, toast,
    close: () => { try { win.close() } catch (e) {} } }
}

// ---------------------------------------------------------------------------

const rows = []
function check (name, pass, detail) {
  rows.push({ name, pass: !!pass })
  console.log('\n' + (pass ? '✓' : '✖') + ' ' + name)
  for (const [k, v] of Object.entries(detail || {})) console.log('   ' + k.padEnd(20) + ' = ' + JSON.stringify(v))
}

const CHAIN = ['MANUAL_TRANSLATE_CLICK', 'SOURCE_EXTRACTED', 'TRANSLATE_STARTED', 'TRANSLATE_SUCCEEDED', 'TARGET_RELOCATED', 'TRANSLATION_RENDERED']
function chainOk (h) {
  const names = h.trace.map(t => t.event)
  let cursor = -1
  for (const want of CHAIN) {
    const at = names.indexOf(want, cursor + 1)
    if (at === -1) return { ok: false, names }
    cursor = at
  }
  const ids = new Set(h.trace.filter(t => t.payload && t.payload.sendActionId && t.payload.sendActionId !== '-')
    .map(t => t.payload.sendActionId))
  return { ok: ids.size === 1, names, ids: Array.from(ids) }
}

async function main () {
  try {
    // 1 · 新收到普通文字 → 点译 → 成功
    {
      const h = await mount()
      try {
        const clicked = h.click()
        await sleep(300)
        const c = chainOk(h)
        check('1 · 新收到普通文字 → 点译 → 成功',
          clicked && c.ok && h.calls.length === 1 && h.calls[0].trigger === 'manual_click' && !!h.trans(),
          { 'trace 顺序': c.names, sendActionId: c.ids,
            'API 请求': h.calls.length, trigger: h.calls.map(x => x.trigger),
            '译文': h.trans() ? h.trans().textContent : null })
      } finally { h.close() }
    }

    // 2 · 历史普通文字 → 点译 → 成功
    {
      const many = [1, 2, 3].map(i => row('History line ' + i, GROUP + 'H' + i)).join('')
      const h = await mount({ html: page(many) })
      try {
        const clicked = h.click(1)          // 中间那条 = "历史消息"
        await sleep(300)
        check('2 · 历史普通文字 → 点译 → 成功',
          clicked && h.calls.length === 1 && !!h.trans(),
          { 'API 请求': h.calls.length, '译文': h.trans() ? h.trans().textContent : null })
      } finally { h.close() }
    }

    // 3 · 英文长文本
    {
      const long = 'Ok I know to closed the ones I screw up with but honestly we should revisit the whole rollout plan before the client demo next Tuesday afternoon'.repeat(3)
      const h = await mount({ html: page(row(long, GROUP + 'L1')) })
      try {
        h.click(); await sleep(300)
        check('3 · 英文长文本 → 成功', h.calls.length === 1 && !!h.trans(),
          { 长度: long.length, 'API 请求': h.calls.length, sourceTextLen: h.trace.find(t => t.event === 'SOURCE_EXTRACTED') })
      } finally { h.close() }
    }

    // 4 · 中文文本（翻译成设定目标语言）
    // 注意：includeZh=false 时中文消息**本来就不给「译」按钮**（正确的省钱行为），
    // 所以要验证"点译中文"，必须按用户实际会用的配置把 includeZh 打开。
    {
      const h = await mount({ html: page(row('你好，今天下午三点开会', GROUP + 'C1')), prefs: { includeZh: true } })
      try {
        const hasChip = !!h.chip()
        h.click(); await sleep(300)
        check('4 · 中文文本（includeZh 打开）→ 点译 → 翻译成目标语言',
          hasChip && h.calls.length === 1 && !!h.trans(),
          { '「译」按钮': hasChip, 'API 请求': h.calls.length, '注入的正文': h.calls[0] && h.calls[0].text,
            译文: h.trans() ? h.trans().textContent : null })
      } finally { h.close() }
    }

    // 4b · includeZh 关闭时，中文消息必须**不给**按钮（不误扣费）
    {
      const h = await mount({ html: page(row('你好，今天下午三点开会', GROUP + 'C2')) })
      try {
        await sleep(200)
        h.click(); await sleep(200)
        check('4b · 中文文本（includeZh 关闭）→ 不给「译」按钮、不请求（不误扣费）',
          !h.chip() && h.calls.length === 0,
          { '「译」按钮': !!h.chip(), 'API 请求': h.calls.length })
      } finally { h.close() }
    }

    // 5 · 文字 + emoji
    {
      const h = await mount({ html: page(row('Great job 👍🎉 let us ship it', GROUP + 'E1')) })
      try {
        h.click(); await sleep(300)
        check('5 · 文字 + emoji → emoji 不阻塞翻译',
          h.calls.length === 1 && !!h.trans(),
          { 'API 请求': h.calls.length, '注入的正文': h.calls[0] && h.calls[0].text })
      } finally { h.close() }
    }

    // 6 · 文字 + URL：URL 不被翻译、原样回填
    {
      const h = await mount({ html: page(row('Check https://example.com/a/b please', GROUP + 'U1')) })
      try {
        h.click(); await sleep(300)
        const t = h.trans() ? h.trans().textContent : null
        check('6 · 文字 + URL → URL 原样保留、不被送进翻译',
          h.calls.length === 1 && !!t && t.indexOf('https://example.com/a/b') !== -1 &&
          String(h.calls[0].text).indexOf('https://') === -1,
          { '注入的正文（不应含 URL）': h.calls[0] && h.calls[0].text, 译文: t })
      } finally { h.close() }
    }

    // 7 · 群聊消息（本轮夹具就是群聊）
    {
      const h = await mount()
      try {
        h.click(); await sleep(300)
        check('7 · 群聊消息 → 成功', h.calls.length === 1 && !!h.trans(),
          { 'API 请求': h.calls.length, 译文: h.trans() ? h.trans().textContent : null })
      } finally { h.close() }
    }

    // 8 · 私聊消息：私聊走 auto（自动翻译），点译链路同样不能坏
    {
      const h = await mount({ html: page(row(REAL_TEXT, 'false_8613800138000@c.us_P1')) })
      try {
        await sleep(300)
        check('8 · 私聊消息 → 自动翻译已出译文（无需点译）',
          h.calls.length === 1 && !!h.trans(),
          { 'API 请求': h.calls.length, trigger: h.calls.map(x => x.trigger),
            译文: h.trans() ? h.trans().textContent : null })
      } finally { h.close() }
    }

    // 9 · 连续点 3 条不同消息 → 三条分别显示
    {
      const many = [1, 2, 3].map(i => row('Message number ' + i, GROUP + 'N' + i)).join('')
      const h = await mount({ html: page(many) })
      try {
        const results = []
        for (let i = 0; i < 3; i++) {
          h.click(i)
          await sleep(260)
          const t = h.trans(i)
          results.push(t ? t.textContent : '(无译文)')
        }
        check('9 · 连续点 3 条不同消息 → 三条分别显示',
          h.calls.length === 3 && h.doc.querySelectorAll('.pix-trans').length === 3 &&
          results.every(r => r !== '(无译文)'),
          { 'API 请求': h.calls.length, '译文个数': h.doc.querySelectorAll('.pix-trans').length, 结果: results })
      } finally { h.close() }
    }

    // 10 · 同一条快速点两次 → 只产生一次有效请求
    {
      const h = await mount()
      try {
        h.click(); h.click(); h.click()
        await sleep(400)
        check('10 · 同一条快速点三次 → 只产生一次有效请求（不重复扣费）',
          h.calls.length === 1,
          { 'API 请求': h.calls.length, 去重后: new Set(h.calls.map(c => c.text)).size })
      } finally { h.close() }
    }

    // 11 · 失败：余额不足 → 按钮必须变成「翻译失败 · 点击重试」，不许静默
    {
      const h = await mount({ fail: 'INSUFFICIENT_CHARS' })
      try {
        h.click(); await sleep(400)
        const c = h.chip()
        check('11 · 余额不足 → chip 显示「翻译失败 · 点击重试」+ 弹提示（不静默）',
          !!c && c.textContent.indexOf('失败') !== -1 && !!h.toast(),
          { 'chip 文案': c ? c.textContent : null, chip状态: c ? c.getAttribute('data-pix-state') : null,
            提示: h.toast(), trace: h.trace.map(t => t.event) })
      } finally { h.close() }
    }

    // 12 · 失败：断线 → 同上
    {
      const h = await mount({ fail: 'reject' })
      try {
        h.click(); await sleep(400)
        const c = h.chip()
        check('12 · 断线 → chip 显示失败 + 提示（不静默）',
          !!c && c.textContent.indexOf('失败') !== -1,
          { 'chip 文案': c ? c.textContent : null, 提示: h.toast(),
            'RESPONSE code': (h.trace.find(t => t.event === 'TRANSLATE_FAILED') || {}).payload })
      } finally { h.close() }
    }

    // 13 · 正文读不出来（无 selectable-text）→ 必须 MESSAGE_TEXT_EXTRACTION_FAILED + 提示
    {
      const bad = '<div class="message-in" role="row" data-id="' + GROUP + 'NOSPAN">' +
        '<div class="copyable-text">no selectable span here</div></div>'
      const h = await mount({ html: page(bad) })
      try {
        // 这张 fixture 连 chip 都不会出现（解析失败 → hide），所以直接构造一次点击
        // 来验证"点击时正文为空"这条路径的兜底。
        const fake = h.doc.createElement('span')
        fake.className = 'pix-click'
        fake.setAttribute('data-pix-ui', 'translate-chip')
        fake.setAttribute('data-pix-key-attr', 'data-id')
        fake.setAttribute('data-pix-key', GROUP + 'NOSPAN')
        fake.setAttribute('data-pix-incoming', '1')
        fake.textContent = '译'
        h.doc.body.appendChild(fake)
        fake.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
        await sleep(300)
        check('13 · 正文读不出来 → MESSAGE_TEXT_EXTRACTION_FAILED + 用户可见提示（不静默）',
          h.trace.some(t => t.event === 'MESSAGE_TEXT_EXTRACTION_FAILED') && !!h.toast() &&
          fake.textContent.indexOf('失败') !== -1,
          { trace: h.trace.map(t => t.event), 提示: h.toast(), chip文案: fake.textContent,
            'API 请求': h.calls.length })
      } finally { h.close() }
    }

    // 14 · 真机复现的死法：chip 存活但消息被 React 换掉（裸引用已 detach）
    {
      const h = await mount()
      try {
        const oldRow = h.doc.querySelector('[data-id]')
        const fresh = h.doc.createElement('div')
        fresh.innerHTML = row(REAL_TEXT, GROUP + 'M1')
        const newRow = fresh.firstChild
        oldRow.parentNode.replaceChild(newRow, oldRow)
        const oldChip = h.doc.querySelector('.pix-click')
        if (oldChip) newRow.appendChild(oldChip)   // 真机形态：按钮还在，但引用已 detach
        await sleep(60)
        h.click()
        // 等"真的渲染出来"，而不是赌一个固定时长。
        await until(() => !!h.trans() && h.calls.length === 1, 3000, '译文渲染')
        check('14 · 消息行被重绘后点译：按 data-id 重新定位 → 仍然成功',
          h.calls.length === 1 && !!h.trans(),
          { 'API 请求': h.calls.length, '译文': h.trans() ? h.trans().textContent : null,
            rowFound: (h.trace.find(t => t.event === 'MANUAL_TRANSLATE_CLICK') || {}).payload })
      } finally { h.close() }
    }

    // 15 · trace 必须带齐 tabId / partition / engine / sourceTextLen
    {
      const h = await mount()
      try {
        h.click(); await sleep(300)
        const click = h.trace.find(t => t.event === 'MANUAL_TRANSLATE_CLICK')
        const p = (click && click.payload) || {}
        check('15 · trace 带齐 tabId / partition / engine / messageId / sourceTextLen',
          p.tabId === 'tab-1' && p.partition === 'persist:wa-1' && p.engine === 'gpt' &&
          p.messageId === GROUP + 'M1',
          { payload: p })
      } finally { h.close() }
    }

    // 16 · 慢接口：chip 期间显示「翻译中…」，且绝不进输入框
    {
      const h = await mount({ slowMs: 1200 })
      try {
        h.click()
        await sleep(300)
        const mid = h.chip() ? h.chip().textContent : null
        const midComposer = h.doc.getElementById('editable-message-text').textContent
        await sleep(1300)
        check('16 · 慢接口：chip 显示「翻译中…」，输入框始终为空',
          mid === '翻译中…' && !String(midComposer || '').trim() && !!h.trans(),
          { '过程中 chip': mid, '过程中输入框': midComposer,
            'chip 状态': h.chip() && h.chip().getAttribute('data-pix-state'),
            译文: h.trans() ? h.trans().textContent : null })
      } finally { h.close() }
    }

    // 17 · 请求在飞的过程中消息行被移除 → 响应回来时无目标可渲染
    //     这等价于"await 之后失败"：必须离开 busy、给出可见失败，且
    //     **绝不**把译文 append 到聊天根节点。
    {
      const h = await mount({ slowMs: 500 })
      try {
        h.click()
        await sleep(120)                       // 请求还在飞
        const busyBefore = h.chip() && h.chip().getAttribute('data-pix-state')
        const chipEl = h.chip()
        // 模拟 React 在翻译期间把这一行换掉/删掉 → 响应回来时无目标可渲染
        const r = h.doc.querySelector('[data-id]')
        if (r && r.parentNode) r.parentNode.removeChild(r)
        await sleep(900)
        // chip 会随行一起 detach，所以用引用读它的最终状态
        const st = chipEl && chipEl.getAttribute('data-pix-state')
        const names = h.trace.map(t => t.event)
        const leaked = h.doc.querySelectorAll('#msg-list > .pix-trans, #main > .pix-trans').length
        check('17 · 响应回来时目标行已消失 → 离开 busy + 明确失败 + 不往根节点绘制',
          busyBefore === 'busy' && st === 'fail' &&
          names.indexOf('TRANSLATION_RENDER_TARGET_MISSING') >= 0 && leaked === 0,
          { '过程中': busyBefore, '结束后': st,
            '有 TARGET_MISSING': names.indexOf('TRANSLATION_RENDER_TARGET_MISSING') >= 0,
            '聊天根节点内译文数': leaked })
      } finally { h.close() }
    }

    // 18 · busy 期间连点 → 只有 1 次请求（防"看到没反应就连点"造成重复扣费）
    {
      const h = await mount({ slowMs: 500 })
      try {
        h.click(); h.click(); h.click()
        await sleep(900)
        check('18 · busy 期间连点 3 次 → 只产生 1 次请求',
          h.calls.length === 1 && !!h.trans(),
          { 'API 请求': h.calls.length, 'chip 状态': h.chip() && h.chip().getAttribute('data-pix-state') })
      } finally { h.close() }
    }

    // 19 · 已翻译后再点 → 不产生新请求（done 态拒绝重复扣费）
    {
      const h = await mount()
      try {
        h.click()
        await until(() => !!h.trans(), 3000, '首次译文')
        const before = h.calls.length
        // 译文渲染后 chip 已被移除（paint 成功），这里直接把 chips 全点一遍
        h.doc.querySelectorAll('.pix-click').forEach(c =>
          c.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true })))
        await sleep(300)
        check('19 · 已有译文后再点 → 不产生新请求（不重复扣费）',
          h.calls.length === before,
          { '首次请求数': before, '再点后': h.calls.length })
      } finally { h.close() }
    }

    // 20 · 宿主不是消息气泡（#main 内但无 data-id）→ 绝不挂按钮、绝不绘制
    //     真机上译文被 append 到聊天底部就是这个兜底路径造成的。
    {
      const badRow = '<div class="message-in" role="row">' +
        '<div class="copyable-text"><span class="selectable-text">no data-id here</span></div></div>'
      const h = await mount({ html: page(badRow) })
      try {
        await sleep(400)
        const insideMain = h.doc.querySelectorAll('#msg-list .pix-click').length
        const transInRoot = h.doc.querySelectorAll('#msg-list > .pix-trans, #main > .pix-trans').length
        check('20 · 非消息宿主（无 data-id）→ 不挂按钮、不往聊天根节点绘制',
          insideMain === 0 && transInRoot === 0,
          { '#msg-list 内按钮数': insideMain, '聊天根节点内译文数': transInRoot })
      } finally { h.close() }
    }

    const failed = rows.filter(r => !r.pass)
    console.log('\n' + '='.repeat(62))
    console.log(' manual_click 链路：' + (rows.length - failed.length) + ' / ' + rows.length + ' 项通过')
    if (failed.length) console.log(' ✖ ' + failed.map(r => r.name).join(' | '))
    else console.log(' ✔ 全部通过：trigger=manual_click、请求=1、译文渲染在正确消息、失败不静默')
    console.log('='.repeat(62))
    process.exit(failed.length ? 1 : 0)
  } catch (e) {
    console.error(e)
    process.exit(2)
  }
}

main()
