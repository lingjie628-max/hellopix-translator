'use strict'

/**
 * WhatsApp Web 进粉事件观察器（页面世界）。
 *
 * DOM 扫描只覆盖当前打开的会话；用户切到别的聊天时就看不到其他会话的新粉。
 * 计数需要覆盖后台聊天，因此这里订阅 WhatsApp 自己加载后的消息集合事件。
 *
 * 安全边界：
 *   · 只输出身份骨架和消息时间，不读取正文；
 *   · 只接受私聊、非本人、非广播/状态消息；
 *   · 模块名/能力对不上时失败关闭并暴露可观测状态；
 *   · 同一个 peer 在本次页面生命周期只上报一次，最终幂等仍由服务端保证。
 */
function installWhatsAppCounterObserver(options) {
  if (window.__pixCounterObserverInstalled) return
  window.__pixCounterObserverInstalled = true

  const cfg = options || {}
  const hostname = String(location.hostname || '').toLowerCase()
  if (hostname !== 'web.whatsapp.com') return

  const STARTED_AT = Date.now()
  const SEEN_CAP = 5000
  const seenMessages = new Map()
  const reportedPeers = new Set()
  const subscriptions = []
  const skipped = Object.create(null)
  let lastError = ''
  let lastEventAt = null
  let sourceKind = ''
  let disposed = false

  function safeString(value) {
    if (value == null) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number') return String(value)
    if (typeof value === 'object') {
      try {
        return String(value._serialized || value.id || value.remote || '')
      } catch (e) {
        return ''
      }
    }
    return ''
  }

  function trimText(value, max) {
    return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 160)
  }

  function status() {
    return {
      installed: true,
      ready: !!sourceKind,
      source: sourceKind,
      startedAt: new Date(STARTED_AT).toISOString(),
      subscriptions: subscriptions.length,
      lastEventAt,
      lastError,
      skipped: Object.assign({}, skipped)
    }
  }

  function noteSkip(reason) {
    skipped[reason] = (skipped[reason] || 0) + 1
  }

  function messageKey(id) {
    if (!id) return ''
    if (typeof id === 'object') {
      const stable = safeString(id.id || id._serialized || '')
      const remote = safeString(id.remote || id.remoteJid || '')
      if (stable && remote) {
        return (id.fromMe === true ? 'out:' : 'in:') + remote + ':' + stable
      }
      return stable
    }
    return safeString(id)
  }

  function jidParts(raw) {
    const value = safeString(raw)
    const at = value.lastIndexOf('@')
    if (at < 0) return { raw: value, user: value, server: '' }
    return {
      raw: value,
      user: value.slice(0, at).split(':')[0],
      server: value.slice(at + 1).toLowerCase()
    }
  }

  function timestampSeconds(value) {
    let number = Number(value)
    if (!Number.isFinite(number) || number <= 0) return 0
    // WhatsApp 模型通常是秒；兼容部分版本直接给毫秒。
    if (number > 100000000000) number = Math.floor(number / 1000)
    return Math.floor(number)
  }

  function eventFromMessage(message, via) {
    if (!message) return null
    if (message.fromMe === true) {
      noteSkip('from_me')
      return null
    }
    if (message.isNotification === true) {
      noteSkip('notification')
      return null
    }
    if (message.isStatus === true) {
      noteSkip('status')
      return null
    }

    const id = message.id || {}
    const fromRaw = safeString(
      message.from ||
      (id && (id.remote || id.remoteJid || id.chatId)) ||
      message.chatId
    )
    const from = jidParts(fromRaw)
    if (
      from.server === 'g.us' ||
      from.server === 'broadcast' ||
      from.server === 'status@broadcast' ||
      message.isGroup === true ||
      message.isBroadcast === true
    ) {
      noteSkip('group_or_broadcast')
      return null
    }

    const type = trimText(message.type || message.kind || 'unknown', 64).toLowerCase()
    if (
      type === 'reaction' ||
      type === 'poll' ||
      type === 'event' ||
      type === 'revoked' ||
      type === 'protocol' ||
      type === 'protocolmessage' ||
      type === 'senderkeydistributionmessage'
    ) {
      noteSkip('message_type')
      return null
    }

    const sourceMessageId = messageKey(id)
    if (!sourceMessageId) {
      noteSkip('missing_message_id')
      return null
    }
    if (seenMessages.has(sourceMessageId)) {
      noteSkip('duplicate_message')
      return null
    }

    const sentSeconds = timestampSeconds(
      message.t || message.timestamp || message.messageTimestamp
    )
    // WhatsApp 在处理实时消息时会显式写入 isNewMsg:true（含离线重连后补收
    // 的消息）。这类消息即使 t 比较旧也必须接收，否则“手机离线一段时间、
    // 电脑重连后收到”的真实进粉会被误判成历史。只有没有实时标记的旧消息
    // 才按历史回补拦截，避免滚动聊天记录把旧客户重新计数。
    if (
      message.isNewMsg !== true &&
      sentSeconds &&
      sentSeconds < Math.floor(STARTED_AT / 1000) - 300
    ) {
      noteSkip('historical_replay')
      return null
    }

    const authorRaw = safeString(
      message.author ||
      (id && id.participant) ||
      (message.sender && (message.sender.id || message.sender._serialized)) ||
      ''
    )
    const author = jidParts(authorRaw)
    const peer = from.raw ? from : author
    if (!peer.raw) {
      noteSkip('missing_peer')
      return null
    }

    let phone = ''
    let whatsappLid = ''
    const phoneParts = [from, author].filter(part => part.server === 'c.us' || part.server === 's.whatsapp.net')
    const lidParts = [from, author].filter(part => part.server === 'lid')
    if (phoneParts[0] && /^\d{7,15}$/.test(phoneParts[0].user)) {
      phone = phoneParts[0].user
    }
    if (lidParts[0] && /^\d{5,30}$/.test(lidParts[0].user)) {
      whatsappLid = 'lid:' + lidParts[0].user
    }

    const pushName = trimText(
      message.notifyName ||
      (message.contact && message.contact.pushname) ||
      (message.senderObj && message.senderObj.name) ||
      '',
      120
    )

    seenMessages.set(sourceMessageId, Date.now())
    if (seenMessages.size > SEEN_CAP) {
      const cutoff = Date.now() - 60 * 60 * 1000
      for (const entry of seenMessages) {
        if (entry[1] < cutoff) seenMessages.delete(entry[0])
      }
    }

    // 一个页面生命周期里每个私聊只上报首条有效消息，减少 IPC/网络压力。
    if (reportedPeers.has(peer.raw)) {
      noteSkip('peer_already_reported')
      return null
    }
    reportedPeers.add(peer.raw)

    return {
      via,
      sourceMessageId,
      peerKey: peer.raw,
      phone,
      whatsappLid,
      pushName,
      messageType: type,
      sentAt: new Date((sentSeconds || Math.floor(STARTED_AT / 1000)) * 1000).toISOString(),
      day: new Date((sentSeconds || Math.floor(STARTED_AT / 1000)) * 1000)
        .toISOString()
        .slice(0, 10)
    }
  }

  function publish(event) {
    if (!event || disposed) return
    lastEventAt = new Date().toISOString()
    try {
      window.postMessage({
        source: 'hello-pix-page',
        channel: 'counter:inbound',
        payload: event
      }, location.origin)
    } catch (e) {
      lastError = 'postMessage: ' + ((e && e.message) || e)
    }
  }

  function handleModel(message, via) {
    try {
      const event = eventFromMessage(message, via)
      if (event) publish(event)
    } catch (e) {
      lastError = 'handle: ' + ((e && e.message) || e)
    }
  }

  function looksLikeCollection(value) {
    return !!value &&
      typeof value === 'object' &&
      typeof value.on === 'function' &&
      (
        typeof value.getModelsArray === 'function' ||
        Array.isArray(value.models)
      )
  }

  function findCollection(value, depth) {
    if (!value || depth > 3) return null
    if (looksLikeCollection(value)) return value
    let keys = []
    try { keys = Object.keys(value) } catch (e) {}
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      if (!/(msg|message|collection)/i.test(key)) continue
      let child = null
      try { child = value[key] } catch (e) {}
      const hit = findCollection(child, depth + 1)
      if (hit) return hit
    }
    return null
  }

  function subscribe(collection, kind) {
    if (!collection || subscriptions.some(item => item.collection === collection)) return false
    const onAdd = message => handleModel(message, kind + ':add')
    const onChange = message => handleModel(message, kind + ':change')
    try { collection.on('add', onAdd) } catch (e) { return false }
    try { collection.on('change', onChange) } catch (e) {}
    subscriptions.push({ collection, kind, onAdd, onChange })
    return true
  }

  function loadLazy(name) {
    if (typeof window.requireLazy !== 'function') return Promise.resolve(null)
    return new Promise(resolve => {
      let done = false
      const finish = value => {
        if (done) return
        done = true
        resolve(value || null)
      }
      const timer = setTimeout(() => finish(null), 2500)
      try {
        window.requireLazy([name], value => {
          clearTimeout(timer)
          finish(value)
        })
      } catch (e) {
        clearTimeout(timer)
        finish(null)
      }
    })
  }

  async function discover() {
    const names = [
      'WAWebMsgCollection',
      'WAWebMessageCollection',
      'WAWebCollections'
    ]
    for (let i = 0; i < names.length; i++) {
      let value = null
      try {
        value = await loadLazy(names[i])
      } catch (e) {}
      const collection = findCollection(value, 0)
      if (collection && subscribe(collection, names[i])) {
        sourceKind = names[i]
        lastError = ''
        // 用 warn 级别：客户端日志目前会过滤普通 info，否则真机无法确认
        // 观察器到底有没有找到 WhatsApp 的消息集合。
        console.warn('[pix-counter-observer] ready ' + JSON.stringify(status()))
        return true
      }
    }
    lastError = 'WhatsApp 消息集合模块未找到'
    console.warn('[pix-counter-observer] unavailable ' + JSON.stringify(status()))
    return false
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const item of subscriptions) {
      try { item.collection.off('add', item.onAdd) } catch (e) {}
      try { item.collection.off('change', item.onChange) } catch (e) {}
    }
    subscriptions.length = 0
  }

  window.__pixCounterObserverStatus = status
  window.addEventListener('beforeunload', dispose, { once: true })

  if (cfg.testMode === true) {
    window.__pixCounterObserverHandleForTest = message => handleModel(message, 'test')
  }

  discover().catch(e => {
    lastError = (e && e.message) || String(e)
    console.warn('[pix-counter-observer] failed ' + lastError)
  })
}

function buildWhatsAppCounterObserverScript(options) {
  const opts = Object.assign({}, options || {})
  return '(' + installWhatsAppCounterObserver.toString() + ')(' + JSON.stringify(opts) + ');'
}

module.exports = {
  installWhatsAppCounterObserver,
  buildWhatsAppCounterObserverScript
}
