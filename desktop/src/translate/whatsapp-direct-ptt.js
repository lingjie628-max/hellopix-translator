'use strict'

/**
 * WhatsApp Web 内部模块直发 PTT（高风险能力）。
 *
 * 这个入口只做一件事：把用户明确选择的音频直接构造成 WhatsApp 原生语音
 * 消息（PTT），不再经过“虚拟麦克风 + 实时播放录音”的链路。
 *
 * KingWorld 2.67.5-beta 的做法已经通过静态解包确认：
 *   1. 外部音频转成单声道 OGG/Opus；
 *   2. 本地计算 duration 和 64 字节 waveform；
 *   3. 调 WAWebMedia.prepRawMedia({ isPtt: true })；
 *   4. 调 WAWebMediaPrep.sendMediaMsgToChat()。
 *
 * 这里不照搬它的模块编号，也不打开 Node 集成。运行时从 WhatsApp 自己的
 * Webpack 模块缓存按导出的能力符号查找模块，并只在找到完整链路时发送。
 * 任何一步找不到都失败关闭，绝不降级成普通文件上传，也不自动改走虚拟麦克风
 * （避免一次点击发出两条语音）。
 */

const DEFAULTS = Object.freeze({
  hostname: 'web.whatsapp.com',
  maxBytes: 16 * 1024 * 1024,
  convertTimeoutMs: 30000,
  testMode: false
})

function installWhatsAppDirectPtt (options) {
  const cfg = Object.assign({
    hostname: 'web.whatsapp.com',
    maxBytes: 16 * 1024 * 1024,
    convertTimeoutMs: 30000,
    testMode: false
  }, options || {})

  const HOSTNAME = String(cfg.hostname || location.hostname || '').toLowerCase()
  if (HOSTNAME !== 'web.whatsapp.com') return
  if (window.__pixDirectPttInstalled) return
  window.__pixDirectPttInstalled = true

  const MAX_BYTES = Math.max(1, Number(cfg.maxBytes) || 16 * 1024 * 1024)
  const CONVERT_TIMEOUT_MS = Math.max(1000, Number(cfg.convertTimeoutMs) || 30000)

  let busy = false
  let button = null
  let fileInput = null
  let toast = null
  let toastTimer = 0
  let lastStatus = ''
  let lastResult = null
  const preloadWaiters = new Map()

  function visible (el) {
    if (!el || !el.isConnected) return false
    try {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width >= 8 && rect.height >= 8 &&
        style.display !== 'none' && style.visibility !== 'hidden' &&
        Number(style.opacity || 1) !== 0
    } catch (e) {
      return false
    }
  }

  function footer () {
    const main = document.querySelector('#main')
    return main ? main.querySelector('footer') : null
  }

  function nativeVoiceButton () {
    const scope = footer()
    if (!scope) return null
    const nodes = scope.querySelectorAll('button,[role="button"],[data-icon]')
    for (const node of nodes) {
      if (node.closest && node.closest('[data-pix-ui]')) continue
      const label = [
        node.getAttribute && node.getAttribute('aria-label'),
        node.getAttribute && node.getAttribute('title'),
        node.getAttribute && node.getAttribute('data-icon')
      ].filter(Boolean).join(' ').toLowerCase()
      if (/(voice|audio|mic|record|ptt|voz|语音|录音)/i.test(label) && visible(node)) {
        return node.closest('button,[role="button"]') || node
      }
    }
    return null
  }

  function ensureStyle () {
    if (document.getElementById('pix-direct-ptt-style')) return
    const style = document.createElement('style')
    style.id = 'pix-direct-ptt-style'
    style.textContent = [
      '#pix-direct-ptt-entry{height:36px;flex:0 0 auto;padding:0 11px;',
      'border:1px solid rgba(37,211,102,.48);border-radius:18px;background:transparent;',
      'color:currentColor;font:600 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;',
      'cursor:pointer;white-space:nowrap;pointer-events:auto;}',
      '#pix-direct-ptt-entry:hover{border-color:#25d366;color:#25d366;}',
      '#pix-direct-ptt-entry:disabled{cursor:progress;opacity:.45;}',
      '#pix-direct-ptt-toast{position:fixed;z-index:2147483003;left:50%;bottom:142px;',
      'transform:translateX(-50%);display:none;min-width:270px;max-width:min(540px,calc(100vw - 32px));',
      'padding:11px 14px;border-radius:12px;background:rgba(17,27,33,.97);color:#e9edef;',
      'box-shadow:0 10px 34px rgba(0,0,0,.5);font:500 13px/1.45 system-ui,-apple-system,',
      '"Segoe UI",sans-serif;pointer-events:none;}',
      '#pix-direct-ptt-toast[data-show="1"]{display:block;}',
      '#pix-direct-ptt-toast[data-error="1"]{background:rgba(91,27,35,.98);color:#fff;}'
    ].join('')
    ;(document.head || document.documentElement).appendChild(style)
  }

  function ensureToast () {
    ensureStyle()
    if (toast && toast.isConnected) return toast
    toast = document.createElement('div')
    toast.id = 'pix-direct-ptt-toast'
    toast.setAttribute('data-pix-ui', 'voice-fast-toast')
    toast.setAttribute('role', 'status')
    document.documentElement.appendChild(toast)
    return toast
  }

  function status (text, error, autoHideMs) {
    lastStatus = String(text || '')
    const el = ensureToast()
    el.textContent = lastStatus
    el.dataset.show = '1'
    el.dataset.error = error ? '1' : '0'
    clearTimeout(toastTimer)
    if (autoHideMs) {
      toastTimer = setTimeout(() => { el.dataset.show = '0' }, autoHideMs)
    }
  }

  function ensureFileInput () {
    if (fileInput && fileInput.isConnected) return fileInput
    fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.accept = 'audio/*,.ogg,.opus,.mp3,.wav,.m4a,.aac,.amr,.webm'
    fileInput.multiple = false
    fileInput.style.display = 'none'
    fileInput.setAttribute('data-pix-ui', 'voice-fast-input')
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0]
      fileInput.value = ''
      if (file) sendFromUi(file)
    })
    document.documentElement.appendChild(fileInput)
    return fileInput
  }

  function openPicker () {
    if (busy) {
      status('上一段语音正在发送，请稍候', true, 3500)
      return false
    }
    const input = ensureFileInput()
    input.value = ''
    input.click()
    return true
  }

  function ensureButton () {
    const scope = footer()
    if (!scope) {
      if (button && button.parentNode) button.parentNode.removeChild(button)
      button = null
      return
    }
    if (button && button.isConnected && button.parentElement === scope) {
      button.disabled = busy
      return
    }
    if (button && button.parentNode) button.parentNode.removeChild(button)
    ensureStyle()
    button = document.createElement('button')
    button.type = 'button'
    button.id = 'pix-direct-ptt-entry'
    button.textContent = '快速语音'
    button.title = '导入音频并直接发送 WhatsApp 原生语音'
    button.setAttribute('data-pix-ui', 'voice-fast-entry')
    button.addEventListener('mousedown', event => event.stopPropagation())
    button.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      openPicker()
    })
    const voice = nativeVoiceButton()
    if (voice && voice.parentElement === scope) scope.insertBefore(button, voice)
    else scope.appendChild(button)
    button.disabled = busy
  }

  function activeChatId (chatModule) {
    if (!chatModule) return ''
    const collections = [
      chatModule.ChatCollection,
      chatModule.Chat
    ].filter(Boolean)
    let active = null
    for (const collection of collections) {
      if (typeof collection.getActive !== 'function') continue
      try {
        active = collection.getActive()
        if (active) break
      } catch (e) {}
    }
    if (!active || !active.id) return ''
    return String(active.id._serialized || active.id.serialized || active.id || '')
  }

  function activeChat (chatModule) {
    if (!chatModule) return null
    const collections = [
      chatModule.ChatCollection,
      chatModule.Chat
    ].filter(Boolean)
    for (const collection of collections) {
      if (typeof collection.getActive !== 'function') continue
      try {
        const active = collection.getActive()
        if (active) return active
      } catch (e) {}
    }
    return null
  }

  function namespaceCandidates (value) {
    const rows = []
    if (!value) return rows
    rows.push(value)
    if (value.default) rows.push(value.default)
    return rows
  }

  function getWebpackRequire () {
    if (typeof window.__pixWaWebpackRequire === 'function') {
      return window.__pixWaWebpackRequire
    }
    const chunk = window.webpackChunkwhatsapp_web_client
    if (!Array.isArray(chunk) || typeof chunk.push !== 'function') return null
    try {
      chunk.push([['pix-direct-ptt-' + Date.now()], {}, runtime => {
        if (typeof runtime === 'function') window.__pixWaWebpackRequire = runtime
      }])
    } catch (e) {}
    return typeof window.__pixWaWebpackRequire === 'function'
      ? window.__pixWaWebpackRequire
      : null
  }

  function scanNamespace (value, predicate) {
    for (const candidate of namespaceCandidates(value)) {
      if (!candidate) continue
      try {
        const found = predicate(candidate)
        if (found) return candidate
      } catch (e) {}
    }
    return null
  }

  function findInFactories (req, factoryHint, predicate) {
    if (!req || !req.m) return null
    let checked = 0
    for (const id of Object.keys(req.m)) {
      if (checked >= 40) break
      let source = ''
      try { source = Function.prototype.toString.call(req.m[id]) } catch (e) {}
      if (!source || source.indexOf(factoryHint) === -1) continue
      checked++
      try {
        const found = scanNamespace(req(id), predicate)
        if (found) return found
      } catch (e) {}
    }
    return null
  }

  function findModule (predicate, factoryHints) {
    if (typeof window.require === 'function') {
      const names = [
        'WAWebCollections',
        'WAWebMediaOpaqueData',
        'WAWebMedia',
        'WAWebMediaPrep'
      ]
      for (const name of names) {
        try {
          const found = scanNamespace(window.require(name), predicate)
          if (found) return found
        } catch (e) {}
      }
    }

    const req = getWebpackRequire()
    if (!req) return null
    const cache = req.c || {}
    for (const id of Object.keys(cache)) {
      const mod = cache[id]
      const found = scanNamespace(mod && (mod.exports === undefined ? mod : mod.exports), predicate)
      if (found) return found
    }
    for (const hint of factoryHints || []) {
      const found = findInFactories(req, hint, predicate)
      if (found) return found
    }
    return null
  }

  function loadLazyModule (name) {
    if (typeof window.requireLazy !== 'function') return Promise.resolve(null)
    return new Promise(resolve => {
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        resolve(value || null)
      }
      const timer = setTimeout(() => finish(null), 3000)
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

  async function resolveMetaModules () {
    if (typeof window.requireLazy !== 'function') return null
    const loaded = await Promise.all([
      loadLazyModule('WAWebCollections'),
      loadLazyModule('WAWebChatCollection'),
      loadLazyModule('WAWebMediaOpaqueData'),
      loadLazyModule('WAWebPrepRawMedia')
    ])
    const collections = loaded[0]
    const chatCollection = loaded[1]
    const opaque = loaded[2]
    const prepRaw = loaded[3]
    const chat = chatCollection || collections
    if (!chat || !opaque || !prepRaw) return null
    return {
      api: 'meta',
      chat,
      opaque,
      prepRaw
    }
  }

  async function resolveModules () {
    const meta = await resolveMetaModules()
    if (meta) return meta

    const chat = findModule(ns => (
      (ns.Chat && typeof ns.Chat.getActive === 'function') ||
      (ns.ChatCollection && typeof ns.ChatCollection.getActive === 'function')
    ), ['ChatCollection', 'change:active'])
    const opaque = findModule(ns => typeof ns.createFromData === 'function', [
      'createFromBase64Jpeg',
      'createFromData'
    ])
    const media = findModule(ns => (
      typeof ns.prepRawMedia === 'function' &&
      typeof ns.createFromData !== 'function'
    ), ['prepRawMedia', 'processRawAudioVideo'])
    const prep = findModule(ns => typeof ns.sendMediaMsgToChat === 'function', [
      'sendMediaMsgToChat',
      'MediaPrep'
    ])
    if (!chat || !opaque || !media || !prep) {
      const missing = []
      if (!chat) missing.push('Chat')
      if (!opaque) missing.push('MediaOpaqueData')
      if (!media) missing.push('Media')
      if (!prep) missing.push('MediaPrep')
      throw new Error('WhatsApp 内部模块不兼容，缺少：' + missing.join(', '))
    }
    return {
      api: 'webpack',
      chat,
      opaque,
      media,
      prep
    }
  }

  async function decodeAudio (file) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (!AudioContextClass) throw new Error('当前窗口不支持音频解析')
    const context = new AudioContextClass()
    try {
      const buffer = await context.decodeAudioData((await file.arrayBuffer()).slice(0))
      const samples = buffer.getChannelData(0)
      const bucketCount = 64
      const bucketSize = Math.max(1, Math.floor(samples.length / bucketCount))
      const levels = []
      for (let index = 0; index < bucketCount; index++) {
        const start = bucketSize * index
        const end = Math.min(samples.length, start + bucketSize)
        let total = 0
        for (let offset = start; offset < end; offset++) total += Math.abs(samples[offset])
        levels.push(end > start ? total / (end - start) : 0)
      }
      const max = Math.max.apply(Math, levels.concat([0]))
      const waveform = new Uint8Array(levels.map(level => (
        max ? Math.max(0, Math.min(100, Math.round(level / max * 100))) : 0
      )))
      return {
        duration: Math.max(1, Math.floor(Number(buffer.duration) || 0)),
        waveform,
        buffer,
        sampleRate: buffer.sampleRate,
        numberOfChannels: Math.max(1, buffer.numberOfChannels)
      }
    } finally {
      try { await context.close() } catch (e) {}
    }
  }

  function sendResultOk (result) {
    if (result == null) return true
    if (result.error) return false
    if (result.messageSendResult == null) return true
    return result.messageSendResult === 1 ||
      result.messageSendResult === 'OK' ||
      result.messageSendResult === 'SUCCESS'
  }

  async function sendPtt (file, resolved, fields) {
    const from = await resolved.opaque.createFromData(file, file.type)
    const prepRaw = resolved.api === 'meta' ? resolved.prepRaw : resolved.media
    const prep = prepRaw.prepRawMedia(from, {
      isPtt: true,
      asDocument: false,
      asGif: false,
      isAudio: true,
      asSticker: false,
      precomputedFields: fields
    })
    const active = activeChat(resolved.chat)
    let result
    if (prep && typeof prep.sendToChat === 'function') {
      result = await prep.sendToChat({
        chat: active,
        options: {
          addEvenWhilePreparing: false,
          isQuestion: false,
          isViewOnce: false,
          mentionedJidList: []
        }
      })
    } else if (resolved.prep && typeof resolved.prep.sendMediaMsgToChat === 'function') {
      result = await resolved.prep.sendMediaMsgToChat(prep, active, {
        addEvenWhilePreparing: false,
        caption: '',
        groupMentions: [],
        isQuestion: false,
        isViewOnce: false,
        mentionedJidList: [],
        type: 'ptt'
      })
    } else {
      throw new Error('当前 WhatsApp 版本没有可用的媒体发送方法')
    }
    if (!sendResultOk(result)) {
      throw new Error('WhatsApp 没有确认语音发送：' + JSON.stringify(result))
    }
    return { duration: fields.duration, waveform: fields.waveform, result }
  }

  function isOggOpus (file) {
    const name = String(file && file.name || '').toLowerCase()
    const type = String(file && file.type || '').toLowerCase()
    return /\.(ogg|oga|opus)$/.test(name) ||
      type.indexOf('audio/ogg') === 0 ||
      type.indexOf('audio/opus') === 0
  }

  function isAudioFile (file) {
    const name = String(file && file.name || '').toLowerCase()
    const type = String(file && file.type || '').toLowerCase()
    return type.indexOf('audio/') === 0 ||
      /\.(aac|flac|m4a|mp3|oga|ogg|opus|wav|webm)$/.test(name)
  }

  function base64ToFile (base64, type, name) {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new File([bytes], name, {
      type: type || 'audio/ogg; codecs=opus',
      lastModified: Date.now()
    })
  }

  function newRequestId () {
    return String(
      (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID()) ||
      ('pix-' + Date.now() + '-' + Math.random().toString(16).slice(2))
    )
  }

  function preloadRequest (channel, payload, transfer, timeoutMs) {
    const requestId = String(payload && payload.requestId || newRequestId())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        preloadWaiters.delete(requestId)
        reject(new Error('Opus 编码超时，请重启软件后重试'))
      }, Math.max(1000, Number(timeoutMs) || CONVERT_TIMEOUT_MS))
      preloadWaiters.set(requestId, { resolve, reject, timer })
      try {
        window.postMessage(Object.assign({
          source: 'hello-pix-page',
          channel,
          requestId
        }, payload || {}), location.origin, transfer || [])
      } catch (e) {
        clearTimeout(timer)
        preloadWaiters.delete(requestId)
        reject(e)
      }
    })
  }

  window.addEventListener('message', event => {
    if (event.source && event.source !== window) return
    const data = event.data
    if (!data || data.source !== 'hello-pix-preload' ||
      data.channel !== 'voice:opus:result') return
    const requestId = String(data.requestId || '')
    const waiter = preloadWaiters.get(requestId)
    if (!waiter) return
    preloadWaiters.delete(requestId)
    clearTimeout(waiter.timer)
    if (!data.ok) {
      waiter.reject(new Error(data.msg || 'Opus 编码失败'))
      return
    }
    waiter.resolve(data)
  })

  async function encodeOpus (file, decoded) {
    const requestId = newRequestId()
    const sampleRate = Math.max(1, Number(decoded.sampleRate) || 48000)
    const channels = Math.max(1, Number(decoded.numberOfChannels) || 1)
    const chunkSeconds = 10
    const chunkSize = Math.max(4096, Math.floor(sampleRate * chunkSeconds))
    await preloadRequest('voice:opusStart', {
      requestId,
      sampleRate,
      bitrate: 64000,
      name: file.name
    }, [], 15000)
    try {
      const source = decoded.buffer
      for (let offset = 0; offset < source.length; offset += chunkSize) {
        const end = Math.min(source.length, offset + chunkSize)
        const length = end - offset
        const mono = new Float32Array(length)
        const first = source.getChannelData(0)
        if (channels === 1) {
          mono.set(first.subarray(offset, end))
        } else {
          for (let channel = 0; channel < channels; channel++) {
            const data = source.getChannelData(channel)
            for (let index = 0; index < length; index++) {
              mono[index] += data[offset + index] / channels
            }
          }
        }
        await preloadRequest('voice:opusChunk', {
          requestId,
          samples: mono
        }, [mono.buffer], 20000)
      }
      const result = await preloadRequest('voice:opusFinish', {
        requestId,
        name: file.name
      }, [], 30000)
      if (!result.base64) throw new Error('Opus 编码没有返回音频数据')
      const baseName = String(result.name || 'voice.ogg').replace(/\.[^.]+$/, '')
      return base64ToFile(result.base64, result.type, baseName + '.ogg')
    } catch (e) {
      try {
        await preloadRequest('voice:opusCancel', { requestId }, [], 3000)
      } catch (ignore) {}
      throw e
    }
  }

  async function runFile (file) {
    if (busy) return { ok: false, msg: '上一段语音正在发送' }
    if (!file || !isAudioFile(file)) {
      return { ok: false, msg: '请选择音频文件' }
    }
    if (Number(file.size) > MAX_BYTES) {
      return { ok: false, msg: '音频超过 16MB，WhatsApp 无法作为语音消息发送' }
    }

    busy = true
    ensureButton()
    status('正在检查 WhatsApp 兼容性…')
    try {
      const resolved = await resolveModules()
      const before = activeChatId(resolved.chat)
      if (!before) throw new Error('请先打开一个聊天窗口')

      status('正在解码音频…')
      const decoded = await decodeAudio(file)
      let audio = file
      if (!isOggOpus(file)) {
        status('正在生成 OGG/Opus…')
        audio = await encodeOpus(file, decoded)
      }
      const current = await resolveModules()
      if (activeChatId(current.chat) !== before) {
        throw new Error('转换期间聊天窗口已切换，已取消发送')
      }

      status('正在发送原生语音…')
      const sent = await sendPtt(audio, current, {
        duration: decoded.duration,
        waveform: decoded.waveform
      })
      const result = {
        ok: true,
        duration: sent.duration,
        waveformBytes: sent.waveform.length,
        msg: '语音已发送'
      }
      lastResult = result
      status(result.msg, false, 2500)
      return result
    } catch (e) {
      const result = {
        ok: false,
        msg: (e && e.message) || String(e)
      }
      lastResult = result
      status(result.msg + '；请重启软件后重试', true, 7000)
      return result
    } finally {
      busy = false
      ensureButton()
    }
  }

  function sendFromUi (file) {
    runFile(file).catch(() => {})
  }

  window.__pixDirectPttStatus = function () {
    return {
      installed: true,
      busy,
      status: lastStatus,
      lastResult
    }
  }
  window.__pixDirectPttOpenPicker = openPicker
  window.__pixDirectPttSendFile = function (file) {
    return runFile(file)
  }
  if (cfg.testMode) {
    window.__pixDirectPttSendForTest = file => runFile(file)
    window.__pixDirectPttLastResult = () => lastResult
  }

  ensureButton()
  setInterval(ensureButton, 1200)
}

/**
 * 返回可直接注入页面世界的独立脚本。
 *
 * Function.prototype.toString 是边界：安装函数里不能引用本文件外部变量。
 */
function buildWhatsAppDirectPttScript (options) {
  const opts = Object.assign({}, DEFAULTS, options || {})
  return '(' + installWhatsAppDirectPtt.toString() + ')(' + JSON.stringify(opts) + ');'
}

module.exports = {
  buildWhatsAppDirectPttScript,
  DEFAULTS
}
