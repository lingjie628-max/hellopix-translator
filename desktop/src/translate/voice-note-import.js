'use strict'

/**
 * 把外部录音通过 WhatsApp 自己的录音入口发成原生语音消息（PTT）。
 *
 * ## 为什么不能直接把 .ogg 当文件上传
 *
 * WhatsApp 的 DOM 里有两类完全不同的媒体：
 *   · AUDIO —— 普通音频文件，气泡里是耳机图标 + 进度条；
 *   · PTT   —— 语音消息，气泡里是波形 + 麦克风。
 *
 * 文件选择器只能创建 AUDIO。即使文件本身已经是 `audio/ogg; codecs=opus`，
 * 它也不会自动变成 PTT。PTT 的协议字段、时长和波形由 WhatsApp 录音链路生成。
 *
 * ## 采用方案：虚拟麦克风
 *
 * 用户把外部音频拖进聊天后：
 *   1. 拦住 WhatsApp 的“当普通文件上传”默认行为；
 *   2. 用 Web Audio 把音频接到 `MediaStreamAudioDestinationNode`；
 *   3. 临时让一次 `getUserMedia({audio:true})` 返回这条虚拟音轨；
 *   4. 点击 WhatsApp 自己的麦克风按钮，让它按正常录音流程编码和上传；
 *   5. 音频播完后点停止，再点发送。
 *
 * 这条路不访问 WhatsApp 内部 Store、不伪造消息协议，也不会把音频上传到
 * 我们自己的服务器。最后发出去的字节、时长、波形都由 WhatsApp 自己生成。
 *
 * ## 代价
 *
 * 录制必须按真实时长播放，25 秒录音就需要约 25 秒。不能加速，否则语音会
 * 变调；也不应该用离线伪造，因为那会回到碰内部协议的封号高危路线。
 *
 * ## 失败时绝不“尽力发出去”
 *
 * 任一步找不到原生录音控件，都只提示用户，不调用任何伪造发送。最坏情况是
 * WhatsApp 里留下一个可手动删除的语音预览，而不是发出未知类型或错误内容。
 */

const DEFAULTS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  startTimeoutMs: 5000,
  manualStartTimeoutMs: 60000,
  stopTimeoutMs: 5000,
  sendTimeoutMs: 5000,
  postSendTimeoutMs: 15000,
  playbackRate: 1
})

/**
 * 页面世界安装函数。
 *
 * `Function.prototype.toString()` 会把它完整送进页面世界；因此这里不能引用
 * 本文件外部的任何变量。所有依赖只能来自参数或浏览器全局对象。
 */
function installVoiceNoteImport (options) {
  if (window.__pixVoiceNoteImportInstalled) return
  window.__pixVoiceNoteImportInstalled = true

  const cfg = options || {}
  const HOSTNAME = String(cfg.hostname || location.hostname || '').toLowerCase()
  // 只影响 WhatsApp Web。项目还支持 Telegram/LINE 等，那里没有相同的录音 UI。
  if (HOSTNAME !== 'web.whatsapp.com') return

  const MAX_BYTES = Number(cfg.maxBytes) || 16 * 1024 * 1024
  const START_TIMEOUT_MS = Number(cfg.startTimeoutMs) || 5000
  const MANUAL_START_TIMEOUT_MS = Number(cfg.manualStartTimeoutMs) || 60000
  const STOP_TIMEOUT_MS = Number(cfg.stopTimeoutMs) || 5000
  const SEND_TIMEOUT_MS = Number(cfg.sendTimeoutMs) || 5000
  const POST_SEND_TIMEOUT_MS = Number(cfg.postSendTimeoutMs) || 15000
  const PLAYBACK_RATE = Math.max(0.5, Math.min(4, Number(cfg.playbackRate) || 1))

  let busy = false
  let session = null
  let toast = null
  let entryButton = null
  let fileInput = null
  let toastTimer = 0
  let lastStatus = ''

  function wait (ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function until (predicate, timeoutMs, intervalMs) {
    const started = Date.now()
    return new Promise(resolve => {
      const tick = () => {
        let value = null
        try { value = predicate() } catch (e) {}
        if (value) return resolve(value)
        if (Date.now() - started >= timeoutMs) return resolve(null)
        setTimeout(tick, intervalMs || 80)
      }
      tick()
    })
  }

  function visible (el) {
    if (!el || !el.isConnected) return false
    try {
      const rect = el.getBoundingClientRect()
      if (rect.width < 8 || rect.height < 8) return false
      const style = getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0
    } catch (e) {
      return false
    }
  }

  function mainScope () {
    return document.querySelector('#main')
  }

  function footerScope () {
    const main = mainScope()
    return main ? main.querySelector('footer') : null
  }

  /**
   * 当前聊天身份。只用于防止录音过程中用户切到另一个联系人后，脚本把语音
   * 发进错误会话 —— 这里不需要解析手机号，只需要同一会话内稳定。
   */
  function chatKey () {
    const main = mainScope()
    if (!main) return ''
    const header = main.querySelector('header')
    return String((header && (header.innerText || header.textContent)) || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)
  }

  function ensureStyle () {
    if (document.getElementById('pix-voice-import-style')) return
    const style = document.createElement('style')
    style.id = 'pix-voice-import-style'
    style.textContent = [
      '#pix-voice-import{position:fixed;z-index:2147483002;left:50%;bottom:92px;transform:translateX(-50%);',
      'display:none;align-items:center;gap:10px;min-width:260px;max-width:min(520px,calc(100vw - 32px));',
      'padding:11px 14px;border-radius:12px;background:rgba(17,27,33,.97);color:#e9edef;',
      'box-shadow:0 10px 34px rgba(0,0,0,.5);font:500 13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;',
      'pointer-events:none;-webkit-user-select:none;user-select:none;}',
      '#pix-voice-import[data-show="1"]{display:flex;}',
      '#pix-voice-import[data-error="1"]{background:rgba(91,27,35,.98);color:#fff;}',
      '#pix-voice-import-dot{width:9px;height:9px;flex:0 0 9px;border-radius:50%;background:#25d366;',
      'box-shadow:0 0 0 5px rgba(37,211,102,.14);}',
      '#pix-voice-import[data-recording="1"] #pix-voice-import-dot{background:#f15c6d;',
      'box-shadow:0 0 0 5px rgba(241,92,109,.16);animation:pix-voice-pulse 1s ease-in-out infinite;}',
      '#pix-voice-import[data-error="1"] #pix-voice-import-dot{background:#f15c6d;box-shadow:none;animation:none;}',
      '#pix-voice-import-text{min-width:0;overflow-wrap:anywhere;}',
      '#pix-voice-entry{height:36px;flex:0 0 auto;padding:0 11px;border:1px solid rgba(134,150,160,.35);',
      'border-radius:18px;background:transparent;color:currentColor;font:600 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;',
      'cursor:pointer;white-space:nowrap;pointer-events:auto;opacity:.86;}',
      '#pix-voice-entry:hover{border-color:rgba(37,211,102,.75);color:#25d366;opacity:1;}',
      '#pix-voice-entry:disabled{cursor:progress;opacity:.45;}',
      '@keyframes pix-voice-pulse{50%{opacity:.45;}}'
    ].join('')
    ;(document.head || document.documentElement).appendChild(style)
  }

  function ensureToast () {
    ensureStyle()
    if (toast && toast.isConnected) return toast
    toast = document.createElement('div')
    toast.id = 'pix-voice-import'
    toast.setAttribute('data-pix-ui', 'voice-import')
    toast.setAttribute('role', 'status')
    toast.innerHTML = '<span id="pix-voice-import-dot"></span><span id="pix-voice-import-text"></span>'
    document.documentElement.appendChild(toast)
    return toast
  }

  function showStatus (text, opts) {
    const o = opts || {}
    const el = ensureToast()
    lastStatus = String(text || '')
    el.querySelector('#pix-voice-import-text').textContent = lastStatus
    el.dataset.show = '1'
    el.dataset.error = o.error ? '1' : '0'
    el.dataset.recording = o.recording ? '1' : '0'
    clearTimeout(toastTimer)
    if (o.autoHideMs) toastTimer = setTimeout(hideToast, o.autoHideMs)
  }

  function hideToast () {
    clearTimeout(toastTimer)
    toastTimer = 0
    if (toast) toast.dataset.show = '0'
  }

  function ensureFileInput () {
    if (fileInput && fileInput.isConnected) return fileInput
    fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.accept = 'audio/*,.ogg,.opus,.mp3,.wav,.m4a,.aac,.amr,.webm'
    fileInput.multiple = false
    fileInput.style.display = 'none'
    fileInput.setAttribute('data-pix-ui', 'voice-import-input')
    fileInput.addEventListener('change', function () {
      const file = fileInput.files && fileInput.files[0]
      // 必须清空：用户再次选择同一个文件时，change 才会重新触发。
      fileInput.value = ''
      if (file) importAudioFile(file)
    })
    document.documentElement.appendChild(fileInput)
    return fileInput
  }

  /**
   * 在 WhatsApp 输入区常驻一个「导入语音」入口。
   *
   * 拖拽仍然是快捷路径；按钮解决两个实际问题：
   *   1. 用户不一定会把文件准确拖到聊天区域；
   *   2. 某些系统/触控板拖拽最终仍由宿主打开普通文件选择器。
   */
  function ensureEntryButton () {
    const footer = footerScope()
    if (!footer) {
      if (entryButton && entryButton.parentNode) entryButton.parentNode.removeChild(entryButton)
      entryButton = null
      return
    }
    if (entryButton && entryButton.isConnected && entryButton.parentElement === footer) {
      const direct = typeof window.__pixDirectPttStatus === 'function'
        ? window.__pixDirectPttStatus()
        : null
      entryButton.disabled = busy || !!(direct && direct.busy)
      return
    }

    if (entryButton && entryButton.parentNode) entryButton.parentNode.removeChild(entryButton)
    ensureStyle()
    entryButton = document.createElement('button')
    entryButton.id = 'pix-voice-entry'
    entryButton.type = 'button'
    entryButton.textContent = '导入语音'
    entryButton.title = '选择外部录音，按 WhatsApp 原生语音消息发送'
    entryButton.setAttribute('data-pix-ui', 'voice-import-entry')
    entryButton.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      if (busy) {
        showStatus('上一段语音还在导入，请等它结束', { error: true, autoHideMs: 3500 })
        return
      }
      if (typeof window.__pixDirectPttOpenPicker === 'function') {
        window.__pixDirectPttOpenPicker()
        return
      }
      showStatus('原生语音发送模块还没准备好，请重启软件', { error: true, autoHideMs: 5000 })
    })
    entryButton.addEventListener('mousedown', function (event) { event.stopPropagation() })

    const voice = findVoiceAction()
    if (voice && voice.parentElement === footer) footer.insertBefore(entryButton, voice)
    else footer.appendChild(entryButton)
    const direct = typeof window.__pixDirectPttStatus === 'function'
      ? window.__pixDirectPttStatus()
      : null
    entryButton.disabled = busy || !!(direct && direct.busy)
  }

  function formatDuration (seconds) {
    const total = Math.max(0, Math.ceil(Number(seconds) || 0))
    const mm = String(Math.floor(total / 60)).padStart(2, '0')
    const ss = String(total % 60).padStart(2, '0')
    return mm + ':' + ss
  }

  function actionLabel (el) {
    if (!el) return ''
    return [
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('title'),
      el.getAttribute && el.getAttribute('data-icon'),
      el.getAttribute && el.getAttribute('data-testid'),
      el.className
    ].filter(Boolean).join(' ').toLowerCase()
  }

  function clickableAction (node) {
    if (!node || !node.closest) return null
    const el = node.closest('button,[role="button"],[data-testid],[data-icon]')
    if (el && el.closest && el.closest('[data-pix-ui]')) return null
    return el && visible(el) ? el : null
  }

  function composer () {
    const footer = footerScope()
    if (!footer) return null
    return footer.querySelector('[contenteditable="true"],[role="textbox"],textarea')
  }

  /**
   * 输入框右侧最靠右的可见操作。
   *
   * 不同语言下 aria-label 完全不可靠；但 WhatsApp Web 的麦克风始终在输入框
   * 右端。使用几何位置选“最右一个”，比维护几十种语言的文案稳定。
   */
  function rightmostComposerAction () {
    const footer = footerScope()
    const box = composer()
    if (!footer || !box) return null
    const boxRect = box.getBoundingClientRect()
    const seen = []
    const nodes = footer.querySelectorAll('button,[role="button"],[data-icon],[data-testid]')
    for (let i = 0; i < nodes.length; i++) {
      const raw = nodes[i]
      const action = clickableAction(raw)
      if (!action || seen.indexOf(action) >= 0) continue
      const rect = action.getBoundingClientRect()
      if (rect.left < boxRect.right - 8) continue
      seen.push(action)
    }
    seen.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
    return seen[0] || null
  }

  function findVoiceAction () {
    const footer = footerScope()
    if (!footer) return null
    const nodes = footer.querySelectorAll('button,[role="button"],[data-icon],[data-testid]')
    for (let i = 0; i < nodes.length; i++) {
      const action = clickableAction(nodes[i])
      if (!action) continue
      const label = actionLabel(action)
      if (!label) continue
      if (/(voice|audio|mic|record|ptt|mensagem de voz|nota de voz|mensaje de voz|voz|语音|音频|录音)/i.test(label) &&
          !/(send|enviar|发送|attach|anexar|emoji|sticker|figurinha)/i.test(label)) {
        return action
      }
    }
    return rightmostComposerAction()
  }

  function findStopVoiceAction (startAction) {
    const footer = footerScope()
    if (!footer) return null
    const nodes = footer.querySelectorAll('button,[role="button"],[data-icon],[data-testid]')
    for (let i = 0; i < nodes.length; i++) {
      const action = clickableAction(nodes[i])
      if (!action) continue
      const label = actionLabel(action)
      if (/(stop.*(voice|record|audio)|(voice|record|audio).*stop|parar.*(voz|grav)|encerrar.*(voz|grav)|停止.*(录音|语音)|结束.*(录音|语音)|停止录音|结束录音)/i.test(label)) {
        return action
      }
      if (/(stop|parar|停止)/i.test(label) && /(wds-ic|icon|button|ptt|record|mic|audio)/i.test(label)) {
        return action
      }
    }
    const current = rightmostComposerAction()
    if (current && current !== startAction) return current
    return current || null
  }

  function findCancelVoiceAction () {
    const footer = footerScope()
    if (!footer) return null
    const nodes = footer.querySelectorAll('button,[role="button"],[data-icon],[data-testid]')
    for (let i = 0; i < nodes.length; i++) {
      const action = clickableAction(nodes[i])
      if (!action) continue
      if (/(cancel|cancelar|annuler|abbrechen|取消|annulla)/i.test(actionLabel(action))) {
        return action
      }
    }
    return null
  }

  function findVoiceSendAction () {
    const footer = footerScope()
    if (!footer) return null
    const nodes = footer.querySelectorAll('button,[role="button"],[data-icon],[data-testid]')
    for (let i = 0; i < nodes.length; i++) {
      const action = clickableAction(nodes[i])
      if (!action) continue
      const label = actionLabel(action)
      if (/(btn-send|compose-btn-send|data-testid="send")/i.test(label)) return action
      if (/(send|enviar|发送|envoyer|senden|invia)/i.test(label)) {
        return action
      }
    }
    const current = rightmostComposerAction()
    if (!current) return null
    const label = actionLabel(current)
    return /(send|enviar|发送|envoyer|senden|invia)/i.test(label) ? current : null
  }

  function messageRowCount () {
    const main = mainScope()
    return main ? main.querySelectorAll('[data-id]').length : 0
  }

  function restoreCapture () {
    if (!session || !session.restoreCapture) return
    try { session.restoreCapture() } catch (e) {}
    session.restoreCapture = null
  }

  function cleanupSession () {
    const current = session
    session = null
    busy = false
    if (!current) return
    current.cancelled = true
    try {
      if (current.source) {
        current.source.onended = null
        try { current.source.stop() } catch (e) {}
      }
    } catch (e) {}
    try { if (current.ctx) current.ctx.close() } catch (e) {}
    try { current.restoreCapture && current.restoreCapture() } catch (e) {}
  }

  function installVirtualMicrophone (current, decoded, ctx) {
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      throw new Error('当前浏览器没有麦克风接口')
    }

    const getDescriptor = Object.getOwnPropertyDescriptor(mediaDevices, 'getUserMedia')
    const listDescriptor = Object.getOwnPropertyDescriptor(mediaDevices, 'enumerateDevices')
    const original = mediaDevices.getUserMedia.bind(mediaDevices)
    const originalList = typeof mediaDevices.enumerateDevices === 'function'
      ? mediaDevices.enumerateDevices.bind(mediaDevices)
      : async () => []
    let used = false

    const restoreGetUserMedia = () => {
      try {
        if (getDescriptor) Object.defineProperty(mediaDevices, 'getUserMedia', getDescriptor)
        else delete mediaDevices.getUserMedia
      } catch (e) {
        try { mediaDevices.getUserMedia = original } catch (e2) {}
      }
    }
    const restoreEnumerateDevices = () => {
      try {
        if (listDescriptor) Object.defineProperty(mediaDevices, 'enumerateDevices', listDescriptor)
        else delete mediaDevices.enumerateDevices
      } catch (e) {
        try { mediaDevices.enumerateDevices = originalList } catch (e2) {}
      }
    }

    const fakeGetUserMedia = async function () {
      if (used || !current || current.cancelled) return original.apply(null, arguments)
      used = true
      // 只恢复 getUserMedia。设备列表继续保留到整次录音结束 —— WhatsApp 在
      // 拿到流之后仍可能再枚举一次，提前撤掉会让它误判“麦克风已拔出”。
      restoreGetUserMedia()

      const destination = ctx.createMediaStreamDestination()
      destination.channelCount = 1
      destination.channelCountMode = 'explicit'
      destination.channelInterpretation = 'speakers'

      const source = ctx.createBufferSource()
      source.buffer = decoded
      source.playbackRate.value = PLAYBACK_RATE
      source.connect(destination)
      current.source = source

      await ctx.resume()
      source.start()
      current.startedAt = Date.now()
      current.actualDuration = decoded.duration / PLAYBACK_RATE
      showStatus('WhatsApp 正在录入原生语音 ' + formatDuration(current.actualDuration) +
        '，请保持聊天窗口打开…', { recording: true })

      return destination.stream
    }

    /**
     * 这台机器在真实测试里**没有任何 audioinput**：默认只枚举到扬声器，
     * WhatsApp 因此在调用 getUserMedia 之前就直接弹“未找到麦克风”。
     * 外部音频更应走虚拟麦克风，所以临时把一个 audioinput 补进设备列表；
     * 设备消失即恢复原列表，不常驻修改宿主的设备能力。
     */
    const fakeEnumerateDevices = async function () {
      let list = []
      try { list = await originalList() } catch (e) {}
      list = Array.from(list || [])
      if (list.some(d => d && d.kind === 'audioinput')) return list
      const virtual = {
        kind: 'audioinput',
        label: 'Hello Pix virtual microphone',
        deviceId: 'pix-virtual-audio-input',
        groupId: 'pix-virtual-audio-input',
        toJSON: function () {
          return {
            kind: this.kind,
            label: this.label,
            deviceId: this.deviceId,
            groupId: this.groupId
          }
        }
      }
      list.push(virtual)
      return list
    }

    try {
      Object.defineProperty(mediaDevices, 'getUserMedia', {
        configurable: true,
        enumerable: getDescriptor ? getDescriptor.enumerable : true,
        writable: true,
        value: fakeGetUserMedia
      })
    } catch (e) {
      mediaDevices.getUserMedia = fakeGetUserMedia
    }
    try {
      Object.defineProperty(mediaDevices, 'enumerateDevices', {
        configurable: true,
        enumerable: listDescriptor ? listDescriptor.enumerable : true,
        writable: true,
        value: fakeEnumerateDevices
      })
    } catch (e) {
      mediaDevices.enumerateDevices = fakeEnumerateDevices
    }
    current.restoreCapture = () => {
      restoreGetUserMedia()
      restoreEnumerateDevices()
    }
  }

  async function decodeAudioFile (file, ctx) {
    const arrayBuffer = await file.arrayBuffer()
    if (!arrayBuffer || !arrayBuffer.byteLength) throw new Error('音频文件为空')
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0))
    if (!decoded || !decoded.duration || decoded.duration < 0.15) {
      throw new Error('没有识别到有效音频内容')
    }
    return decoded
  }

  function isAudioFile (file) {
    if (!file) return false
    const type = String(file.type || '').toLowerCase()
    const name = String(file.name || '').toLowerCase()
    return type.indexOf('audio/') === 0 ||
      /\.(ogg|opus|mp3|wav|m4a|aac|amr|webm)$/i.test(name)
  }

  async function importAudioFile (file, importOptions) {
    const io = importOptions || {}
    if (busy) {
      showStatus('上一段语音还在导入，请等它结束', { error: true, autoHideMs: 3500 })
      return
    }
    if (!file || !isAudioFile(file)) {
      showStatus('这里只接受音频文件', { error: true, autoHideMs: 3500 })
      return
    }
    if (file.size > MAX_BYTES) {
      showStatus('语音文件不能超过 ' + Math.round(MAX_BYTES / 1024 / 1024) + ' MB', {
        error: true,
        autoHideMs: 4500
      })
      return
    }
    if (!mainScope() || !footerScope()) {
      showStatus('请先打开一个 WhatsApp 聊天，再拖入语音文件', { error: true, autoHideMs: 4500 })
      return
    }
    if (composer() && String(composer().innerText || composer().value || '').trim()) {
      showStatus('输入框里已有文字；请先发送或清空，再导入语音', { error: true, autoHideMs: 4500 })
      return
    }

    busy = true
    if (entryButton) entryButton.disabled = true
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) {
      busy = false
      showStatus('当前环境不支持音频解码', { error: true, autoHideMs: 4500 })
      return
    }

    const ctx = new AC({ sampleRate: 48000 })
    const current = {
      file: file,
      ctx: ctx,
      decoded: null,
      source: null,
      startAction: null,
      rowCount: messageRowCount(),
      chatKey: chatKey(),
      cancelled: false
    }
    session = current

    try {
      showStatus('正在检查外部录音…')
      current.decoded = await decodeAudioFile(file, ctx)
      await ctx.resume()

      const startAction = findVoiceAction()
      if (!startAction) throw new Error('找不到 WhatsApp 的语音按钮')
      current.startAction = startAction
      installVirtualMicrophone(current, current.decoded, ctx)

      showStatus('准备以原生语音发送 ' + formatDuration(current.decoded.duration / PLAYBACK_RATE) + '…')
      if (!io.manualStart) startAction.click()
      else showStatus('语音已就绪，请点击 WhatsApp 的麦克风按钮开始导入', { recording: true })

      const started = await until(
        () => current.source && current.startedAt,
        io.manualStart ? MANUAL_START_TIMEOUT_MS : START_TIMEOUT_MS,
        80
      )
      if (!started) throw new Error('WhatsApp 没有启动录音，请确认麦克风权限可用')

      await new Promise(resolve => {
        const source = current.source
        source.onended = () => {
          current.ended = true
          resolve()
        }
        // 某些页面会暂停 AudioContext；定时检查一次，避免永久卡住。
        const watchdog = setInterval(() => {
          if (!current || current.cancelled || (current.startedAt &&
              Date.now() - current.startedAt > (current.actualDuration + 2) * 1000)) {
            clearInterval(watchdog)
            resolve()
          }
        }, 500)
        source.addEventListener('ended', () => {
          clearInterval(watchdog)
          resolve()
        }, { once: true })
      })

      if (current.cancelled) return
      if (!mainScope() || (current.chatKey && chatKey() !== current.chatKey)) {
        const cancel = findCancelVoiceAction()
        if (cancel) cancel.click()
        throw new Error('聊天窗口已切换，已取消发送')
      }
      showStatus('音频已录完，正在停止并发送…', { recording: true })
      await wait(180)

      // 新版 WhatsApp Web 在录音过程中直接显示「发送」：点它就会停止录音、
      // 生成 PTT 并发送，并不存在单独的「停止」按钮。必须优先走这一支，
      // 否则会一直录下去（真机验证时曾从 1.2 秒拖到 1 分钟以上）。
      let sendAction = await until(() => findVoiceSendAction(), 1200, 100)
      if (!sendAction) {
        const stopAction = await until(() => findStopVoiceAction(current.startAction), STOP_TIMEOUT_MS, 100)
        if (!stopAction) throw new Error('录音已结束，但没有找到 WhatsApp 的停止按钮')
        stopAction.click()
        sendAction = await until(() => findVoiceSendAction(), SEND_TIMEOUT_MS, 100)
      }

      if (sendAction) {
        sendAction.click()
        const rowChanged = await until(() => messageRowCount() > current.rowCount, POST_SEND_TIMEOUT_MS, 160)
        if (!rowChanged) {
          showStatus('已点击发送，但还没有看到新消息；请检查 WhatsApp 发送状态', {
            error: true,
            autoHideMs: 7000
          })
          return
        }
      } else {
        const rowChanged = await until(() => messageRowCount() > current.rowCount, 1200, 120)
        if (!rowChanged) {
          showStatus('录音已停止，但没有找到发送按钮；请在 WhatsApp 预览里确认后再手动发送', {
            error: true,
            autoHideMs: 9000
          })
          return
        }
      }

      showStatus('已作为 WhatsApp 原生语音消息发送', { autoHideMs: 5000 })
      if (session === current) session = null
    } catch (e) {
      current.ended = true
      // 任何失败都先尝试点 WhatsApp 自己的“取消”，绝不让一次失败的导入
      // 留在录音状态里，更不自动发送未知内容。
      try {
        const cancel = findCancelVoiceAction()
        if (cancel) cancel.click()
      } catch (cancelError) {}
      showStatus('语音导入失败：' + ((e && e.message) || e), { error: true, autoHideMs: 9000 })
    } finally {
      restoreCapture()
      if (session === current) session = null
      busy = false
      if (entryButton) entryButton.disabled = false
      // 录音流已经被 WhatsApp 接管；等发送结束再释放 AudioContext。
      setTimeout(() => {
        try { if (ctx.state !== 'closed') ctx.close() } catch (e) {}
      }, 1500)
    }
  }

  function filesFromTransfer (transfer) {
    if (!transfer) return []
    const out = []
    try {
      if (transfer.files) {
        for (let i = 0; i < transfer.files.length; i++) out.push(transfer.files[i])
      }
    } catch (e) {}
    if (out.length) return out
    try {
      const items = transfer.items || []
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind !== 'file') continue
        const file = items[i].getAsFile && items[i].getAsFile()
        if (file) out.push(file)
      }
    } catch (e) {}
    return out
  }

  function interceptFiles (event) {
    if (!event || !mainScope() || !footerScope()) return
    const target = event.target
    const main = mainScope()
    if (target && main && target !== main && !main.contains(target)) return
    const files = filesFromTransfer(event.dataTransfer || event.clipboardData)
    if (files.length !== 1 || !isAudioFile(files[0])) return
    event.preventDefault()
    event.stopPropagation()
    if (event.stopImmediatePropagation) event.stopImmediatePropagation()
    if (typeof window.__pixDirectPttSendFile === 'function') {
      try {
        const job = window.__pixDirectPttSendFile(files[0])
        if (job && typeof job.catch === 'function') job.catch(() => {})
      } catch (e) {
        showStatus('原生语音发送失败：' + ((e && e.message) || e), { error: true, autoHideMs: 7000 })
      }
      return
    }
    showStatus('原生语音发送模块还没准备好，请重启软件', { error: true, autoHideMs: 5000 })
  }

  // capture 阶段先于 WhatsApp 自己的 drop/paste handler。
  document.addEventListener('drop', interceptFiles, true)
  document.addEventListener('paste', interceptFiles, true)

  // footer 会被 WhatsApp 在换会话 / 重绘时替换，按钮必须能自愈。
  ensureEntryButton()
  setInterval(ensureEntryButton, 700)

  // 供真机探针只读观察，不暴露“直接传文件”的入口。
  window.__pixVoiceImportStatus = function () {
    return {
      installed: true,
      busy: busy,
      status: lastStatus,
      recording: !!(session && session.source && !session.ended)
    }
  }

  // 真机验收专用：让 CUA/DevTools 先用可信鼠标点麦克风，再继续自动停止和
  // 发送。生产 page-world 注入不会打开 testMode，因此不会创建这个入口。
  if (cfg.testMode === true) {
    window.__pixVoiceImportArm = function (file) {
      return importAudioFile(file, { manualStart: true })
    }
  }
}

/**
 * 生成可插入页面世界的完整脚本。
 *
 * @param {object} [options] 覆盖 DEFAULTS；测试会缩短超时或提高 playbackRate。
 * @returns {string}
 */
function buildVoiceNoteImportScript (options) {
  const merged = Object.assign({}, DEFAULTS, options || {})
  return '(' + installVoiceNoteImport.toString() + ')(' + JSON.stringify(merged) + ');'
}

module.exports = {
  DEFAULTS,
  buildVoiceNoteImportScript,
  installVoiceNoteImport
}
