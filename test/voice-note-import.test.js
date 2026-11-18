'use strict'

/**
 * WhatsApp 原生语音导入的架构守卫。
 *
 * 这类功能最容易走上两条错误路线：
 *   1. 只改 CSS，把耳机图标画成波形 —— 对方收到的仍然是普通音频文件；
 *   2. 直接摸 WhatsApp 内部 Store/protocol 发 `ptt:true` —— 封号高危。
 *
 * 当前实现只借 WhatsApp 自己的录音按钮：外部音频变成虚拟麦克风，编码、
 * 时长、波形和上传都由 WhatsApp 完成。本文件把这条边界钉死。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { JSDOM } = require('jsdom')

const ROOT = path.join(__dirname, '..')
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('★ 语音导入脚本必须语法合法', () => {
  const { buildVoiceNoteImportScript } = require('../desktop/src/translate/voice-note-import')
  const src = buildVoiceNoteImportScript()
  assert.doesNotThrow(() => new Function(src))
})

test('★ 必须随页面世界宿主脚本一起注入，不能只放源码不接线', () => {
  const { buildHostScript } = require('../desktop/src/translate/page-world-inject')
  const src = buildHostScript()
  assert.match(src, /__pixVoiceNoteImportInstalled/, '宿主脚本里没有语音导入安装器')
  assert.match(src, /MediaStreamAudioDestinationNode|createMediaStreamDestination/, '缺少虚拟麦克风')
})

test('★ 只影响 web.whatsapp.com，不能碰 Telegram / LINE 的录音', () => {
  const { buildVoiceNoteImportScript } = require('../desktop/src/translate/voice-note-import')
  const src = buildVoiceNoteImportScript()
  assert.match(src, /HOSTNAME\s*!==\s*'web\.whatsapp\.com'/, '缺少精确站点护栏')
  assert.doesNotMatch(src, /location\.hostname\s*!==\s*'web\.whatsapp\.com'/, '探针注入点不应破坏生产判断')
})

test('★ 不能访问 WhatsApp 内部 Store / 协议 / 上传实现', () => {
  const { buildVoiceNoteImportScript } = require('../desktop/src/translate/voice-note-import')
  const src = buildVoiceNoteImportScript()
  const forbidden = [
    /webpackChunk/i,
    /\bStore\b/,
    /\bsendMessage\s*\(/,
    /\bWAWeb[A-Za-z0-9_]+/,
    /\bptt\s*:\s*true/,
    /\bencrypt/i,
    /\buploadEnc/i
  ]
  for (const re of forbidden) {
    assert.doesNotMatch(src, re, '出现内部协议调用：' + re)
  }
})

test('★ 只拦截单个音频文件；图片/文档仍交给 WhatsApp 原逻辑', () => {
  const { buildVoiceNoteImportScript } = require('../desktop/src/translate/voice-note-import')
  const script = buildVoiceNoteImportScript({ hostname: 'web.whatsapp.com' })
  const dom = new JSDOM('<!doctype html><html><body><div id="main"><footer>' +
    '<div contenteditable="true" role="textbox"></div><button data-icon="ptt">mic</button>' +
    '</footer></div></body></html>', {
    url: 'https://web.whatsapp.com/',
    runScripts: 'outside-only'
  })
  dom.window.eval(script)

  assert.ok(dom.window.document.querySelector('#pix-voice-entry'), '聊天里必须常驻「导入语音」入口')
  const field = dom.window.document.querySelector('[contenteditable="true"]')
  const textFile = new dom.window.File(['hello'], 'note.txt', { type: 'text/plain' })
  const event = new dom.window.Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files: [textFile] } })
  field.dispatchEvent(event)
  const status = dom.window.__pixVoiceImportStatus()
  dom.window.close()

  assert.equal(event.defaultPrevented, false, '普通文件不能被我方截走')
  assert.equal(status.busy, false)
})

test('★ 音频拖入必须阻止普通上传；直发未就绪时失败关闭', () => {
  const { buildVoiceNoteImportScript } = require('../desktop/src/translate/voice-note-import')
  const script = buildVoiceNoteImportScript({ hostname: 'web.whatsapp.com' })
  const dom = new JSDOM('<!doctype html><html><body><div id="main"><footer>' +
    '<div contenteditable="true" role="textbox"></div><button data-icon="mic">mic</button>' +
    '</footer></div></body></html>', {
    url: 'https://web.whatsapp.com/',
    runScripts: 'outside-only'
  })
  dom.window.eval(script)

  const file = new dom.window.File(['not-a-real-ogg'], 'voice.ogg', { type: 'audio/ogg' })
  const event = new dom.window.Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } })
  dom.window.document.querySelector('[contenteditable="true"]').dispatchEvent(event)
  const status = dom.window.__pixVoiceImportStatus()
  dom.window.close()

  assert.equal(event.defaultPrevented, true, '音频必须阻止 WhatsApp 的普通文件上传')
  assert.equal(status.installed, true)
  assert.match(status.status, /原生语音发送模块还没准备好/, '不能默默退回会产生空白波形的旧链路')
})

test('★ 「导入语音」入口必须统一委托给带真实波形的直发 PTT', () => {
  const { buildVoiceNoteImportScript } = require('../desktop/src/translate/voice-note-import')
  const script = buildVoiceNoteImportScript({ hostname: 'web.whatsapp.com' })
  const dom = new JSDOM('<!doctype html><html><body><div id="main"><footer>' +
    '<div contenteditable="true" role="textbox"></div><button data-icon="mic">mic</button>' +
    '</footer></div></body></html>', {
    url: 'https://web.whatsapp.com/',
    runScripts: 'outside-only'
  })
  let opened = 0
  dom.window.__pixDirectPttOpenPicker = () => {
    opened++
    return true
  }
  dom.window.eval(script)

  dom.window.document.querySelector('#pix-voice-entry').click()
  assert.equal(opened, 1, '导入语音必须复用已验收的直接 PTT 文件选择器')
  assert.equal(
    dom.window.document.querySelector('[data-pix-ui="voice-import-input"]'),
    null,
    '不能再打开虚拟麦克风自己的文件输入'
  )
  dom.window.close()
})

test('★ 拖入音频也必须统一走直发 PTT，避免空白波形', () => {
  const { buildVoiceNoteImportScript } = require('../desktop/src/translate/voice-note-import')
  const script = buildVoiceNoteImportScript({ hostname: 'web.whatsapp.com' })
  const dom = new JSDOM('<!doctype html><html><body><div id="main"><footer>' +
    '<div contenteditable="true" role="textbox"></div><button data-icon="mic">mic</button>' +
    '</footer></div></body></html>', {
    url: 'https://web.whatsapp.com/',
    runScripts: 'outside-only'
  })
  let sent = null
  dom.window.__pixDirectPttSendFile = file => {
    sent = file
    return Promise.resolve({ ok: true })
  }
  dom.window.eval(script)

  const file = new dom.window.File(['audio'], 'voice.ogg', { type: 'audio/ogg' })
  const event = new dom.window.Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } })
  dom.window.document.querySelector('[contenteditable="true"]').dispatchEvent(event)

  assert.equal(event.defaultPrevented, true)
  assert.equal(sent && sent.name, 'voice.ogg')
  dom.window.close()
})

test('★ getUserMedia 只替换一次，并必须恢复原实现', () => {
  const { buildVoiceNoteImportScript } = require('../desktop/src/translate/voice-note-import')
  const src = buildVoiceNoteImportScript()
  assert.match(src, /installVirtualMicrophone/, '缺少临时虚拟麦克风')
  assert.match(src, /const original = mediaDevices\.getUserMedia\.bind\(mediaDevices\)/, '必须保留原方法')
  assert.match(src, /if \(used \|\| !current \|\| current\.cancelled\) return original\.apply/, '必须 one-shot')
  assert.match(src, /fakeEnumerateDevices/, '没有麦克风输入的 Mac 会在 getUserMedia 前被 WhatsApp 拦下')
  assert.match(src, /kind:\s*'audioinput'/, '必须临时声明虚拟输入设备')
  assert.match(src, /restoreCapture\(\)/, '失败/结束必须恢复 getUserMedia')
})

test('★ 必须由 WhatsApp 自己产生 PTT，不允许用 CSS 伪造消息类型', () => {
  const src = read('desktop/src/translate/voice-note-import.js')
  assert.match(src, /source\.connect\(destination\)/, '外部音频必须进入虚拟音轨')
  assert.match(src, /startAction\.click\(\)/, '必须点击 WhatsApp 自己的麦克风按钮')
  assert.match(src, /findStopVoiceAction/, '必须使用 WhatsApp 的停止录音控件')
  assert.match(src, /findVoiceSendAction/, '必须使用 WhatsApp 的语音发送控件')
  assert.doesNotMatch(src, /data-testid="ptt"|\.message-out\s*\{|waveform.*css/i, '不许用样式冒充 PTT')
})

test('★ 找不到原生停止/发送控件时不能盲目发送', () => {
  const src = read('desktop/src/translate/voice-note-import.js')
  assert.match(src, /没有找到 WhatsApp 的停止按钮/)
  assert.match(src, /没有找到发送按钮/, '只能提示用户，不能自行发出未知消息')
})

test('★ 录音期间切换聊天必须取消，不能把语音发进新会话', () => {
  const src = read('desktop/src/translate/voice-note-import.js')
  assert.match(src, /chatKey:\s*chatKey\(\)/)
  assert.match(src, /chatKey\(\)\s*!==\s*current\.chatKey/, '发送前没有复核会话身份')
  assert.match(src, /聊天窗口已切换，已取消发送/)
  assert.match(src, /findCancelVoiceAction/, '失败时没有使用 WhatsApp 的取消入口')
})

test('★ 我方入口必须标记 data-pix-ui，避免被发送拦截器当成宿主动作', () => {
  const src = read('desktop/src/translate/voice-note-import.js')
  assert.match(src, /entryButton\.setAttribute\('data-pix-ui', 'voice-import-entry'\)/)
  assert.match(src, /fileInput\.setAttribute\('data-pix-ui', 'voice-import-input'\)/)
  assert.match(src, /el\.closest\('\[data-pix-ui\]'\)/, '扫描原生录音按钮时必须排除我方 UI')
})
