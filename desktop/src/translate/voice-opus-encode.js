'use strict'

/**
 * 主进程 OGG/Opus 编码器。
 *
 * 使用 opus-recorder 自带的纯 JavaScript + WebAssembly 编码核心，避免随安装包
 * 分发带 GPL/nonfree 配置的原生 FFmpeg。页面世界先用 AudioContext 解码任意
 * 音频，再把单声道 Float32 PCM 分块送到这里；编码速度远快于真实播放时长。
 */

const path = require('node:path')

const MAX_PTT_SECONDS = 30 * 60
const DEFAULT_SAMPLE_RATE = 48000
const DEFAULT_BITRATE = 64000

const packageDir = path.dirname(require.resolve('opus-recorder/package.json'))
const {
  Module,
  OggOpusEncoder
} = require(path.join(packageDir, 'dist', 'encoderWorker.min.js'))

function toFloat32 (value) {
  if (value instanceof Float32Array) return value
  if (ArrayBuffer.isView(value)) {
    return new Float32Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    )
  }
  if (value instanceof ArrayBuffer) return new Float32Array(value)
  if (Buffer.isBuffer(value)) {
    return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  }
  return null
}

class VoiceOpusSession {
  constructor (options) {
    const o = options || {}
    const originalSampleRate = Math.max(8000, Math.min(192000, Number(o.sampleRate) || DEFAULT_SAMPLE_RATE))
    this.encoder = new OggOpusEncoder({
      encoderApplication: 2048,
      encoderBitRate: Math.max(16000, Math.min(128000, Number(o.bitrate) || DEFAULT_BITRATE)),
      encoderComplexity: 3,
      encoderFrameSize: 20,
      encoderSampleRate: DEFAULT_SAMPLE_RATE,
      maxFramesPerPage: 40,
      numberOfChannels: 1,
      originalSampleRate,
      resampleQuality: 3,
      serial: Math.floor(Math.random() * 4294967296)
    }, Module)
    this.pages = [
      this.encoder.generateIdPage(),
      this.encoder.generateCommentPage()
    ].filter(Boolean)
    this.seconds = 0
    this.finished = false
  }

  push (value) {
    if (this.finished) throw new Error('Opus 编码会话已结束')
    const samples = toFloat32(value)
    if (!samples || !samples.length) return 0
    this.seconds += samples.length / this.encoder.config.originalSampleRate
    if (this.seconds > MAX_PTT_SECONDS) throw new Error('语音超过 30 分钟上限')
    this.pages.push(...this.encoder.encode([samples]))
    return samples.length
  }

  finish () {
    if (this.finished) throw new Error('Opus 编码会话已结束')
    this.finished = true
    try {
      this.pages.push(...this.encoder.encodeFinalFrame())
      const chunks = this.pages.filter(Boolean).map(page => (
        Buffer.from(page.page.buffer, page.page.byteOffset, page.page.byteLength)
      ))
      const output = Buffer.concat(chunks)
      if (output.subarray(0, 4).toString('ascii') !== 'OggS') {
        throw new Error('Opus 编码结果不是有效 OGG 文件')
      }
      return output
    } finally {
      this.encoder.destroy()
      this.pages = []
    }
  }

  abort () {
    if (this.finished) return
    this.finished = true
    try { this.encoder.destroy() } catch (e) {}
    this.pages = []
  }
}

module.exports = {
  VoiceOpusSession,
  MAX_PTT_SECONDS,
  toFloat32
}
