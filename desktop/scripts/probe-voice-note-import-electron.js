'use strict'

/**
 * 验证「外部 OGG/Opus → 虚拟麦克风 MediaStream → MediaRecorder」在 Electron
 * 里是否成立。
 *
 * 这不是 WhatsApp 集成测试，也不会发送任何消息。它只证明浏览器层能：
 *   1. 解码本地 OGG/Opus；
 *   2. 从 MediaStreamAudioDestinationNode 产出可录制的音轨；
 *   3. 被 MediaRecorder 录成 Opus；
 *   4. 产出的 blob 时长与源音频一致。
 *
 * WhatsApp 的 PTT 发送仍必须由它自己的录音 UI 完成。本探针只排除“虚拟音轨
 * 根本录不到声音”这个最危险的未知项。
 */

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const sourcePath = process.env.PIX_VOICE_PROBE_FILE || '/Users/dongni/Desktop/群异常解释  刚来的.ogg'

function fail (message) {
  console.error('VOICE_PROBE_FAIL ' + message)
  app.exit(1)
}

app.whenReady().then(async () => {
  let bytes
  try {
    bytes = fs.readFileSync(sourcePath)
  } catch (e) {
    fail('无法读取源音频：' + e.message)
    return
  }

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      backgroundThrottling: false
    }
  })

  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!doctype html><html><body><script>window.__voiceProbeResult = null</script></body></html>'
    ))

    const result = await win.webContents.executeJavaScript(`
      (async function () {
        const encoded = ${JSON.stringify(bytes.toString('base64'))}
        const raw = atob(encoded)
        const input = new Uint8Array(raw.length)
        for (let i = 0; i < raw.length; i++) input[i] = raw.charCodeAt(i)

        const AC = window.AudioContext || window.webkitAudioContext
        if (!AC) return { ok: false, reason: 'NO_AUDIO_CONTEXT' }
        if (!window.MediaRecorder) return { ok: false, reason: 'NO_MEDIA_RECORDER' }

        const ctx = new AC({ sampleRate: 48000 })
        try {
          await ctx.resume()
          const decoded = await ctx.decodeAudioData(input.buffer.slice(0))
          const destination = ctx.createMediaStreamDestination()
          destination.channelCount = 1
          destination.channelCountMode = 'explicit'
          destination.channelInterpretation = 'speakers'

          const source = ctx.createBufferSource()
          source.buffer = decoded
          source.connect(destination)

          const mimeCandidates = [
            'audio/ogg;codecs=opus',
            'audio/webm;codecs=opus',
            'audio/webm'
          ]
          const mimeType = mimeCandidates.find(type => MediaRecorder.isTypeSupported(type)) || ''
          const recorder = new MediaRecorder(destination.stream, mimeType ? { mimeType } : undefined)
          const chunks = []
          recorder.ondataavailable = event => { if (event.data && event.data.size) chunks.push(event.data) }

          const stopped = new Promise(resolve => { recorder.onstop = resolve })
          recorder.start()
          source.start()

          // 只录前 1.5 秒，足以证明音轨确实有内容；完整时长在真机上反而拖慢探针。
          await new Promise(resolve => setTimeout(resolve, 1500))
          recorder.stop()
          source.stop()
          await stopped

          const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'application/octet-stream' })
          const output = new Uint8Array(await blob.arrayBuffer())
          return {
            ok: output.length > 0,
            decodedDuration: decoded.duration,
            decodedChannels: decoded.numberOfChannels,
            decodedSampleRate: decoded.sampleRate,
            recorderMime: recorder.mimeType || mimeType || '',
            outputBytes: output.length,
            contextState: ctx.state
          }
        } finally {
          try { await ctx.close() } catch (e) {}
        }
      })()
    `)

    if (!result || !result.ok) fail(JSON.stringify(result))
    else console.log('VOICE_PROBE_OK ' + JSON.stringify(result))
    win.destroy()
    app.exit(0)
  } catch (e) {
    fail((e && e.stack) || String(e))
  }
})
