'use strict'
/**
 * 临时只读探针 v2：真实 WhatsApp Web DOM 结构取证。
 *
 * v1 的教训：`data-id` 是纯消息哈希（不含 JID），`.message-in/.message-out` 已被删除，
 * 且 v1 把 `data-testid` 也脱敏了，导致无法识别这些语义标识。
 *
 * v2 原则：
 *   · `data-testid` / `role` —— WhatsApp 框架标识，**原文输出**（不含用户数据）。
 *   · `class` / `id` / `data-id` —— 哈希，**脱敏**。
 *   · `title` / `aria-label` —— 可能含人名，**只输出指纹**（词数 + 各词长度 + 是否含 group 字样）。
 *   · 绝不输出手机号 / 群号 / 人名原文。
 *
 * ★只读★：不点击、不输入、不发送、不改任何配置。
 */
const { app, BrowserWindow, session } = require('electron')
const path = require('node:path')

const PARTITION = process.env.PIX_PROBE_PARTITION || 'persist:pix-ahao-whatsapp-green-1'
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

app.setPath('userData', path.join(process.env.HOME, 'Library', 'Application Support', 'Hello Pix'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function probeSource () {
  const out = {}

  // ---------- 脱敏工具 ----------
  const maskTok = (v) => String(v == null ? '' : v).replace(/[A-Za-z0-9]/g, (c) => (/[0-9]/.test(c) ? '#' : 'x'))
  // 指纹：词数 + 各词长度 + 是否含 group/members 字样。足以识别 UI 文案，又不泄露人名。
  const fp = (v) => {
    const s = String(v == null ? '' : v)
    if (!s) return ''
    const words = s.trim().split(/\s+/)
    return words.map((w) => w.length).join('-') +
      '|group=' + /group/i.test(s) + '|member=' + /member|participant/i.test(s) +
      '|cn=' + /[\u4e00-\u9fa5]/.test(s) + '|len=' + s.length
  }
  // 结构序列化：保留 data-testid/role 原文，其余属性值脱敏
  const ser = (el, depth, budget) => {
    const b = budget || { n: 0 }
    if (!el || b.n > 3000) return ''
    b.n++
    const tag = String(el.tagName || '').toLowerCase()
    let a = ''
    for (const at of Array.from(el.attributes || [])) {
      if (at.name === 'data-testid' || at.name === 'role' || at.name === 'contenteditable' || at.name === 'dir') {
        a += ' ' + at.name + '="' + (at.name === 'data-testid' ? maskTok(at.value).length > 0 ? at.value : '' : at.value) + '"'
      } else if (at.name === 'title' || at.name === 'aria-label' || at.name === 'data-pre-plain-text') {
        a += ' ' + at.name + '="«' + fp(at.value) + '»"'
      } else if (at.name === 'class' || at.name === 'id' || at.name === 'data-id' || at.name === 'style') {
        a += ' ' + at.name + '="' + maskTok(at.value).slice(0, 60) + '"'
      }
    }
    const kids = (depth > 0) ? Array.from(el.children || []).map((c) => ser(c, depth - 1, b)).join('') : (el.children && el.children.length ? '…' : '')
    return '<' + tag + a + '>' + kids + '</' + tag + '>'
  }

  const main = document.querySelector('#main')
  out.hasMain = !!main

  // ---------- 0) 无会话也能采：侧栏 data-icon 普查 + 逐行指纹 ----------
  // 群头像通常是 data-icon="default-group"，单人是 default-user —— 这是最可能
  // 版本稳定的"群/私聊"信号，且不需要点击任何会话（无副作用）。
  {
    const icon0 = {}
    for (const el of Array.from(document.querySelectorAll('[data-icon]'))) {
      const k = el.getAttribute('data-icon')
      icon0[k] = (icon0[k] || 0) + 1
    }
    out.dataIconsEarly = Object.keys(icon0).sort().map((k) => k + ' x' + icon0[k])
    const pane0 = document.querySelector('#pane-side')
    if (pane0) {
      const rows0 = Array.from(pane0.querySelectorAll('[data-testid="cell-frame-container"]'))
      out.sidebarRowsEarly = rows0.slice(0, 16).map((r, i) => {
        const icons = Array.from(r.querySelectorAll('[data-icon]')).map((e) => e.getAttribute('data-icon'))
        const title = r.querySelector('[data-testid="cell-frame-title"]')
        const sec = r.querySelector('[data-testid="cell-frame-secondary"]')
        const sel = r.getAttribute('aria-selected') || (r.querySelector('[aria-selected]') ? 'inner' : '')
        return {
          i: i, selected: sel, icons: icons,
          img: !!r.querySelector('img'),
          titleLen: title ? String(title.textContent || '').length : -1,
          secFp: sec ? fp(sec.textContent) : ''
        }
      })
      // 选中行（= 当前打开会话）的图标
      const selRow = rows0.find((r) => r.getAttribute('aria-selected') === 'true' || r.querySelector('[aria-selected="true"]'))
      out.selectedRowIcons = selRow ? Array.from(selRow.querySelectorAll('[data-icon]')).map((e) => e.getAttribute('data-icon')) : null
      // 逐行结构骨架：群聊行与私聊行若有结构差异（发送者名前缀等）会在这里暴露
      out.sidebarRowStructure = rows0.slice(0, 6).map((r, i) => ({
        i: i,
        ser: ser(r, 4, { n: 0 }).slice(0, 700)
      }))
      // 预览行的标点骨架（判断是否有 "发送者: " 前缀）
      const sk = (v) => String(v == null ? '' : v).replace(/[A-Za-z0-9\u4e00-\u9fa5]/g, '').slice(0, 30)
      out.sidebarPreviewSkel = rows0.slice(0, 6).map((r, i) => {
        const sec = r.querySelector('[data-testid="cell-frame-secondary"]')
        return { i: i, skel: sec ? sk(sec.textContent) : '' }
      })
    }
  }

  if (!main) return out

  // ---------- 1) #main 内 data-testid 清单（原文 + 出现次数）----------
  const inv = {}
  for (const el of Array.from(main.querySelectorAll('[data-testid]'))) {
    const t = el.getAttribute('data-testid')
    if (!inv[t]) inv[t] = { count: 0, tags: {} }
    inv[t].count++
    const tg = String(el.tagName).toLowerCase()
    inv[t].tags[tg] = (inv[t].tags[tg] || 0) + 1
  }
  out.testidInventory = Object.keys(inv).sort().map((k) => ({ testid: k, count: inv[k].count, tags: inv[k].tags }))

  // ---------- 2) 会话头部结构 ----------
  const header = main.querySelector('header')
  out.header = header ? ser(header, 6, { n: 0 }).slice(0, 1800) : null
  out.headerTestIds = header ? Array.from(header.querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid')) : []

  // ---------- 3) 头部里的文本节点（分类，不输出原文）----------
  out.headerTexts = header ? Array.from(header.querySelectorAll('span, div')).slice(0, 40).map((e) => {
    const t = String(e.textContent || '')
    if (!t || t.length > 120) return null
    return { tag: String(e.tagName).toLowerCase(), fp: fp(t), testid: e.getAttribute('data-testid') || '', titleFp: fp(e.getAttribute('title') || ''), ariaFp: fp(e.getAttribute('aria-label') || '') }
  }).filter(Boolean).slice(0, 20) : []

  // ---------- 4) data-id 行：数量 + 结构（前后各 2 条）----------
  const rows = Array.from(main.querySelectorAll('[data-id]'))
  out.rowCount = rows.length
  out.rowSampleStructure = rows.slice(0, 2).map((r) => ({ tag: String(r.tagName).toLowerCase(), ser: ser(r, 5, { n: 0 }).slice(0, 1500) }))
  out.rowSampleStructureLast = rows.slice(-2).map((r) => ({ tag: String(r.tagName).toLowerCase(), ser: ser(r, 5, { n: 0 }).slice(0, 1500) }))

  // ---------- 5) 方向类信号（不依赖 .message-in/.message-out）----------
  out.dirSignals = {
    msgIn: main.querySelectorAll('.message-in').length,
    msgOut: main.querySelectorAll('.message-out').length,
    copyable: main.querySelectorAll('.copyable-text').length,
    selectable: main.querySelectorAll('span.selectable-text').length,
    dataIdAll: rows.length,
    // 含 @c.us/@g.us 的元素（含任意属性、属性名/值都查）
    jidAnywhere: 0
  }
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT)
  let n = 0
  let cur = walker.currentNode
  while (cur && n < 8000) {
    n++
    if (cur.attributes) for (const a of Array.from(cur.attributes)) {
      const v = String(a.value || '')
      if (v.indexOf('@c.us') >= 0 || v.indexOf('@g.us') >= 0) out.dirSignals.jidAnywhere++
    }
    cur = walker.nextNode()
  }

  // ---------- 6) 每条消息上带 group 字样的属性：原文 testid、其余给指纹 ----------
  const markers = []
  for (const el of Array.from(main.querySelectorAll('[data-testid], [title], [aria-label]')).slice(0, 6000)) {
    for (const a of Array.from(el.attributes || [])) {
      const v = String(a.value || '')
      if (!/group/i.test(v)) continue
      markers.push({
        tag: String(el.tagName).toLowerCase(),
        attr: a.name,
        val: a.name === 'data-testid' ? v : '«' + fp(v) + '»'
      })
    }
  }
  out.groupWordMarkers = markers.slice(0, 30)
  out.groupWordMarkerCount = markers.length

  // ---------- 7) 头部副标题的成员数/在线状态分类 ----------
  const cls = { members: false, online: false, cn: false }
  const ht = header ? String(header.textContent || '') : ''
  cls.members = /member|participant/i.test(ht) || /\d+\s*(位成员|成员)/.test(ht)
  cls.online = /online|last seen|typing/i.test(ht)
  cls.cn = /[\u4e00-\u9fa5]/.test(ht)
  cls.groupCn = /群组|群聊/.test(ht)
  out.headerClassify = cls

  // ---------- 8) 群专用语义标记（participant / member / invite / you-label）----------
  const sem = {}
  for (const kw of ['participant', 'member', 'invite', 'you-label', 'group', 'tail-in', 'tail-out', 'msg-container', 'msg-meta', 'author', 'sender']) {
    sem[kw] = main.querySelectorAll('[data-testid*="' + kw + '" i]').length
  }
  out.semanticCounts = sem

  // ---------- 9) chat-subtitle 完整结构 + you-label 的祖先链 ----------
  const subEl = main.querySelector('[data-testid="chat-subtitle"]')
  out.chatSubtitleSer = subEl ? ser(subEl, 4, { n: 0 }).slice(0, 900) : null
  const yl = main.querySelector('[data-testid="you-label"]')
  if (yl) {
    const chain = []
    let p = yl
    for (let i = 0; i < 8 && p && p !== main; i++) {
      chain.push(String(p.tagName).toLowerCase() + '[' + (p.getAttribute('data-testid') || '') + ']')
      p = p.parentElement
    }
    out.youLabelChain = chain
    out.youLabelText = fp(yl.textContent)
  }

  // ---------- 10) 消息行方向（tail-in / tail-out）与发送者名信号 ----------
  const rows2 = Array.from(main.querySelectorAll('[data-testid="msg-container"]'))
  out.msgContainers = rows2.length
  out.msgTails = {
    tailIn: main.querySelectorAll('[data-testid="tail-in"]').length,
    tailOut: main.querySelectorAll('[data-testid="tail-out"]').length
  }
  // 群聊：incoming 消息上方会有一条"发送者名"按钮；私聊没有。
  const senderNames = []
  for (const r of rows2.slice(0, 20)) {
    const btns = Array.from(r.querySelectorAll('div[role="button"][aria-label], span[title]'))
    for (const b of btns.slice(0, 3)) {
      const lab = b.getAttribute('aria-label') || b.getAttribute('title') || ''
      if (!lab) continue
      senderNames.push({ row: r.getAttribute('data-testid'), tag: String(b.tagName).toLowerCase(), fp: fp(lab) })
    }
  }
  out.senderNameSignals = senderNames.slice(0, 12)

  // ---------- 11) 全文档 testid（含左侧会话列表，群可能有专用标记）----------
  const docTestids = {}
  for (const el of Array.from(document.querySelectorAll('[data-testid]'))) {
    const t = el.getAttribute('data-testid')
    docTestids[t.replace(/[A-Za-z0-9]{12,}/g, '<ID>')] = (docTestids[t.replace(/[A-Za-z0-9]{12,}/g, '<ID>')] || 0) + 1
  }
  out.docTestids = Object.keys(docTestids).sort().map((k) => k + ' x' + docTestids[k])

  // ---------- 12) data-icon 普查（语义图标，未哈希；群/私聊最可能的可靠信号）----------
  const iconInv = {}
  for (const el of Array.from(document.querySelectorAll('[data-icon]'))) {
    const k = el.getAttribute('data-icon')
    iconInv[k] = (iconInv[k] || 0) + 1
  }
  out.dataIcons = Object.keys(iconInv).sort().map((k) => k + ' x' + iconInv[k])

  // 头部内的 data-icon（群头像 / 单人头像）
  out.headerIcons = header ? Array.from(header.querySelectorAll('[data-icon]')).map((e) => e.getAttribute('data-icon')) : []
  // 头部头像元素的完整属性名（找出群/单人区别）
  const av = header ? header.querySelector('img, [data-icon]') : null
  out.headerAvatar = av ? { tag: String(av.tagName).toLowerCase(), attrs: Object.keys(Object.fromEntries(Array.from(av.attributes).map((a) => [a.name, 1]))), icon: av.getAttribute('data-icon') || '' } : null

  // ---------- 13) 左侧会话列表逐行指纹（不点击，只读结构）----------
  const pane = document.querySelector('#pane-side')
  if (pane) {
    const rowsList = Array.from(pane.querySelectorAll('[data-testid="cell-frame-container"]'))
    out.sidebarRows = rowsList.slice(0, 14).map((r, i) => {
      const icons = Array.from(r.querySelectorAll('[data-icon]')).map((e) => e.getAttribute('data-icon'))
      const title = r.querySelector('[data-testid="cell-frame-title"]')
      const sec = r.querySelector('[data-testid="cell-frame-secondary"]')
      const sel = r.getAttribute('aria-selected') || (r.querySelector('[aria-selected]') ? 'inner' : '')
      return {
        i: i, selected: sel, icons: icons,
        titleFp: title ? fp(title.textContent) : '',
        secFp: sec ? fp(sec.textContent) : '',
        img: !!r.querySelector('img')
      }
    })
  }

  // ---------- 14) 高价值文本的"标点骨架"（区分在线状态 / 成员名单 / 时间）----------
  const skel = (v) => String(v == null ? '' : v).replace(/[A-Za-z0-9\u4e00-\u9fa5]/g, '').slice(0, 40)
  const subEl2 = main.querySelector('[data-testid="chat-subtitle"]')
  out.subtitleInfo = subEl2 ? { skel: skel(subEl2.textContent), fp: fp(subEl2.textContent) } : null
  const titleEl = main.querySelector('[data-testid="conversation-info-header-chat-title"]')
  out.titleInfo = titleEl ? { skel: skel(titleEl.textContent), fp: fp(titleEl.textContent) } : null
  const yl2 = main.querySelector('[data-testid="you-label"]')
  out.youLabelInfo = yl2 ? { skel: skel(yl2.textContent), fp: fp(yl2.textContent), parentTextFp: fp(yl2.parentElement ? yl2.parentElement.textContent : '') } : null

  out.title = fp(document.title)
  return out
}

async function main () {
  await app.whenReady()
  const ses = session.fromPartition(PARTITION)
  ses.setUserAgent(CHROME_UA)
  const win = new BrowserWindow({
    width: 1280, height: 860, show: true,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.webContents.setUserAgent(CHROME_UA)
  console.log('[probe] partition =', PARTITION)
  await win.loadURL('https://web.whatsapp.com/', { userAgent: CHROME_UA })
  // 等"应用外壳"而不是 #main —— 没打开会话时 #main 不存在，但侧栏数据依然可采。
  let state = 'timeout'
  for (let i = 0; i < 60; i++) {
    const s = await win.webContents.executeJavaScript(
      '(() => ({ shell: !!document.querySelector(\'[data-testid="wa-web-main-screen"], #pane-side\'), main: !!document.querySelector("#main") }))()'
    ).catch(() => ({ shell: false, main: false }))
    if (s.shell) { state = s.main ? 'logged-in+chat' : 'logged-in'; break }
    await sleep(1000)
  }
  console.log('[probe] 登录状态 =', state)
  if (state !== 'logged-in') {
    const diag = await win.webContents.executeJavaScript(
      '(() => { const m = (v) => String(v == null ? "" : v).replace(/[A-Za-z0-9]/g, (c) => (/[0-9]/.test(c) ? "#" : "x")); ' +
      'const t = Array.from(document.querySelectorAll("[data-testid]")).slice(0, 20).map((e) => e.getAttribute("data-testid")); ' +
      'return { title: m(document.title).slice(0, 50), url: location.href, ready: document.readyState, ' +
      'canvas: document.querySelectorAll("canvas").length, testids: t, ' +
      'text: m((document.body && document.body.innerText) || "").slice(0, 240) }; })()'
    ).catch((e) => ({ error: String(e && e.message) }))
    console.log('[probe] 页面诊断:', JSON.stringify(diag, null, 2))
    win.destroy(); app.exit(2); return
  }
  await sleep(7000)
  const report = await win.webContents.executeJavaScript('(' + probeSource.toString() + ')()').catch((e) => ({ error: String(e && e.message) }))
  console.log('=== PROBE2 REPORT BEGIN ===')
  console.log(JSON.stringify(report, null, 2))
  console.log('=== PROBE2 REPORT END ===')
  win.destroy()
  app.exit(0)
}

main().catch((e) => { console.log('[probe] 失败:', (e && e.stack) || e); app.exit(1) })
