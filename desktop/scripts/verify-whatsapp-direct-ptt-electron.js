'use strict'

/**
 * 真 Electron 验收：真实 preload 跨 contextIsolation 桥 + 真 FFmpeg 转码 +
 * 页面世界构造成 WhatsApp PTT。WhatsApp 媒体模块用可观察替身，不联网、不登录、
 * 不向任何联系人发消息。
 */

const { app, BrowserWindow, ipcMain, session } = require('electron')
const { buildWhatsAppDirectPttScript } = require('../src/translate/whatsapp-direct-ptt')
const { VoiceOpusSession } = require('../src/translate/voice-opus-encode')

function makeWav (seconds) {
  const sampleRate = 48000
  const frames = Math.floor(sampleRate * seconds)
  const dataBytes = frames * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < frames; index++) {
    buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 12000), 44 + index * 2)
  }
  return buf
}

function fail (message) {
  console.error('WHATSAPP_DIRECT_PTT_VERIFY_FAIL ' + message)
  app.exit(1)
}

ipcMain.on('translate:pageScripts', event => { event.returnValue = null })
ipcMain.handle('translate:guestPrefs', () => ({
  transRecv: true,
  transSend: true,
  transGroup: false,
  langMine: 'zh',
  langOther: 'auto',
  sendTo: 'en'
}))
const encodeSessions = new Map()
ipcMain.handle('translate:voiceOpus', (_event, payload) => {
  const p = payload || {}
  const key = String(p.requestId || '')
  if (!key) return { success: false, msg: 'missing request id' }
  if (p.action === 'start') {
    encodeSessions.set(key, new VoiceOpusSession({ sampleRate: p.sampleRate, bitrate: p.bitrate }))
    return { success: true }
  }
  const session = encodeSessions.get(key)
  if (!session) return { success: false, msg: 'missing session' }
  if (p.action === 'chunk') {
    return { success: true, samples: session.push(p.samples) }
  }
  encodeSessions.delete(key)
  if (p.action === 'cancel') {
    session.abort()
    return { success: true }
  }
  if (p.action === 'finish') {
    const output = session.finish()
    return {
      success: true,
      base64: output.toString('base64'),
      name: 'voice.ogg',
      type: 'audio/ogg; codecs=opus',
      bytes: output.length
    }
  }
  return { success: false, msg: 'unknown action' }
})
ipcMain.handle('customer:ingest', () => null)
ipcMain.handle('device:peer', () => null)

app.whenReady().then(async () => {
  const partition = 'persist:pix-direct-ptt-verify-' + Date.now()
  const ses = session.fromPartition(partition)
  const html = `<!doctype html><html><body>
    <div id="main"><div id="messages"></div><footer>
      <div contenteditable="true" role="textbox" aria-label="Type a message"></div>
      <button data-icon="ptt" aria-label="Voice message">mic</button>
    </footer></div>
    <script>
      const chat = { id: { _serialized: 'self@c.us' }, isGroup: false }
      window.__pttCalls = []
      window.requireLazy = function (names, callback) {
        const prep = {
          waitForPrep: async () => prep,
          sendToChat: async payload => {
            window.__pttCalls.push({
              chat: payload.chat.id._serialized,
              options: payload.options,
              lastFile: window.__lastPttFile
            })
            return { messageSendResult: 1 }
          }
        }
        const modules = {
          WAWebCollections: { Chat: { getActive: () => chat } },
          WAWebChatCollection: { ChatCollection: { getActive: () => chat } },
          WAWebMediaOpaqueData: {
            createFromData: async (file, type) => {
              window.__lastPttFile = { size: file.size, type }
              return { file, type }
            }
          },
          WAWebPrepRawMedia: {
            prepRawMedia: (data, config) => {
              window.__lastPttPrep = config
              return prep
            }
          }
        }
        callback(modules[names[0]])
        return 1
      }
    </script>
  </body></html>`
  ses.protocol.handle('https', request => {
    if (new URL(request.url).hostname !== 'web.whatsapp.com') return new Response('not found', { status: 404 })
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  })
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      partition,
      preload: require('node:path').join(__dirname, '..', 'guest-inject.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })

  try {
    await win.loadURL('https://web.whatsapp.com/')
    await win.webContents.executeJavaScript(buildWhatsAppDirectPttScript({
      hostname: 'web.whatsapp.com',
      testMode: true,
      convertTimeoutMs: 10000
    }))
    const wav64 = makeWav(1).toString('base64')
    const result = await win.webContents.executeJavaScript(`
      (async function () {
        const raw = atob(${JSON.stringify(wav64)})
        const bytes = new Uint8Array(raw.length)
        for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index)
        const file = new File([bytes], 'external.wav', { type: 'audio/wav' })
        const sent = await window.__pixDirectPttSendForTest(file)
        return {
          sent,
          calls: window.__pttCalls,
          prep: window.__lastPttPrep,
          lastFile: window.__lastPttFile,
          status: window.__pixDirectPttStatus()
        }
      })()
    `)
    if (!result.sent || !result.sent.ok) {
      fail(JSON.stringify(result))
      return
    }
    if (!result.calls || result.calls.length !== 1) {
      fail('sendToChat 没有被调用一次：' + JSON.stringify(result.calls))
      return
    }
    if (!result.lastFile || result.lastFile.type !== 'audio/ogg; codecs=opus') {
      fail('preload 桥没有返回 OGG/Opus：' + JSON.stringify(result.lastFile))
      return
    }
    if (!result.prep || result.prep.isPtt !== true ||
      !result.prep.precomputedFields ||
      result.prep.precomputedFields.waveform.length !== 64) {
      fail('PTT 配置不正确：' + JSON.stringify(result.prep))
      return
    }
    console.log('WHATSAPP_DIRECT_PTT_VERIFY_OK ' + JSON.stringify(result))
    win.destroy()
    app.exit(0)
  } catch (e) {
    fail((e && e.stack) || String(e))
  }
})
