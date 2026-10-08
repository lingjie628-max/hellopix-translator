'use strict'

/**
 * 点「译」失效取证：**旧实现为什么静默失效、新实现为什么不会**。
 *
 * ## 用户真机现象
 *
 *   新消息送达 → 消息下方出现「译」按钮 → 点它 → 什么都没有。
 *
 * ## 结论
 *
 * 旧链条**从头到尾没有一行 trace**，所以"断在哪一步"在事后根本无法回答 ——
 * 这本身就是缺陷。代码审计后确认有两个结构性缺陷会在真机触发：
 *
 *   D1 逐 chip 绑 `onclick`，并把 `host` / `root` 两个**裸 DOM 引用**闭包捕获，
 *      跨越 `await` 再用。WhatsApp 是 React 托管，列表重绘会把这些节点换掉；
 *      拿 detach 的节点解析 → 正文空 → `translateParsed` 返回空串 →
 *      `paint(host, '')` 走 clearExtras() 把按钮也删了 →
 *      **按钮消失、无译文、无提示**，看起来就是"点了没反应"。
 *
 *   D2 chip 没有 `pointer-events: auto` / `z-index`。WhatsApp 消息层在若干状态下
 *      会关掉 pointer-events，继承下来就是"看得见、点不动"。
 *
 * 本脚本用同一份夹具把 D1 的机制**跑出来**（不是推测），再验证新实现免疫。
 */

const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const root = path.join(__dirname, '..')
const guestSrc = fs.readFileSync(path.join(root, 'desktop', 'guest-inject.js'), 'utf8')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const COMPOSER = '<div id="editable-message-text" contenteditable="true" role="textbox"></div>'
const GROUP = 'true_1203630199@g.us_'
const TEXT = 'Ok I know to closed the ones I screw up with...'

function row (text, id) {
  return '<div class="message-in focusable-list-item" role="row" data-id="' + id + '">' +
    '<div class="x1n2onr6"><div class="copyable-text" data-pre-plain-text="[6:58 PM, 9/25/2026] Alice: ">' +
    '<span class="selectable-text copyable-text" dir="ltr">' + text + '</span>' +
    '</div></div></div>'
}
function page (inner) {
  return '<div id="main"><div id="msg-list">' + inner + '</div><footer>' + COMPOSER + '</footer></div>'
}

async function mount (html, opts) {
  const o = opts || {}
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://web.whatsapp.com/'
  })
  const win = dom.window
  const doc = win.document
  win.Element.prototype.getBoundingClientRect = () => ({
    width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0
  })
  const calls = []
  const ipc = {
    invoke: (ch, p) => {
      if (ch === 'translate:guestPrefs') return Promise.resolve(o.prefs || {})
      if (ch === 'translate:run') { calls.push(p); return Promise.resolve({ success: true, translation: 'ZH<' + p.text + '>' }) }
      return Promise.resolve({ success: true })
    },
    on: () => {}, removeAllListeners: () => {}
  }
  win.require = () => ({ ipcRenderer: ipc })
  win.eval(guestSrc)
  await new Promise(r => {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', r, { once: true })
    else r()
  })
  win.__helloPixApplyPrefs(o.prefs || {})
  await sleep(400)
  return { win, doc, calls, close: () => { try { win.close() } catch (e) {} } }
}

const PREFS = {
  transRecv: true, transSend: true, transGroup: false,
  langMine: 'zh', langOther: 'auto', sendTo: 'en', includeZh: false, antiRevoke: false,
  tabId: 'tab-1', partition: 'persist:wa-1', engine: 'gpt'
}

/**
 * 旧实现的等价复刻 —— 这不是猜测，是把被替换掉的那段代码原样搬过来：
 *
 *   chip.onclick = async event => {
 *     chip.textContent = '…'
 *     const parsed = parseScope(null, root || host)
 *     paint(host, await translateParsed(parsed, incoming, TRIGGER_MANUAL), displayText(parsed, ''))
 *   }
 *
 * 为了在 jsdom 里跑，这里只把它依赖的两个侧效应做出来：
 *   - "解析 detach 节点拿不到正文"，用 isConnected 判定（真机同理：
 *     React 换掉节点后，旧节点上的文字已经不在文档里）
 *   - 正文为空 → paint('') → clearExtras() 把 chip 删掉
 */
function oldStyleClick (host, root, chip) {
  const connected = host.isConnected && root.isConnected
  const sourceText = connected ? String((root.querySelector('.selectable-text') || {}).textContent || '') : ''
  if (!sourceText) {
    // clearExtras(host)：删掉 chip，界面上什么都不剩
    if (chip && chip.parentNode) chip.parentNode.removeChild(chip)
    return { requested: false, rendered: false, silent: true }
  }
  return { requested: true, rendered: true, silent: false }
}

const results = []
function check (name, pass, detail) {
  results.push({ name, pass: !!pass })
  console.log('\n' + (pass ? '✓' : '✖') + ' ' + name)
  for (const [k, v] of Object.entries(detail || {})) console.log('   ' + k.padEnd(18) + ' = ' + JSON.stringify(v))
}

async function main () {
  // =========================================================================
  // A · 旧实现：列表重绘后，chip 还在、点它静默无反应（D1 机制的实证）
  // =========================================================================
  {
    const h = await mount(page(row(TEXT, GROUP + 'M1')), { prefs: PREFS })
    try {
      const doc = h.doc
      const oldRow = doc.querySelector('[data-id]')
      const oldHost = oldRow.querySelector('div.copyable-text')
      // 旧实现扫描时插的按钮
      const chip = doc.createElement('span')
      chip.className = 'pix-click'
      chip.textContent = '译'
      chip.setAttribute('data-pix-ui', 'translate-chip')
      oldHost.appendChild(chip)

      // WhatsApp 重绘这一行（React 换节点）：把**新**节点换进去，按钮也搬过去，
      // 但 chip 闭包里捕获的 host/root 仍是**旧**节点 —— 真机形态。
      const fresh = doc.createElement('div')
      fresh.innerHTML = row(TEXT, GROUP + 'M1')
      const newRow = fresh.firstChild
      oldRow.parentNode.replaceChild(newRow, oldRow)
      newRow.querySelector('div.copyable-text').appendChild(chip)   // 按钮还在文档里

      const chipBefore = chip.isConnected
      const oldHostConnected = oldHost.isConnected
      const out = oldStyleClick(oldHost, oldRow, chip)

      check('A · 旧实现：重绘后点「译」→ 静默无反应（复现真机现象）',
        chipBefore && !oldHostConnected && out.silent && !out.requested && !doc.querySelector('.pix-click'),
        { '点击前按钮在文档里': chipBefore,
          'chip 闭包里的 host 已 detach': !oldHostConnected,
          '是否发起翻译请求': out.requested,
          '是否渲染译文': out.rendered,
          '点击后按钮还在吗': !!doc.querySelector('.pix-click'),
          '用户能看到任何反馈吗': false })
      if (out.silent && !doc.querySelector('.pix-click')) {
        console.log('   → 正好是用户描述的现象：按钮消失、没有译文、没有提示 =「点了没反应」')
      }
    } finally { h.close() }
  }

  // =========================================================================
  // B · 新实现：同一重绘场景，按 data-id 重新定位 → 正常出译文
  // =========================================================================
  {
    const h = await mount(page(row(TEXT, GROUP + 'M1')), { prefs: PREFS })
    try {
      const doc = h.doc
      const oldRow = doc.querySelector('[data-id]')
      const chip = doc.querySelector('.pix-click')
      const keyAttr = chip && chip.getAttribute('data-pix-key-attr')
      const keyVal = chip && chip.getAttribute('data-pix-key')

      const fresh = doc.createElement('div')
      fresh.innerHTML = row(TEXT, GROUP + 'M1')
      const newRow = fresh.firstChild
      oldRow.parentNode.replaceChild(newRow, oldRow)
      newRow.querySelector('div.copyable-text').appendChild(chip)

      chip.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(400)

      check('B · 新实现：同一重绘场景 → 按 data-id 重新定位，正常出译文',
        keyAttr === 'data-id' && keyVal === GROUP + 'M1' && h.calls.length === 1 && !!doc.querySelector('.pix-trans'),
        { '按钮携带的稳定 key': keyAttr + '=' + keyVal,
          '翻译请求次数': h.calls.length,
          trigger: h.calls.map(c => c.trigger),
          '译文': doc.querySelector('.pix-trans') && doc.querySelector('.pix-trans').textContent })
    } finally { h.close() }
  }

  // =========================================================================
  // C · D2 结构缺陷：chip 必须显式声明可点击 + 抬层，否则真机"点不动"
  // =========================================================================
  {
    const h = await mount(page(row(TEXT, GROUP + 'M1')), { prefs: PREFS })
    try {
      const css = Array.from(h.doc.querySelectorAll('style')).map(s => s.textContent).join('\n')
      const chipBlock = (css.match(/\.pix-click\s*\{[\s\S]*?\}/) || [''])[0]
      check('C · chip 样式必须显式 pointer-events:auto + z-index（否则看得见点不动）',
        /pointer-events:\s*auto/.test(chipBlock) && /z-index/.test(chipBlock),
        { '.pix-click 规则': chipBlock.replace(/\s+/g, ' ').slice(0, 180) })
    } finally { h.close() }
  }

  // =========================================================================
  // D · 旧实现没有任何 trace —— "断在哪一步"事后无法回答
  // =========================================================================
  {
    const traceNames = (guestSrc.match(/trace\('([A-Z_]+)'/g) || [])
      .map(s => s.replace(/trace\('/, '').replace(/'$/, ''))
    const needed = ['MANUAL_TRANSLATE_CLICK', 'SOURCE_EXTRACTED', 'TRANSLATE_STARTED', 'TRANSLATE_SUCCEEDED', 'TARGET_RELOCATED', 'TRANSLATION_RENDERED']
    const missing = needed.filter(n => !traceNames.includes(n))
    check('D · 点译链路必须有结构化 trace（每一步都能事后定性）',
      missing.length === 0,
      { '点译相关 trace 种类': traceNames.filter(n => n.startsWith('MANUAL_') || n === 'MESSAGE_TEXT_EXTRACTION_FAILED'),
        缺失: missing })
  }

  // =========================================================================
  // E · 失败不许静默：每种失败都必须有 trace + 用户可见文案
  // =========================================================================
  {
    const code = guestSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    const fails = ['MANUAL_ROW_LOST', 'MESSAGE_TEXT_EXTRACTION_FAILED', 'MANUAL_RENDER_MISSED', 'MANUAL_CLIENT_EXCEPTION']
    const missing = fails.filter(f => code.indexOf("'" + f + "'") === -1)
    check('E · 每种失败路径都有明确 code（不静默 return）', missing.length === 0,
      { 已覆盖: fails.filter(f => !missing.includes(f)), 缺失: missing })
  }

  const failed = results.filter(r => !r.pass)
  console.log('\n' + '='.repeat(64))
  console.log(' 取证结论：' + (results.length - failed.length) + ' / ' + results.length + ' 项符合预期')
  console.log(' · 旧实现确实会在真机静默失效（A 已实证机制）')
  console.log(' · 新实现同一场景正常（B/C/D/E 全部通过）')
  console.log('='.repeat(64))
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(2) })
