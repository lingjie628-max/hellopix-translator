'use strict'

/**
 * 真 Chromium 验收：外部音频拖入 → 虚拟麦克风 → MediaRecorder → 原生发送按钮。
 *
 * 页面是 WhatsApp 录音 composer 的最小复刻，**不连接 WhatsApp、不发送任何
 * 网络消息**。它证明页面世界脚本能完成真实事件、真实 MediaStream 和真实
 * MediaRecorder 的整条链路，而不是只检查源码字符串。
 */

const { app, BrowserWindow } = require('electron')
const { buildVoiceNoteImportScript } = require('../src/translate/voice-note-import')

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

function makeWav (seconds) {
  const sampleRate = 48000
  const channels = 1
  const bits = 16
  const frames = Math.floor(sampleRate * seconds)
  const dataBytes = frames * channels * bits / 8
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * channels * bits / 8, 28)
  buf.writeUInt16LE(channels * bits / 8, 32)
  buf.writeUInt16LE(bits, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 12000)
    buf.writeInt16LE(sample, 44 + i * 2)
  }
  return buf
}

function fail (message) {
  console.error('VOICE_IMPORT_VERIFY_FAIL ' + message)
  app.exit(1)
}

app.whenReady().then(async () => {
  const wav = makeWav(1.2)
  const hostScript = buildVoiceNoteImportScript({
    hostname: 'web.whatsapp.com',
    playbackRate: 4,
    startTimeoutMs: 3000,
    stopTimeoutMs: 3000,
    sendTimeoutMs: 3000,
    postSendTimeoutMs: 3000
  })

  const html = `<!doctype html>
<html>
<head>
  <style>
    html,body{margin:0;width:900px;height:700px}
    #main{width:900px;height:700px;display:flex;flex-direction:column}
    #messages{flex:1}
    footer{display:flex;align-items:center;gap:8px;height:64px;padding:8px}
    [contenteditable]{flex:1;min-height:40px;border:1px solid #999}
    button{width:48px;height:40px}
  </style>
</head>
<body>
  <div id="main">
    <div id="messages"></div>
    <footer>
      <div contenteditable="true" role="textbox" aria-label="Type a message"></div>
      <button id="mic" data-icon="ptt" aria-label="Voice message">mic</button>
      <button id="send" data-icon="send" aria-label="Send voice message" style="display:none">send</button>
    </footer>
  </div>
  <script>
    // data: URL 不是安全上下文，Chromium 不暴露 navigator.mediaDevices。
    // 用最小替身模拟真实 WhatsApp 页面的接口形状；脚本会临时覆盖它的
    // getUserMedia，并在一-shot 使用后恢复。
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => { throw new Error('physical microphone must not be used') }
      }
    })
    window.__sent = null
    window.__recorderState = 'idle'
    let stream = null
    let recorder = null
    let chunks = []
    let recorded = null
    const mic = document.getElementById('mic')
    const send = document.getElementById('send')

    mic.addEventListener('click', async () => {
      if (window.__recorderState === 'idle') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        chunks = []
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm'
        recorder = new MediaRecorder(stream, { mimeType })
        recorder.ondataavailable = event => { if (event.data && event.data.size) chunks.push(event.data) }
        recorder.start()
        window.__recorderState = 'recording'
        mic.setAttribute('aria-label', 'Stop voice recording')
        mic.dataset.icon = 'stop'
        return
      }
      if (window.__recorderState === 'recording') {
        const stopped = new Promise(resolve => { recorder.onstop = resolve })
        recorder.stop()
        stream.getTracks().forEach(track => track.stop())
        await stopped
        recorded = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        window.__recorderState = 'preview'
        mic.style.display = 'none'
        send.style.display = ''
      }
    })

    send.addEventListener('click', () => {
      window.__sent = {
        size: recorded ? recorded.size : 0,
        type: recorded ? recorded.type : '',
        state: window.__recorderState
      }
      window.__recorderState = 'sent'
      send.style.display = 'none'
      const row = document.createElement('div')
      row.setAttribute('data-id', 'out-1')
      row.textContent = 'Sent voice message'
      document.getElementById('messages').appendChild(row)
    })
  </script>
</body>
</html>`

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { backgroundThrottling: false }
  })

  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    await win.webContents.executeJavaScript(hostScript)

    const result = await win.webContents.executeJavaScript(`
      (async function () {
        const raw = atob(${JSON.stringify(wav.toString('base64'))})
        const bytes = new Uint8Array(raw.length)
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
        const file = new File([bytes], 'external-recording.wav', { type: 'audio/wav' })
        const transfer = new DataTransfer()
        transfer.items.add(file)
        const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
        document.querySelector('#main').dispatchEvent(drop)
        const started = Date.now()
        while (Date.now() - started < 12000) {
          const status = window.__pixVoiceImportStatus()
          if (window.__recorderState === 'sent' && status && !status.busy) {
            return {
              ok: !!window.__sent && window.__sent.size > 0,
              prevented: drop.defaultPrevented,
              sent: window.__sent,
              status: status,
              mediaGetUserMediaRestored: !String(navigator.mediaDevices.getUserMedia).includes('fakeGetUserMedia')
            }
          }
          await new Promise(resolve => setTimeout(resolve, 80))
        }
        return {
          ok: false,
          prevented: drop.defaultPrevented,
          sent: window.__sent,
          state: window.__recorderState,
          status: window.__pixVoiceImportStatus ? window.__pixVoiceImportStatus() : null
        }
      })()
    `)

    if (!result || !result.ok) {
      fail(JSON.stringify(result))
      return
    }
    if (!result.prevented) {
      fail('drop 事件没有阻止 WhatsApp 的普通文件上传')
      return
    }
    if (!/^audio\/(webm|ogg)/.test(result.sent.type)) {
      fail('没有录出 Opus 容器：' + result.sent.type)
      return
    }
    if (!result.mediaGetUserMediaRestored) {
      fail('临时 getUserMedia 没恢复')
      return
    }
    console.log('VOICE_IMPORT_VERIFY_OK ' + JSON.stringify(result))
    win.destroy()
    app.exit(0)
  } catch (e) {
    fail((e && e.stack) || String(e))
  }
})
