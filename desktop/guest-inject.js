const { ipcRenderer } = require('electron')

const pixBridge = {
  getPrefs: () => ipcRenderer.invoke('translate:guestPrefs'),
  translate: payload => {
    const text = String(payload && payload.text || '')
    if (!text || text.length > 5000) return Promise.resolve({ success: false, msg: '翻译文本长度无效' })
    return ipcRenderer.invoke('translate:run', {
      text,
      incoming: !!(payload && payload.incoming)
    })
  },
  onPrefs: callback => {
    ipcRenderer.removeAllListeners('translate:prefs')
    ipcRenderer.on('translate:prefs', (_event, data) => callback(data))
  },
  // 客户身份与消息上报。失败**不抛错**：采集是尽力而为，
  // 不能因为它出错就影响用户正常聊天（翻译才是主线功能）。
  reportCustomer: payload => {
    try { return ipcRenderer.invoke('customer:ingest', payload).catch(() => null) } catch (e) { return Promise.resolve(null) }
  }
}

;(() => {
  if (window.__helloPixChat) return true
  window.__helloPixChat = true

  const cache = new Map()
  const pending = new Map()
  const BUSY_MARK = '[正在翻译中...]'
  const EMOJI_RE = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\uFE0F\u200D\u20E3])/gu
  let prefs = {
    transRecv: true,
    transSend: true,
    transGroup: false,
    langMine: 'zh',
    langOther: 'auto',
    sendTo: 'en',
    includeZh: false,
    antiRevoke: false
  }
  let scanTimer = 0
  let sendBusy = false
  let passOnce = false

  const style = document.createElement('style')
  style.textContent = `
    #pix-h-btn { display: none !important; }
    .pix-trans {
      display: block;
      clear: both;
      margin: 6px 0 2px;
      padding-top: 6px;
      border-top: 1px solid currentColor;
      border-top-color: rgba(255,255,255,.16);
      font-size: var(--pix-font-size, 15px);
      color: var(--pix-font-color, inherit);
      line-height: 1.45;
      opacity: 0.9;
      white-space: pre-wrap;
      user-select: text;
    }
    .message-in .pix-trans, .message-list-item:not(.own) .pix-trans {
      border-top-color: rgba(255,255,255,.12);
    }
    .pix-click {
      display: inline-block;
      clear: both;
      margin-top: 6px;
      padding: 2px 8px;
      border-radius: 8px;
      background: rgba(255,255,255,.12);
      font-size: 12px;
      cursor: pointer;
      user-select: none;
      opacity: 0.85;
    }
    .pix-kept {
      display: block;
      clear: both;
      margin-top: 6px;
      white-space: pre-wrap;
      line-height: 1.45;
    }
    .pix-revoked {
      display: block;
      margin-top: 4px;
      font-size: 11px;
      color: #d97706;
      opacity: 0.95;
    }
  `
  function mountStyle() {
    if (document.documentElement && !style.isConnected) document.documentElement.appendChild(style)
  }
  mountStyle()
  if (!document.documentElement) document.addEventListener('DOMContentLoaded', mountStyle, { once: true })

  function api() {
    return pixBridge
  }

  function applyPrefs(next) {
    if (!next) return
    prefs = {
      transRecv: next.transRecv !== 0 && next.transRecv !== false,
      transSend: next.transSend !== 0 && next.transSend !== false,
      transGroup: !!(next.transGroup && next.transGroup !== '0'),
      langMine: next.langMine || 'zh',
      langOther: next.langOther || 'auto',
      sendTo: next.sendTo && next.sendTo !== 'auto' ? next.sendTo : 'en',
      includeZh: next.includeZh === 1 || next.includeZh === true || next.includeZh === 'true',
      antiRevoke: !!(next.antiRevoke && next.antiRevoke !== '0')
    }
    const root = document.documentElement
    root.style.setProperty('--pix-font-size', (Number(next.fontSize) || 15) + 'px')
    if (next.fontColor) root.style.setProperty('--pix-font-color', next.fontColor)
    schedule()
  }
  window.__helloPixApplyPrefs = applyPrefs

  function stripEmoji(text) {
    return String(text || '').replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim()
  }

  function isEmojiOnly(text) {
    const raw = String(text || '').trim()
    return !!raw && !stripEmoji(raw)
  }

  function isBusyText(text) {
    const s = String(text || '')
    return s.indexOf(BUSY_MARK) !== -1 || s.indexOf('|翻译中...') !== -1 || s.indexOf('翻译中...') !== -1
  }

  function hasChinese(text) {
    return /[\u4e00-\u9fff]/.test(String(text || ''))
  }

  function sourceText(node) {
    const preferred = node.querySelector('.translatable-message')
    if (preferred) return preferred.innerText.replace(/\s+/g, ' ').trim()
    const clone = node.cloneNode(true)
    clone.querySelectorAll('.MessageMeta, .message-time, .pix-trans, .pix-click, .pix-kept, .pix-revoked, time, .Reactions, .message-views').forEach(item => item.remove())
    return clone.innerText.replace(/\s+/g, ' ').trim()
  }

  function messageNodes() {
    return Array.from(document.querySelectorAll(
      '.message-list-item .text-content, .Message .text-content, div.message-in span.selectable-text, div.message-out span.selectable-text, div.copyable-text span.selectable-text'
    ))
  }

  function isOwn(node) {
    return !!(node.closest('.own') || node.closest('.message-out'))
  }

  function isGroupChat() {
    const info = document.querySelector('.ChatInfo, header')
    const text = ((info && info.innerText) || '').slice(0, 400)
    return /members|subscribers|位成员|位订阅|群组/i.test(text)
  }

  function hostOf(node) {
    return node.closest('.text-content') ||
      node.closest('div.copyable-text') ||
      node.closest('[data-testid="msg-container"]') ||
      node
  }

  // ---------------------------------------------------------------------
  // 客户身份采集
  //
  // 目标：让服务端知道「哪个员工、通过哪个账号、正在跟哪个客户」，
  // 从而做跨账号/跨平台的客户识别与撞单检测。
  //
  // 采集是**尽力而为**：拿不到就跳过，绝不影响翻译主流程。
  // 身份标识来源只有 URL hash 一个可信渠道；拿不到就**不上报**，
  // 宁可漏采集，也不要制造一个错误的客户身份。
  // ---------------------------------------------------------------------

  var lastPeerKey = ''

  function telegramPeer() {
    var hash = String(location.hash || '').replace(/^#\/?/, '').trim()
    // Telegram Web A：纯数字是 peer id（群组带前导 -），@ 开头是用户名
    if (/^-?\d{5,}$/.test(hash)) {
      return { peerKey: hash.replace(/^-/, ''), platformUid: hash, kind: 'peer_id' }
    }
    if (/^@?[A-Za-z0-9_]{4,64}$/.test(hash)) {
      return { peerKey: '@' + hash.replace(/^@/, ''), platformUid: hash, kind: 'username' }
    }
    return null
  }

  /**
   * WhatsApp Web 没有可用的 URL 标识，但消息元素的 data-id 里有更好的东西：
   *
   *   data-id="false_8613800138000@c.us_3EB0ABC123"
   *            ↑      ↑                  ↑
   *          是否本人  chatId            消息 ID
   *
   * chatId 就是**手机号**（个人）或群标识 —— 手机号是跨平台识别最强的线索，
   * 比 Telegram 的 peer id 还有用：同一个人的 WhatsApp 与 Telegram
   * 只要有手机号就能合并成同一个客户。
   *
   * 群聊（@g.us）**不作为客户身份**：群里没有单一"客户"，
   * 把它当客户会把整个群的人混成一个人。
   */
  function whatsappPeer() {
    var nodes = document.querySelectorAll('[data-id]')
    for (var i = 0; i < nodes.length && i < 400; i++) {
      var raw = String(nodes[i].getAttribute('data-id') || '')
      if (raw.indexOf('@c.us') < 0 && raw.indexOf('@g.us') < 0) continue
      var parts = raw.split('_')
      if (parts.length < 3) continue
      var chatId = parts[1] || ''
      if (chatId.indexOf('@g.us') >= 0) return null   // 群聊不算客户
      var digits = chatId.split('@')[0]
      if (!/^\d{7,15}$/.test(digits)) return null
      return {
        peerKey: chatId,
        platformUid: chatId,
        // 手机号以 + 开头交给服务端按 E.164 归一 —— WhatsApp 的 chatId
        // 一定含国家码，所以不存在"猜国家码"的歧义
        phone: '+' + digits,
        sourceMsgId: parts.slice(2).join('_'),
        kind: 'phone'
      }
    }
    return null
  }

  function currentPeer() {
    return telegramPeer() || whatsappPeer()
  }

  function chatDisplayName() {
    var el = document.querySelector('.ChatInfo .title, .ChatInfo h3, .peer-title, header .title')
    var text = el ? String(el.innerText || '').trim().split('\n')[0] : ''
    return text.slice(0, 80)
  }

  /**
   * 上报一条线索。body 为空表示"只是打开了会话"——
   * 服务端据此建立跟进关系，这正是撞单检测的触发点。
   */
  function reportClue(body, direction, sentAt) {
    var pix = api()
    if (!pix || !pix.reportCustomer) return
    var peer = currentPeer()
    if (!peer) return
    if (document.hidden) return

    try {
      pix.reportCustomer({
        // platform 与 accountKey **刻意不在这里填**：
        // 主进程会按 webContents 反查到可信的 tab 再补上。
        // 渲染进程在网页上下文里，理论上可被页面脚本影响，
        // 让它自报"我是哪个账号"等于把归属权交给不可信的一侧。
        peerKey: peer.peerKey,
        platformUid: peer.platformUid,
        displayName: chatDisplayName(),
        body: body ? String(body).slice(0, 4000) : '',
        direction: direction || 'in',
        sourceConvId: peer.peerKey,
        // WhatsApp 能从 data-id 里拿到平台原始消息 ID；Telegram 拿不到，
        // 此时靠服务端按「同会话+同时间+同内容」去重兜底
        sourceMsgId: peer.sourceMsgId || '',
        // 手机号是跨平台合并的关键线索，能拿到就一定要带上
        phone: peer.phone || '',
        // 历史消息的发送时间是"过去"，用 now() 会把三个月的旧消息记成刚刚发生。
        // 能从 DOM 解析出来就用真实时间，解析不出才退回 now()。
        sentAt: sentAt || new Date().toISOString()
      })
    } catch (e) {}
    lastPeerKey = peer.peerKey
  }

  /**
   * 尽量从 DOM 里解析出这条消息的真实发送时间。
   *
   * 解析不出来就返回 null，由调用方退回 now()。**刻意不做更复杂的推断** ——
   * 猜错时间比没有时间更糟：消息归档里一条时间错乱记录，会让"什么时候聊的"
   * 这个最基本的判断失真，而且很难事后发现。
   */
  function messageTime(node) {
    // WhatsApp：容器上有 data-pre-plain-text="[4:32 PM, 9/25/2026] 名字: "
    var holder = node.closest ? node.closest('[data-pre-plain-text]') : null
    if (holder) {
      var raw = holder.getAttribute('data-pre-plain-text') || ''
      var m = /\[([^\]]+)\]/.exec(raw)
      if (m) {
        // 窄空格（U+202F）是 WhatsApp 用的，Safari/部分环境 Date.parse 不认
        var t = Date.parse(m[1].replace(/[\u202f\u00a0]/g, ' '))
        if (!isNaN(t)) return new Date(t).toISOString()
      }
    }
    // Telegram Web A / K：消息里有 <time datetime="..."> 或带 title 的 .time
    var timeEl = node.querySelector ? node.querySelector('time[datetime]') : null
    if (timeEl) {
      var dt = timeEl.getAttribute('datetime')
      var t2 = dt ? Date.parse(dt) : NaN
      if (!isNaN(t2)) return new Date(t2).toISOString()
      var title = timeEl.getAttribute('title')
      var t3 = title ? Date.parse(title) : NaN
      if (!isNaN(t3)) return new Date(t3).toISOString()
    }
    return null
  }

  /**
   * 消息归档去重。
   *
   * scan() 由 MutationObserver 驱动，页面稍有变化就会重扫全部已渲染的消息 ——
   * 没有去重的话同一条消息会被反复上报。这里用「会话 + 方向 + 正文哈希」做键：
   * Telegram 拿不到稳定的消息 ID，而同一会话里同方向同内容的消息本来就极少，
   * 偶尔把两条一模一样的消息并成一条，也比把一条消息存十遍要好。
   */
  var reportedKeys = Object.create(null)
  var reportedCount = 0
  var REPORTED_CAP = 4000

  function textHash(s) {
    var h = 5381
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return (h >>> 0).toString(36)
  }

  /**
   * 上报一条真实消息正文。
   *
   * 与此前的 `reportIfPeerChanged()` 的区别：那个只上报"我打开了这个会话"
   * （body 为空），服务端据此建 conversations/customers，但**不写 messages**；
   * 服务端的写入条件是 `if (payload.body)`，而 body 恒为空，
   * 于是 messages 表永远是空的 —— 消息归档能力等于没接上。
   */
  function reportMessage(node, direction, text) {
    var peer = currentPeer()
    if (!peer) return
    if (document.hidden) return
    var key = peer.peerKey + '|' + direction + '|' + textHash(text)
    if (reportedKeys[key]) return
    // 键表满了就整体清空而不是拒绝新消息：宁可让最早那批有机会被重报一次
    // （服务端还有唯一索引兜底），也不要让归档从此停止工作。
    if (reportedCount >= REPORTED_CAP) {
      reportedKeys = Object.create(null)
      reportedCount = 0
    }
    reportedKeys[key] = 1
    reportedCount++
    reportClue(text, direction, messageTime(node))
  }

  /** 会话切换时上报一次 —— 打开新客户就是撞单检测的触发时机 */
  function reportIfPeerChanged() {
    var peer = currentPeer()
    if (!peer) return
    if (peer.peerKey === lastPeerKey) return
    reportClue('', 'in')
  }

  function detectLang(text) {
    const s = String(text || '')
    if (/[\u4e00-\u9fff]/.test(s)) return 'zh'
    if (/[\u3040-\u30ff]/.test(s)) return 'ja'
    if (/[\uac00-\ud7af]/.test(s)) return 'ko'
    if (/[\u0e00-\u0e7f]/.test(s)) return 'th'
    if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s)) return 'vi'
    return 'en'
  }

  function sameLang(text) {
    return detectLang(text) === (prefs.langMine || 'zh')
  }

  function clearExtras(host) {
    host.querySelectorAll(':scope > .pix-trans, :scope > .pix-click').forEach(el => el.remove())
  }

  async function translateText(text, incoming) {
    const cleaned = stripEmoji(text)
    if (!cleaned) return ''
    const key = (incoming ? 'in:' : 'out:') + cleaned
    if (cache.has(key)) return cache.get(key)
    if (pending.has(key)) return pending.get(key)
    const pix = api()
    if (!pix || !pix.translate) return ''
    const job = pix.translate({ text: cleaned, incoming: incoming }).then(resp => {
      const out = String((resp && (resp.translation || resp.text)) || '').trim()
      if (out) cache.set(key, out)
      pending.delete(key)
      return out
    }).catch(() => {
      pending.delete(key)
      return ''
    })
    pending.set(key, job)
    return job
  }

  function paint(host, translated) {
    const click = host.querySelector(':scope > .pix-click')
    if (click) click.remove()
    const original = sourceText(host)
    if (!translated || translated.replace(/\s+/g, '') === original.replace(/\s+/g, '')) {
      clearExtras(host)
      return
    }
    let box = host.querySelector(':scope > .pix-trans')
    if (!box) {
      box = document.createElement('div')
      box.className = 'pix-trans'
      const meta = host.querySelector(':scope > .MessageMeta, :scope > .message-time')
      if (meta) host.insertBefore(box, meta)
      else host.appendChild(box)
    }
    box.textContent = translated
  }

  function addClick(host, incoming) {
    if (host.querySelector(':scope > .pix-trans, :scope > .pix-click')) return
    const chip = document.createElement('span')
    chip.className = 'pix-click'
    chip.textContent = '译'
    chip.onclick = async event => {
      event.preventDefault()
      event.stopPropagation()
      chip.textContent = '…'
      const text = sourceText(host)
      paint(host, await translateText(text, incoming))
    }
    const meta = host.querySelector(':scope > .MessageMeta, :scope > .message-time')
    if (meta) host.insertBefore(chip, meta)
    else host.appendChild(chip)
  }

  function visible(el) {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 8 && rect.height > 8
  }

  function firstMatch(selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const nodes = document.querySelectorAll(selectors[i])
      for (let j = 0; j < nodes.length; j++) {
        if (visible(nodes[j])) return nodes[j]
      }
    }
    return null
  }

  function composerEl() {
    const found = firstMatch([
      'footer [contenteditable="true"]',
      '#editable-message-text',
      '.input-message-input[contenteditable="true"]',
      '[data-testid="conversation-compose-box-input"]',
      '[data-tab="10"][contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[aria-label*="message" i][contenteditable="true"]',
      'div[aria-placeholder][contenteditable="true"]',
      'form [contenteditable="true"]',
      'textarea[placeholder*="message" i]',
      'textarea[aria-label*="message" i]'
    ])
    if (found) return found
    const ae = document.activeElement
    if (ae && visible(ae) && (ae.isContentEditable || ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) {
      if (!ae.closest('header, [role="search"], [data-testid="chat-list-search"]')) return ae
    }
    return null
  }

  function readComposer(el) {
    if (!el) return ''
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return String(el.value || '')
    return String(el.innerText || el.textContent || '')
  }

  function writeComposer(el, text) {
    if (!el) return
    el.focus()
    const value = String(text || '')
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && desc.set) desc.set.call(el, value)
      else el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return
    }
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    sel.removeAllRanges()
    sel.addRange(range)
    const ok = document.execCommand('insertText', false, value)
    if (!ok) {
      el.textContent = value
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
    }
  }

  function sendButton() {
    return firstMatch([
      'button[aria-label="Send"]',
      'button[aria-label="发送"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send a message"]',
      'button[data-testid="send"]',
      'button[data-testid="compose-btn-send"]',
      'button.Button.send',
      '.btn-send',
      'span[data-icon="send"]',
      '[data-icon="wds-ic-send-filled"]'
    ])
  }

  function looksLikeSend(target) {
    if (!target || !target.closest) return false
    const icon = target.closest('[data-icon]')
    if (icon && /send/i.test(icon.getAttribute('data-icon') || '')) return true
    const el = target.closest('button, [role="button"], span[data-icon], div[role="button"]')
    if (!el) return false
    const label = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-icon'),
      el.getAttribute('data-testid'),
      el.className
    ].join(' ').toLowerCase()
    if (/(voice|mic|attach|emoji|sticker|gif|record|拍照|语音|表情)/i.test(label)) return false
    return /(^|[\s_-])(send|发送|enviar|envoyer|senden|invia)([\s_-]|$)/i.test(label) ||
      /btn-send|compose-btn-send|wds-ic-send/i.test(label)
  }

  function isSendEnter(event) {
    if (event.key !== 'Enter' && event.code !== 'Enter' && event.keyCode !== 13) return false
    if (event.shiftKey || event.altKey || event.isComposing) return false
    return true
  }

  function eventInComposer(event, box) {
    if (!event || !box) return false
    const t = event.target
    return t === box || box.contains(t)
  }

  function fireSend(box) {
    passOnce = true
    window.setTimeout(() => { passOnce = false }, 400)
    const btn = sendButton()
    if (btn) {
      const clickable = btn.closest('button, [role="button"]') || btn
      clickable.click()
      return
    }
    if (!box) return
    box.focus()
    box.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    }))
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  async function runIntercept(event, box) {
    const raw = readComposer(box).replace(/\s+$/g, '')
    const trimmed = raw.trim()
    if (!trimmed) return false
    if (isBusyText(trimmed) || sendBusy) {
      if (event) {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
      }
      return true
    }
    if (isEmojiOnly(trimmed)) return false
    const forApi = stripEmoji(trimmed)
    if (!forApi) return false
    if (detectLang(forApi) === (prefs.sendTo || 'en')) return false
    if (event) {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }
    sendBusy = true
    writeComposer(box, raw.replace(/\s+$/g, '') + BUSY_MARK)
    try {
      const out = await translateText(forApi, false)
      if (!out) {
        writeComposer(box, raw)
        return true
      }
      writeComposer(box, out === forApi ? raw : out)
      await wait(50)
      fireSend(box)
    } catch (e) {
      writeComposer(box, raw)
    } finally {
      sendBusy = false
    }
    return true
  }

  function onKeyDown(event) {
    if (passOnce && isSendEnter(event)) {
      passOnce = false
      return
    }
    if (!prefs.transSend) return
    if (event.defaultPrevented) return
    if (!isSendEnter(event)) return
    const box = composerEl()
    if (!box || !eventInComposer(event, box)) return
    runIntercept(event, box)
  }

  function onBeforeInput(event) {
    if (!prefs.transSend) return
    if (passOnce) return
    if (event.inputType !== 'insertParagraph') return
    const box = composerEl()
    if (!box || !eventInComposer(event, box)) return
    runIntercept(event, box)
  }

  function onClick(event) {
    if (passOnce) {
      passOnce = false
      return
    }
    if (!prefs.transSend) return
    if (!looksLikeSend(event.target)) return
    const box = composerEl()
    if (!box) return
    if (!readComposer(box).trim()) return
    runIntercept(event, box)
  }

  const DELETED_RE = /^(this message was deleted\.?|you deleted this message\.?|此消息已删除|你删除了这条消息|你已删除此消息|esta mensagem foi apagada|este mensaje fue eliminado|ce message a été supprimé|diese nachricht wurde gelöscht|pesan ini telah dihapus)$/i
  const revokeMap = new Map()

  function messageRoot(node) {
    return node.closest('[data-id]') ||
      node.closest('[data-testid="msg-container"]') ||
      hostOf(node)
  }

  function messageKey(root) {
    if (!root) return ''
    return root.getAttribute('data-id') || root.getAttribute('data-pre-plain-text') || ''
  }

  function isDeletedText(text) {
    return DELETED_RE.test(String(text || '').trim())
  }

  function rememberMessage(root, text) {
    const key = messageKey(root)
    if (!key || !text || isDeletedText(text) || text.length > 4000) return
    revokeMap.set(key, text)
  }

  function keepRevoked(root, text) {
    if (!prefs.antiRevoke || !root) return
    const key = messageKey(root)
    const saved = key && revokeMap.get(key)
    if (!saved) return
    if (!isDeletedText(text) && root.querySelector('.pix-kept')) return
    if (!isDeletedText(text)) return
    let kept = root.querySelector(':scope > .pix-kept')
    if (!kept) {
      kept = document.createElement('div')
      kept.className = 'pix-kept'
      root.appendChild(kept)
    }
    kept.textContent = saved
    let tag = root.querySelector(':scope > .pix-revoked')
    if (!tag) {
      tag = document.createElement('div')
      tag.className = 'pix-revoked'
      root.appendChild(tag)
    }
    tag.textContent = '已撤回'
  }

  async function scan() {
    // 每次扫描顺带看一眼是不是换了客户 —— 打开新会话就是撞单检测的触发点。
    // 挂在 scan 上而不是另起定时器：scan 已由 MutationObserver 调度，
    // 复用既省资源，也保证"页面一变就能发现"。
    try { reportIfPeerChanged() } catch (e) {}
    const nodes = messageNodes()
    const group = isGroupChat()
    const auto = !group || prefs.transGroup
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      const host = hostOf(node)
      const root = messageRoot(node)
      const text = sourceText(host)
      if (prefs.antiRevoke) {
        rememberMessage(root, text)
        keepRevoked(root, text)
      }
      if (!text || text.length > 4000) continue
      if (isBusyText(text) || isDeletedText(text)) continue
      // 消息归档：**放在翻译开关判断之前**。
      // 归档和"要不要翻译这条"是两件事 —— 中文消息（includeZh 关闭）、
      // 群聊（transGroup 关闭）同样是需要留档的往来记录，不能因为不翻译就不归档。
      try { reportMessage(node, isOwn(node) ? 'out' : 'in', text) } catch (e) {}
      if (!prefs.transRecv) {
        clearExtras(host)
        continue
      }
      if (isEmojiOnly(text)) {
        clearExtras(host)
        continue
      }
      if (hasChinese(text) && !prefs.includeZh) {
        clearExtras(host)
        continue
      }
      if (sameLang(text) && !(prefs.includeZh && hasChinese(text))) {
        clearExtras(host)
        continue
      }
      if (!auto) {
        if (!host.querySelector(':scope > .pix-trans')) addClick(host, true)
        continue
      }
      const translated = await translateText(text, true)
      if (translated) paint(host, translated)
    }
  }

  function schedule() {
    if (scanTimer) return
    scanTimer = window.setTimeout(() => {
      scanTimer = 0
      scan()
    }, 220)
  }

  async function boot() {
    const pix = api()
    if (pix && pix.onPrefs) pix.onPrefs(applyPrefs)
    if (pix && pix.getPrefs) {
      try { applyPrefs(await pix.getPrefs()) } catch (e) {}
    }
    document.querySelectorAll('#pix-h-btn').forEach(el => el.remove())
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('beforeinput', onBeforeInput, true)
    document.addEventListener('click', onClick, true)
    schedule()
  }

  const obs = new MutationObserver(schedule)
  const observePage = () => {
    if (document.documentElement) obs.observe(document.documentElement, { childList: true, subtree: true })
  }
  observePage()
  if (!document.documentElement) document.addEventListener('DOMContentLoaded', observePage, { once: true })
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
  return true
})()
