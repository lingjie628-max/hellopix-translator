'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  VoiceOpusSession,
  toFloat32
} = require('../desktop/src/translate/voice-opus-encode')

test('★ PCM 输入只接受 Float32/TypedArray/ArrayBuffer，并按字节布局复制', () => {
  const source = new Float32Array([0.1, 0.2, 0.3])
  assert.deepEqual([...toFloat32(source)], [...source])
  const copy = toFloat32(source.buffer)
  assert.deepEqual([...copy], [...source])
  assert.equal(toFloat32('not audio'), null)
})

test('★ WASM Opus 编码必须真实产出 OGG，且长语音不受真实播放时长拖累', () => {
  const sampleRate = 44100
  const seconds = 25.7535
  const total = Math.floor(sampleRate * seconds)
  const session = new VoiceOpusSession({ sampleRate, bitrate: 64000 })
  const started = Date.now()
  for (let offset = 0; offset < total; offset += 4096) {
    const length = Math.min(4096, total - offset)
    const samples = new Float32Array(length)
    for (let index = 0; index < length; index++) {
      samples[index] = Math.sin(2 * Math.PI * 440 * (offset + index) / sampleRate) * 0.25
    }
    session.push(samples)
  }
  const output = session.finish()
  const elapsed = Date.now() - started
  assert.equal(output.subarray(0, 4).toString('ascii'), 'OggS')
  assert.ok(output.length > 10000)
  assert.ok(elapsed < 5000, '编码耗时不应接近语音真实时长：' + elapsed + 'ms')
})

test('★ 依赖必须是跨平台 MIT Opus，而不是不可分发的 GPL/nonfree FFmpeg', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'desktop', 'package.json'), 'utf8'))
  assert.match(pkg.dependencies['opus-recorder'], /^\^8\./)
  assert.equal(pkg.dependencies['ffmpeg-static'], undefined)
  assert.equal(pkg.build.asarUnpack, undefined)
})
