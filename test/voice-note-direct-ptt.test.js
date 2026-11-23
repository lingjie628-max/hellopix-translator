'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { JSDOM } = require('jsdom')

const ROOT = path.join(__dirname, '..')
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const CHAT = {
  id: { _serialized: '8613800000000@c.us' },
  isGroup: false
}

function makeDom (options) {
  const dom = new JSDOM('<!doctype html><html><body><div id="main"><footer>' +
    '<div contenteditable="true" role="textbox" aria-label="Type a message"></div>' +
    '<button data-icon="ptt" aria-label="Voice message">mic</button>' +
    '</footer></div><div id="app"></div></body></html>', {
    url: 'https://web.whatsapp.com/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  })
  const win = dom.window
  win.AudioContext = class FakeAudioContext {
    async decodeAudioData () {
      const samples = new Float32Array(6400)
      for (let index = 0; index < samples.length; index++) {
        samples[index] = Math.sin(index / 18) * 0.5
      }
      return {
        duration: 7.8,
        length: samples.length,
        sampleRate: 48000,
        numberOfChannels: 1,
        getChannelData: () => samples
      }
    }

    close () {
      return Promise.resolve()
    }
  }
  Object.defineProperty(win, 'crypto', {
    configurable: true,
    value: { randomUUID: () => 'request-1' }
  })
  const calls = {
    createFromData: [],
    prepRawMedia: [],
    sendMediaMsgToChat: []
  }
  const opaque = { kind: 'opaque' }
  const prep = {
    type: 'ptt',
    waitForPrep: async () => prep
  }
  const modules = [
    { Chat: { getActive: () => CHAT } },
    { createFromData: async (file, type) => {
      calls.createFromData.push({ file, type })
      return opaque
    } },
    { prepRawMedia: (data, config) => {
      calls.prepRawMedia.push({ data, config })
      return prep
    } },
    { sendMediaMsgToChat: async (...args) => {
      calls.sendMediaMsgToChat.push(args)
      return { messageSendResult: 1 }
    } }
  ]
  const chunk = []
  chunk.push = data => {
    const runtime = data[2]
    const requireFn = id => ({ exports: modules[Number(id) - 1] })
    requireFn.c = Object.fromEntries(modules.map((exports, index) => [
      index + 1,
      { exports }
    ]))
    requireFn.m = {}
    runtime(requireFn)
  }
  win.webpackChunkwhatsapp_web_client = chunk

  const { buildWhatsAppDirectPttScript } = require('../desktop/src/translate/whatsapp-direct-ptt')
  win.eval(buildWhatsAppDirectPttScript(Object.assign({
    hostname: 'web.whatsapp.com',
    testMode: true
  }, options || {})))
  return { dom, win, calls, prep, opaque }
}

test('★ 极速语音脚本必须语法合法', () => {
  const { buildWhatsAppDirectPttScript } = require('../desktop/src/translate/whatsapp-direct-ptt')
  const src = buildWhatsAppDirectPttScript()
  assert.doesNotThrow(() => new Function(src))
})

test('★ 只安装到 web.whatsapp.com，入口必须带 data-pix-ui', () => {
  const { win } = makeDom()
  const button = win.document.querySelector('[data-pix-ui="voice-fast-entry"]')
  assert.ok(button, '缺少快速语音入口')
  assert.equal(button.textContent, '快速语音')
  win.close()
})

test('★ 快速语音按钮和跨入口文件选择器共用同一输入', () => {
  const { win } = makeDom()
  let clicks = 0
  win.HTMLInputElement.prototype.click = function () { clicks++ }
  win.document.querySelector('[data-pix-ui="voice-fast-entry"]').click()
  assert.equal(clicks, 1)
  assert.ok(win.document.querySelector('[data-pix-ui="voice-fast-input"]'))
  assert.equal(win.__pixDirectPttOpenPicker(), true)
  assert.equal(clicks, 2)
  win.close()
})

test('★ 跨入口送文件必须返回真实发送结果', async () => {
  const { win } = makeDom()
  const result = await win.__pixDirectPttSendFile(new win.File(['ogg'], 'voice.ogg', {
    type: 'audio/ogg; codecs=opus'
  }))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.waveformBytes, 64)
  win.close()
})

test('★ 必须从 Webpack 缓存中按能力发现模块，不能硬编码模块编号', async () => {
  const { win, calls, opaque, prep } = makeDom()
  const result = await win.__pixDirectPttSendForTest(new win.File(['ogg'], 'voice.ogg', {
    type: 'audio/ogg; codecs=opus'
  }))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(calls.createFromData.length, 1)
  assert.equal(calls.createFromData[0].type, 'audio/ogg; codecs=opus')
  assert.equal(calls.prepRawMedia[0].data, opaque)
  assert.equal(calls.prepRawMedia[0].config.isPtt, true)
  assert.equal(calls.prepRawMedia[0].config.isAudio, true)
  assert.equal(calls.prepRawMedia[0].config.precomputedFields.duration, 7)
  assert.equal(calls.prepRawMedia[0].config.precomputedFields.waveform.length, 64)
  assert.equal(calls.sendMediaMsgToChat[0][0], prep)
  assert.equal(calls.sendMediaMsgToChat[0][1], CHAT)
  win.close()
})

test('★ 当前 Meta requireLazy 版本必须走 prep.sendToChat 原生 API', async () => {
  const { win } = makeDom()
  const calls = {
    createFromData: [],
    prepRawMedia: [],
    sendToChat: []
  }
  const opaque = { kind: 'meta-opaque' }
  const prep = {
    waitForPrep: async () => prep,
    sendToChat: async payload => {
      calls.sendToChat.push(payload)
      return { messageSendResult: 1 }
    }
  }
  win.requireLazy = (names, callback) => {
    const modules = {
      WAWebCollections: { Chat: { getActive: () => CHAT } },
      WAWebChatCollection: { ChatCollection: { getActive: () => CHAT } },
      WAWebMediaOpaqueData: {
        createFromData: async (file, type) => {
          calls.createFromData.push({ file, type })
          return opaque
        }
      },
      WAWebPrepRawMedia: {
        prepRawMedia: (data, config) => {
          calls.prepRawMedia.push({ data, config })
          return prep
        }
      }
    }
    callback(modules[names[0]])
    return 1
  }
  const result = await win.__pixDirectPttSendForTest(new win.File(['ogg'], 'voice.ogg', {
    type: 'audio/ogg; codecs=opus'
  }))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(calls.createFromData.length, 1)
  assert.equal(calls.prepRawMedia[0].data, opaque)
  assert.equal(calls.prepRawMedia[0].config.isPtt, true)
  assert.equal(calls.sendToChat.length, 1)
  assert.equal(calls.sendToChat[0].chat, CHAT)
  assert.equal(calls.sendToChat[0].options.addEvenWhilePreparing, false)
  win.close()
})

test('★ WhatsApp 页面世界必须桥接当前 JID，供新版筛粉使用', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'src', 'translate', 'whatsapp-direct-ptt.js'), 'utf8')
  assert.match(src, /data-pix-wa-peer/)
  assert.match(src, /publishActiveChatIdentity/)
  assert.match(src, /activeChatId/)
})

test('★ 页面世界身份桥能真实写出当前 JID', async () => {
  const { win } = makeDom()
  try {
    await win.__pixDirectPttIdentityRefresh()
    assert.equal(win.document.documentElement.getAttribute('data-pix-wa-peer'), CHAT.id._serialized)
  } finally {
    win.close()
  }
})

test('★ MP3/WAV 必须先解码、分块编码为 OGG/Opus，再按 PTT 发送', async () => {
  const { win, calls } = makeDom()
  try {
    const seen = []
    win.addEventListener('message', event => {
      const data = event.data
      if (!data || data.source !== 'hello-pix-page') return
      seen.push(data.channel)
      const base = {
        source: 'hello-pix-preload',
        channel: 'voice:opus:result',
        requestId: data.requestId,
        ok: true
      }
      if (data.channel === 'voice:opusFinish') {
        base.base64 = Buffer.from('OggS-test').toString('base64')
        base.name = 'voice.ogg'
        base.type = 'audio/ogg; codecs=opus'
      } else if (data.channel === 'voice:opusChunk') {
        base.samples = data.samples.length
      }
      win.postMessage(base, 'https://web.whatsapp.com')
    })
    const result = await win.__pixDirectPttSendForTest(new win.File(
      [new Uint8Array([1, 2, 3])],
      'voice.wav',
      { type: 'audio/wav' }
    ))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(seen, [
      'voice:opusStart',
      'voice:opusChunk',
      'voice:opusFinish'
    ])
    assert.equal(calls.createFromData[0].type, 'audio/ogg; codecs=opus')
    assert.equal(calls.prepRawMedia[0].config.precomputedFields.duration, 7)
    assert.equal(calls.prepRawMedia[0].config.precomputedFields.waveform.length, 64)
  } finally {
    win.close()
  }
})

test('★ 内部模块不可用时必须失败关闭，不能改走普通文件上传', async () => {
  const { win } = makeDom()
  delete win.webpackChunkwhatsapp_web_client
  const result = await win.__pixDirectPttSendForTest(new win.File(['x'], 'voice.ogg', {
    type: 'audio/ogg; codecs=opus'
  }))
  assert.equal(result.ok, false)
  assert.match(result.msg, /内部模块|兼容/)
  win.close()
})

test('★ 页面宿主必须接入极速语音脚本', () => {
  const src = read('desktop/src/translate/page-world-inject.js')
  assert.match(src, /buildWhatsAppDirectPttScript/)
  assert.match(src, /whatsapp-direct-ptt/)
})

test('★ 客页 preload 必须提供受限的音频转 OGG 通道', () => {
  const presrc = read('desktop/guest-inject.js')
  const ipsrc = read('desktop/src/ipc/translate.js')
  assert.match(presrc, /voice:opusStart/)
  assert.match(presrc, /hello-pix-page/)
  assert.match(ipsrc, /translate:voiceOpus/)
  assert.match(ipsrc, /trustedTabSender/)
})
