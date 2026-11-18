'use strict'

/**
 * 只读探针：检查当前官方 web.whatsapp.com 的 Webpack 运行时能否按能力找到
 * PTT 发送所需的内部模块。不登录、不发消息、不改页面持久状态。
 */

const electron = require('electron')
const { app, BrowserWindow, ipcMain, session, net, protocol } = electron
const { buildWhatsAppDirectPttScript } = require('../src/translate/whatsapp-direct-ptt')
const { buildHostScript } = require('../src/translate/page-world-inject')
const { VoiceOpusSession } = require('../src/translate/voice-opus-encode')
const pixProtocol = require('../src/translate/pix-protocol')
const pageWorldInject = require('../src/translate/page-world-inject')
const path = require('node:path')
const fs = require('node:fs')

const URL = 'https://web.whatsapp.com/'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

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

if (process.env.PIX_PROBE_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.PIX_PROBE_USER_DATA))
}

const useScriptTagInjection = process.env.PIX_PROBE_SCRIPT_TAG === '1'
let pageScriptUrls = null
if (useScriptTagInjection) pixProtocol.registerPrivilegedScheme(electron)

const encodeSessions = new Map()
ipcMain.on('translate:pageScripts', event => { event.returnValue = pageScriptUrls })
ipcMain.handle('translate:guestPrefs', () => ({
  transRecv: true,
  transSend: true,
  transGroup: false,
  langMine: 'zh',
  langOther: 'auto',
  sendTo: 'en'
}))
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
  if (p.action === 'chunk') return { success: true, samples: session.push(p.samples) }
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
      name: String(p.name || 'voice').replace(/\.[^.]+$/, '') + '.ogg',
      type: 'audio/ogg; codecs=opus',
      bytes: output.length
    }
  }
  return { success: false, msg: 'unknown action' }
})
ipcMain.handle('customer:ingest', () => null)
ipcMain.handle('device:peer', () => null)

function fail (message) {
  console.error('WHATSAPP_DIRECT_PTT_PROBE_FAIL ' + message)
  app.exit(1)
}

app.whenReady().then(async () => {
  const partition = process.env.PIX_PROBE_PARTITION ||
    ('persist:pix-direct-ptt-probe-' + Date.now())
  const ses = session.fromPartition(partition)
  if (useScriptTagInjection) {
    pageScriptUrls = pageWorldInject.writePageWorldScripts({
      ses,
      electron,
      log: msg => console.warn('[probe-pageworld] ' + msg)
    })
    pixProtocol.attachHandler(electron, ses, pageWorldInject.pageWorldDir())
  }
  ses.setUserAgent(UA)
  const scriptUrls = new Set()
  ses.webRequest.onCompleted(details => {
    if (details && /^https:\/\/static\.whatsapp\.net\/.*\.js(?:\?|$)/.test(String(details.url || ''))) {
      scriptUrls.add(details.url)
    }
  })
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      partition,
      preload: path.join(__dirname, '..', 'guest-inject.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })

  try {
    win.webContents.setUserAgent(UA)
    await win.loadURL(URL)
    await new Promise(resolve => setTimeout(resolve, 12000))
    const result = await win.webContents.executeJavaScript(`
      (async function () {
        try {
        const lazyResults = {}
        if (typeof window.requireLazy === 'function') {
          const names = [
            'WAWebCollections',
            'WAWebChatCollection',
            'WAWebUserPrefsMeUser',
            'WAWebFindChatAction',
            'WAWebWidFactory',
            'WAWebCmd',
            'WAWebMediaOpaqueData',
            'WAWebPrepRawMedia',
            'WAWebMediaPrepSendToChat'
          ]
          for (const name of names) {
            try {
              window.requireLazy([name], function (mod) {
                const values = [mod, mod && mod.default].filter(Boolean)
                lazyResults[name] = {
                  ok: true,
                  createFromData: values.some(value => typeof value.createFromData === 'function'),
                  prepRawMedia: values.some(value => typeof value.prepRawMedia === 'function'),
                  sendMediaMsgToChat: values.some(value => typeof value.sendMediaMsgToChat === 'function'),
                  chatGetActive: values.some(value => (
                    typeof (value.Chat && value.Chat.getActive) === 'function' ||
                    typeof (value.ChatCollection && value.ChatCollection.getActive) === 'function'
                  )),
                  keys: [...new Set(values.flatMap(value => {
                    try { return Object.keys(value) } catch (e) { return [] }
                  }))].slice(0, 60)
                }
              })
            } catch (e) {
              lazyResults[name] = { ok: false, msg: e && e.message }
            }
          }
          await new Promise(resolve => setTimeout(resolve, 500))
        }
        const metaReady = !!(
          lazyResults.WAWebChatCollection &&
          lazyResults.WAWebChatCollection.chatGetActive &&
          lazyResults.WAWebMediaOpaqueData &&
          lazyResults.WAWebMediaOpaqueData.createFromData &&
          lazyResults.WAWebPrepRawMedia &&
          lazyResults.WAWebPrepRawMedia.prepRawMedia
        )
        let safeContext = null
        if (typeof window.requireLazy === 'function') {
          const load = name => new Promise(resolve => {
            try { window.requireLazy([name], resolve) } catch (e) { resolve(null) }
          })
          const [meUser, chatCollection, cmd] = await Promise.all([
            load('WAWebUserPrefsMeUser'),
            load('WAWebChatCollection'),
            load('WAWebCmd')
          ])
          const findAction = await load('WAWebFindChatAction')
          try {
            const me = meUser && meUser.getMaybeMePnUser && meUser.getMaybeMePnUser()
            const chats = chatCollection && chatCollection.ChatCollection &&
              chatCollection.ChatCollection.getModelsArray
              ? chatCollection.ChatCollection.getModelsArray()
              : []
            const selfChat = chats.find(chat => (
              me && chat && chat.id && me.equals && me.equals(chat.id)
            )) || chats.find(chat => (
              me && chat && chat.id &&
              String(me.user || '') === String(chat.id.user || '') &&
              String(me.server || '') === String(chat.id.server || '')
            ))
            const cmdObject = cmd && cmd.Cmd
            let blobWorker = false
            try {
              const workerUrl = URL.createObjectURL(new Blob([
                'self.onmessage=function(){self.postMessage("ok")}'
              ], { type: 'text/javascript' }))
              const worker = new Worker(workerUrl)
              worker.terminate()
              URL.revokeObjectURL(workerUrl)
              blobWorker = true
            } catch (e) {}
            safeContext = {
              hasMe: !!me,
              hasSelfChat: !!selfChat,
              blobWorker,
              chatCount: chats.length,
              cmdMethods: cmdObject ? [
                ...Object.keys(cmdObject),
                ...Object.getOwnPropertyNames(Object.getPrototypeOf(cmdObject) || {})
              ].filter((value, index, rows) => rows.indexOf(value) === index).slice(0, 160) : [],
              cmdImplMethods: cmd && cmd.CmdImpl ? [
                ...Object.keys(cmd.CmdImpl),
                ...Object.getOwnPropertyNames(cmd.CmdImpl.prototype || {})
              ].filter((value, index, rows) => rows.indexOf(value) === index).slice(0, 200) : [],
              findOrCreateSource: findAction && typeof findAction.findOrCreateLatestChat === 'function'
                ? Function.prototype.toString.call(findAction.findOrCreateLatestChat).slice(0, 1200)
                : '',
              openChatBottomSource: cmdObject && typeof cmdObject.openChatBottom === 'function'
                ? Function.prototype.toString.call(cmdObject.openChatBottom).slice(0, 1200)
                : '',
              chatMethods: selfChat ? [
                ...Object.keys(selfChat),
                ...Object.getOwnPropertyNames(Object.getPrototypeOf(selfChat) || {})
              ].filter((value, index, rows) => rows.indexOf(value) === index).slice(0, 160) : []
            }
          } catch (e) {
            safeContext = { error: e && e.message }
          }
        }
        const chunk = window.webpackChunkwhatsapp_web_client
        if (!Array.isArray(chunk) || typeof chunk.push !== 'function') {
          return {
            ok: metaReady,
            api: metaReady ? 'meta' : 'unknown',
            metaReady,
            msg: 'webpack chunk 不存在',
            runtimeDebug: {
              url: location.href,
              title: document.title,
              requireLazy: typeof window.requireLazy,
              lazyResults,
              safeContext
            }
          }
        }
        let req = null
        let pushReturn = null
        try {
          pushReturn = chunk.push([['pix-probe-' + Date.now()], {}, runtime => { req = runtime }])
        } catch (e) {}
        const runtimeDebug = {
          url: location.href,
          title: document.title,
          requireLazy: typeof window.requireLazy,
          requireLazySource: typeof window.requireLazy === 'function'
            ? Function.prototype.toString.call(window.requireLazy).slice(0, 1200)
            : '',
          lazyResults,
          safeContext,
          bodyText: String(document.body && document.body.innerText || '').slice(0, 500),
          scripts: Array.from(document.scripts).map(script => script.src).filter(Boolean).slice(0, 20),
          chunkLength: chunk.length,
          pushSource: Function.prototype.toString.call(chunk.push).slice(0, 1200),
          pushReturn,
          webpackGlobals: Object.keys(window).filter(key => /webpack/i.test(key)).slice(0, 20),
          chunks: chunk.slice(0, 6).map((entry, index) => ({
            index,
            isArray: Array.isArray(entry),
            length: entry && entry.length,
            ids: Array.isArray(entry && entry[0]) ? entry[0].slice(0, 8) : null,
            moduleType: typeof (entry && entry[1]),
            moduleKeys: entry && entry[1] && typeof entry[1] === 'object'
              ? Object.keys(entry[1]).slice(0, 12)
              : null,
            moduleCount: entry && entry[1] && typeof entry[1] === 'object'
              ? Object.keys(entry[1]).length
              : null,
            runtimeType: typeof (entry && entry[2])
          }))
        }
        if (!req) {
          return {
            ok: metaReady,
            api: metaReady ? 'meta' : 'unknown',
            metaReady,
            msg: '没有捕获到 webpack require',
            runtimeDebug
          }
        }

        const cacheCount = Object.keys(req.c || {}).length
        const factories = Object.keys(req.m || {})
        const hints = {
          media: 'prepRawMedia',
          mediaPrep: 'sendMediaMsgToChat',
          opaque: 'createFromBase64Jpeg'
        }
        const hits = {}
        for (const [name, hint] of Object.entries(hints)) {
          hits[name] = []
          for (const id of factories) {
            let source = ''
            try { source = Function.prototype.toString.call(req.m[id]) } catch (e) {}
            if (!source.includes(hint)) continue
            let keys = []
            try {
              const exports = req(id)
              keys = [exports, exports && exports.default]
                .filter(Boolean)
                .flatMap(value => {
                  try { return Object.keys(value) } catch (e) { return [] }
                })
            } catch (e) {}
            hits[name].push({ id, keys: [...new Set(keys)].slice(0, 40) })
            if (hits[name].length >= 8) break
          }
        }
        return {
          ok: metaReady || Object.values(hits).every(rows => rows.length > 0),
          api: metaReady ? 'meta' : 'unknown',
          metaReady,
          url: location.href,
          title: document.title,
          runtimeDebug,
          cacheCount,
          factoryCount: factories.length,
          hits
        }
        } catch (error) {
          return {
            ok: false,
            msg: '探针执行失败：' + ((error && error.stack) || String(error))
          }
        }
      })()
    `)
    const scriptHints = {}
    for (const pattern of ['prepRawMedia', 'sendMediaMsgToChat', 'createFromBase64Jpeg']) {
      scriptHints[pattern] = []
      for (const url of scriptUrls) {
        try {
          const response = await net.fetch(url, { credentials: 'omit' })
          if (!response.ok) continue
          const text = await response.text()
          let from = 0
          while (scriptHints[pattern].length < 8) {
            const index = text.indexOf(pattern, from)
            if (index < 0) break
            const moduleStart = text.lastIndexOf('__d("', index)
            const nameMatch = moduleStart >= 0
              ? text.slice(moduleStart, moduleStart + 320).match(/^__d\("([^"]+)"/)
              : null
            scriptHints[pattern].push({
              moduleName: nameMatch ? nameMatch[1] : '',
              url,
              snippet: text.slice(Math.max(0, index - 180), index + 300)
            })
            from = index + pattern.length
          }
        } catch (e) {}
        if (scriptHints[pattern].length >= 8) break
      }
    }
    result.scriptHints = scriptHints
    result.scriptCount = scriptUrls.size
    if (process.env.PIX_PROBE_OPEN_SELF === '1') {
      result.selfChatOpen = await win.webContents.executeJavaScript(`
        (async function () {
          const load = name => new Promise(resolve => {
            try { window.requireLazy([name], resolve) } catch (e) { resolve(null) }
          })
          const [meUser, findAction, cmd] = await Promise.all([
            load('WAWebUserPrefsMeUser'),
            load('WAWebFindChatAction'),
            load('WAWebCmd')
          ])
          const me = meUser && meUser.getMaybeMePnUser()
          if (!me) return { ok: false, msg: '没有当前登录账号' }
          const found = await findAction.findOrCreateLatestChat(me, 'pixDirectPttProbe')
          const chat = found && (found.chat || found)
          if (!chat) return { ok: false, msg: '没有创建自己的聊天' }
          try {
            await cmd.Cmd.openChatBottom({ chat })
          } catch (e) {
            cmd.Cmd.openChatAt(chat)
          }
          await new Promise(resolve => setTimeout(resolve, 1200))
          return { ok: true, hasHeader: !!document.querySelector('#main header') }
        })()
      `)
    }
    if (useScriptTagInjection) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      result.scriptTagHost = await win.webContents.executeJavaScript(`
        ({
          pageHost: !!window.__pixPageHostInstalled,
          directInstalled: !!window.__pixDirectPttInstalled,
          voiceImportInstalled: !!window.__pixVoiceNoteImportInstalled,
          directButton: !!document.querySelector('[data-pix-ui="voice-fast-entry"]'),
          importButton: !!document.querySelector('[data-pix-ui="voice-import-entry"]'),
          tags: Array.from(document.querySelectorAll('script[data-pix]')).map(el => ({ name: el.getAttribute('data-pix'), src: el.src }))
        })
      `)
      result.ok = !!(result.metaReady && result.scriptTagHost.directButton && result.scriptTagHost.importButton)
      console.log('WHATSAPP_DIRECT_PTT_PROBE_RESULT ' + JSON.stringify(result))
      win.destroy()
      app.exit(result.ok ? 0 : 2)
      return
    }
    try {
      const fullHost = process.env.PIX_PROBE_FULL_HOST === '1'
      await win.webContents.executeJavaScript(fullHost
        ? buildHostScript()
        : buildWhatsAppDirectPttScript({
          hostname: 'web.whatsapp.com',
          testMode: true
        }))
      if (fullHost) {
        result.fullHost = await win.webContents.executeJavaScript(`
          ({
            pageHost: !!window.__pixPageHostInstalled,
            directInstalled: !!window.__pixDirectPttInstalled,
            voiceImportInstalled: !!window.__pixVoiceNoteImportInstalled,
            directButton: !!document.querySelector('[data-pix-ui="voice-fast-entry"]'),
            importButton: !!document.querySelector('[data-pix-ui="voice-import-entry"]')
          })
        `)
        result.ok = !!(result.metaReady && result.fullHost.directButton && result.fullHost.importButton)
        console.log('WHATSAPP_DIRECT_PTT_PROBE_RESULT ' + JSON.stringify(result))
        win.destroy()
        app.exit(result.ok ? 0 : 2)
        return
      }
      let probeBase64 = Buffer.from([79, 103, 103, 83]).toString('base64')
      let probeType = 'audio/ogg; codecs=opus'
      if (process.env.PIX_PROBE_SEND_SELF === '1') {
        const seconds = Math.max(1, Math.min(300, Number(process.env.PIX_PROBE_AUDIO_SECONDS) || 1))
        probeBase64 = makeWav(seconds).toString('base64')
        probeType = 'audio/wav'
      }
      result.directProbe = await win.webContents.executeJavaScript(`
        (async function () {
          const started = performance.now()
          const result = await window.__pixDirectPttSendForTest(new File(
            [Uint8Array.from(atob(${JSON.stringify(probeBase64)}), value => value.charCodeAt(0))],
            ${JSON.stringify(process.env.PIX_PROBE_SEND_SELF === '1' ? 'probe.wav' : 'probe.ogg')},
            { type: ${JSON.stringify(probeType)} }
          ))
          return Object.assign({}, result, { sendMs: Math.round(performance.now() - started) })
        })()
      `)
      if (process.env.PIX_PROBE_SEND_SELF === '1') {
        result.ok = !!(result.metaReady && result.directProbe && result.directProbe.ok)
        await new Promise(resolve => setTimeout(resolve, 2500))
        result.pttDom = await win.webContents.executeJavaScript(`
          (() => {
            const audios = Array.from(document.querySelectorAll('audio'))
            const rows = Array.from(document.querySelectorAll('#main [role="row"], #main .message-out'))
            const last = rows[rows.length - 1] || null
            return {
              audioElements: audios.length,
              outgoingRows: rows.length,
              lastHasVoiceButton: !!(last && last.querySelector('[data-icon*="ptt"], [aria-label*="voice" i], [aria-label*="语音"]')),
              lastText: last ? String(last.innerText || '').slice(0, 200) : ''
            }
          })()
        `)
        if (process.env.PIX_PROBE_SCREENSHOT) {
          const image = await win.webContents.capturePage()
          fs.writeFileSync(process.env.PIX_PROBE_SCREENSHOT, image.toPNG())
        }
      } else if (result.metaReady && result.directProbe &&
        /请先打开一个聊天窗口|Unable to decode audio data/.test(result.directProbe.msg || '')) {
        result.ok = true
      }
    } catch (e) {
      result.directProbe = { ok: false, msg: (e && e.message) || String(e) }
    }
    console.log('WHATSAPP_DIRECT_PTT_PROBE_RESULT ' + JSON.stringify(result))
    win.destroy()
    app.exit(result && result.ok ? 0 : 2)
  } catch (e) {
    fail((e && e.stack) || String(e))
  }
})
