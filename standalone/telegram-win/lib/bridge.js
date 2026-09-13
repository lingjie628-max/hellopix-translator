'use strict'

const fs = require('fs')
const path = require('path')

const BRIDGE_NAME = 'hello-pix-bridge.json'

function buildBridge(input) {
  const data = input || {}
  const prefs = data.prefs || {}
  return {
    apiBase: String(data.apiBase || '').replace(/\/+$/, ''),
    deviceId: String(data.deviceId || ''),
    cookies: Object.assign({}, data.cookies || {}),
    // 空串要原样写出去，不能兜底成 'youdao'：C++ 侧拿到空串会发 engine= 空值，
    // 服务端按 falsy 回退到账号当前通道；硬编码一个没接通的通道只会 503 静默失败，
    // 表现出来就是气泡永远不出 [译文]。
    engine: String(prefs.engine || ''),
    lang: String(prefs.lang || 'zh'),
    transRecv: prefs.transRecv !== false,
    transSend: prefs.transSend !== false,
    transGroup: prefs.transGroup !== false
  }
}

function writeBridge(dir, input) {
  const folder = String(dir || '')
  if (!folder) throw new Error('缺少电报数据目录')
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, BRIDGE_NAME)
  fs.writeFileSync(file, JSON.stringify(buildBridge(input), null, 2))
  return file
}

function writeBridges(dirs, input) {
  return (dirs || []).map(dir => writeBridge(dir, input))
}

module.exports = { BRIDGE_NAME, buildBridge, writeBridge, writeBridges }
