'use strict'

/**
 * `device:peer` IPC 白名单的护栏测试。
 *
 * ## 为什么单独测这一条
 *
 * 主进程对上报的设备类型做白名单校验（不接受任意字符串）。这个白名单
 * 必须与 `src/whatsapp/device-platform.js` 的 `DEVICES` 保持一致 ——
 * 2026-11-11 加 `desktop` 类型时，白名单就漏掉了它，导致电脑版设备的上报
 * 被静默拒绝（返回 `{ok:false, reason:'bad_device'}`），排查时完全看不出。
 *
 * 所以这里直接对拍两个来源，任何一边加了类型而另一边没加都会失败。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { DEVICES } = require('../desktop/src/whatsapp/device-platform')

const APP_IPC = path.join(__dirname, '..', 'desktop', 'src', 'ipc', 'app.js')

/** 抠出 device:peer 处理器里的 allowed 对象字面量。 */
function allowedKeys () {
  const src = fs.readFileSync(APP_IPC, 'utf8')
  const start = src.indexOf("'device:peer'")
  assert.ok(start > 0, 'app.js 里找不到 device:peer 处理器')
  // 从处理器起往后找第一个 allowed = { ... }
  const seg = src.slice(start, start + 1200)
  const m = /const\s+allowed\s*=\s*\{([^}]*)\}/.exec(seg)
  assert.ok(m, 'device:peer 处理器里找不到 allowed 白名单')
  return m[1]
    .split(',')
    .map((p) => p.trim().split(':')[0].trim().replace(/['"]/g, ''))
    .filter(Boolean)
    .sort()
}

test('★ IPC 白名单必须覆盖 DEVICES 里的每一个类型', () => {
  const inIpc = allowedKeys()
  const inModule = Object.values(DEVICES).slice().sort()

  for (const d of inModule) {
    assert.ok(inIpc.indexOf(d) >= 0,
      'DEVICES 里有 ' + d + '，但 app.js 的白名单没有 —— ' +
      '这种设备的上报会被静默拒绝。当前白名单：' + JSON.stringify(inIpc))
  }
})

test('★ 白名单不能有 DEVICES 之外的值（防止被灌任意字符串）', () => {
  const inIpc = allowedKeys()
  const valid = Object.values(DEVICES)
  for (const k of inIpc) {
    assert.ok(valid.indexOf(k) >= 0,
      '白名单里有未知类型 ' + k + '，与 DEVICES 不一致')
  }
})

test('desktop 必须在白名单里（曾经漏掉过）', () => {
  assert.ok(allowedKeys().indexOf('desktop') >= 0,
    'desktop 不在白名单 —— 这正是 2026-11-11 修过的 bug')
})
