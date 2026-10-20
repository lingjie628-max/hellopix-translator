#!/usr/bin/env node
/**
 * 窗口 bounds 持久化逻辑测试。
 *
 * 目的：上一次提交「窗口尺寸记忆」的风险点是 restoreWindowBounds —— 一旦它
 * 返回了坏坐标，窗口会出现在看不见的地方（拔外接屏、手改 JSON、写坏文件都
 * 可能触发）。这里把 main.js 里的**真实函数源码**抽出来跑用例，
 * 不复制粘贴、不改一行，保证测的就是线上那份逻辑。
 *
 * 关键文件（读）：desktop/main.js
 * 运行：node test/window-bounds.test.js
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8')

/** 从 main.js 源码里按名字抽出函数声明（含函数体，原样保留） */
function extractFn(name) {
  const start = MAIN.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`main.js 里找不到 function ${name}()，测试需要同步更新`)
  let depth = 0
  let i = MAIN.indexOf('{', start)
  const bodyStart = i
  for (; i < MAIN.length; i++) {
    const ch = MAIN[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) break
    }
  }
  if (depth !== 0) throw new Error(`function ${name}() 大括号不平衡`)
  return MAIN.slice(start, i + 1)
}

/** 同样从源码抽常量，避免测试与实现里的文件名漂移 */
const WINDOW_BOUNDS_FILE_CONST = (() => {
  const m = MAIN.match(/^const WINDOW_BOUNDS_FILE = .*$/m)
  if (!m) throw new Error('main.js 里找不到 WINDOW_BOUNDS_FILE 常量定义')
  return m[0]
})()

/**
 * 窗口尺寸边界同样**从源码抽**，不在测试里另抄一份。
 *
 * 抄一份的后果很具体：改了实现的 900、忘了改测试的 1160，
 * 测试要么直接挂（还算好），要么在新数值下变成一条恒真的废断言（更糟）。
 */
const SIZE_CONSTS = (() => {
  const names = ['WINDOW_MIN_WIDTH', 'WINDOW_MIN_HEIGHT', 'WINDOW_MAX_WIDTH', 'WINDOW_MAX_HEIGHT']
  const out = {}
  const lines = []
  for (const n of names) {
    const m = MAIN.match(new RegExp('^const ' + n + ' = (\\d+)$', 'm'))
    if (!m) throw new Error(`main.js 里找不到常量 ${n}，测试需要同步更新`)
    out[n] = Number(m[1])
    lines.push(m[0])
  }
  return { values: out, source: lines.join('\n') }
})()
const MIN_W = SIZE_CONSTS.values.WINDOW_MIN_WIDTH
const MIN_H = SIZE_CONSTS.values.WINDOW_MIN_HEIGHT
const MAX_W = SIZE_CONSTS.values.WINDOW_MAX_WIDTH
const MAX_H = SIZE_CONSTS.values.WINDOW_MAX_HEIGHT

const HELPERS = `
  const path = require('path')
  const fs = require('fs')
  let win
  let boundsSaveTimer = null
  function userFile(name) { return path.join(app.getPath('userData'), name) }
  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return fallback }
  }
  function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)) }
`

/** 在沙箱里建出真实的 restoreWindowBounds / scheduleSaveWindowBounds */
function buildSandbox({ savedFile = null, displays = [] } = {}) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pix-bounds-'))
  const userData = path.join(tmp, 'userData')
  fs.mkdirSync(userData, { recursive: true })
  if (savedFile !== null) {
    fs.writeFileSync(path.join(userData, 'window-bounds.json'), typeof savedFile === 'string' ? savedFile : JSON.stringify(savedFile))
  }
  const writes = []
  // 真实的异步存储：scheduleSaveWindowBounds 现在走 asyncJson()。
  // 用真模块而不是假对象 —— 这样"rename 原子写"也在测试覆盖里。
  const { createStore } = require('../desktop/async-store')
  const stores = new Map()
  const asyncJson = file => {
    if (!stores.has(file)) stores.set(file, createStore(file, { debounceMs: 0 }))
    return stores.get(file)
  }
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    app: { getPath: () => userData },
    asyncJson,
    require: id => {
      if (id === 'electron') return { screen: { getAllDisplays: () => displays } }
      return require(id)
    },
    __writes: writes,
    __userData: userData
  }
  vm.createContext(sandbox)
  vm.runInContext(
    HELPERS + '\n' + WINDOW_BOUNDS_FILE_CONST + '\n' + SIZE_CONSTS.source + '\n' + extractFn('scheduleSaveWindowBounds') + '\n' + extractFn('restoreWindowBounds') +
    '\nthis.__schedule = scheduleSaveWindowBounds; this.__restore = restoreWindowBounds; this.__setWin = w => { win = w };',
    sandbox,
    { filename: 'main.js#window-bounds' }
  )
  return { sandbox, userData, writes, restore: sandbox.__restore, schedule: sandbox.__schedule }
}

// 一台 1920x1080 主屏 + 一台外接屏（workArea 含 y 偏移，模拟菜单栏）
const MAIN_DISPLAY = { workArea: { x: 0, y: 25, width: 1920, height: 1055 } }
const SECOND_DISPLAY = { workArea: { x: 1920, y: 0, width: 1440, height: 900 } }
const FALLBACK = { width: 1600, height: 900 }

const clampW = w => Math.min(Math.max(w, MIN_W), MAX_W)
const clampH = h => Math.min(Math.max(h, MIN_H), MAX_H)

test('restoreWindowBounds', async t => {
  await t.test('没有存档时返回 fallback', () => {
    const { restore } = buildSandbox({ savedFile: null, displays: [MAIN_DISPLAY] })
    assert.deepStrictEqual({ ...restore(FALLBACK) }, FALLBACK)
  })

  await t.test('存档损坏（非 JSON）时返回 fallback', () => {
    const { restore } = buildSandbox({ savedFile: '{ 这不是 JSON', displays: [MAIN_DISPLAY] })
    assert.deepStrictEqual({ ...restore(FALLBACK) }, FALLBACK)
  })

  await t.test('字段缺失/非数字时返回 fallback', () => {
    for (const bad of [{}, { width: 1400 }, { width: '1400', height: null, x: 0, y: 0 }, { width: 1400, height: 900, x: 'a', y: 'b' }]) {
      const { restore } = buildSandbox({ savedFile: bad, displays: [MAIN_DISPLAY] })
      assert.deepStrictEqual({ ...restore(FALLBACK) }, FALLBACK, `坏存档应回退: ${JSON.stringify(bad)}`)
    }
  })

  await t.test('正常存档原样恢复', () => {
    const { restore } = buildSandbox({ savedFile: { x: 120, y: 80, width: 1400, height: 900 }, displays: [MAIN_DISPLAY] })
    assert.deepStrictEqual({ ...restore(FALLBACK) }, { x: 120, y: 80, width: 1400, height: 900 })
  })

  await t.test('窗口完全在屏幕外（拔掉外接屏）时返回 fallback', () => {
    // 外接屏在右侧时存的坐标，拔屏后 x=2400 已在主屏之外
    const { restore } = buildSandbox({ savedFile: { x: 2400, y: 100, width: 1300, height: 900 }, displays: [MAIN_DISPLAY] })
    assert.deepStrictEqual({ ...restore(FALLBACK) }, FALLBACK)
  })

  await t.test('大量出屏但右边缘留够 120px 时仍判定可见（不粗暴丢弃）', () => {
    // 判定条件是 x+width > 屏左 + 120：右侧露出 150px ≥ 120 → 可见，保留原坐标
    const { restore } = buildSandbox({ savedFile: { x: -1250, y: 100, width: 1400, height: 900 }, displays: [MAIN_DISPLAY] })
    assert.strictEqual(restore(FALLBACK).x, -1250)
  })

  await t.test('右侧露出不足 120px 时判定不可见，回退 fallback', () => {
    // 同样大量出屏，但右边缘只露出 100px < 120 → 视为不可见
    const { restore } = buildSandbox({ savedFile: { x: -1300, y: 100, width: 1400, height: 900 }, displays: [MAIN_DISPLAY] })
    assert.deepStrictEqual({ ...restore(FALLBACK) }, FALLBACK)
  })

  await t.test('副屏仍在时恢复副屏位置', () => {
    const { restore } = buildSandbox({ savedFile: { x: 2200, y: 100, width: 1300, height: 900 }, displays: [MAIN_DISPLAY, SECOND_DISPLAY] })
    assert.deepStrictEqual({ ...restore(FALLBACK) }, { x: 2200, y: 100, width: 1300, height: 900 })
  })

  await t.test(`过小的存档尺寸被抬到 minWidth ${MIN_W} / minHeight ${MIN_H}`, () => {
    const { restore } = buildSandbox({ savedFile: { x: 100, y: 100, width: 300, height: 200 }, displays: [MAIN_DISPLAY] })
    const got = restore(FALLBACK)
    assert.strictEqual(got.width, MIN_W,
      `必须抬到 ${MIN_W}。这个数是 CDP 实测出来的：885px 时页脚开始溢出，900 有余量。`)
    assert.strictEqual(got.height, MIN_H)
  })

  await t.test('过大的存档尺寸被夹到 3200x2000', () => {
    const { restore } = buildSandbox({ savedFile: { x: 0, y: 0, width: 9999, height: 9999 }, displays: [MAIN_DISPLAY] })
    const got = restore(FALLBACK)
    assert.strictEqual(got.width, 3200)
    assert.strictEqual(got.height, 2000)
  })

  await t.test(`夹取边界与常量一致（${MIN_W}/${MAX_W}/${MIN_H}/${MAX_H}）`, () => {
    const cases = [[MIN_W - 1, MIN_W], [MIN_W, MIN_W], [MAX_W, MAX_W], [MAX_W + 1, MAX_W]]
    for (const [input, want] of cases) {
      const { restore } = buildSandbox({ savedFile: { x: 10, y: 10, width: input, height: 900 }, displays: [MAIN_DISPLAY] })
      assert.strictEqual(restore(FALLBACK).width, want, `width ${input} 应夹到 ${want}`)
    }
    assert.strictEqual(clampW(MIN_W - 1), MIN_W)
    assert.strictEqual(clampH(2001), 2000)
  })

  await t.test('小数坐标被取整', () => {
    const { restore } = buildSandbox({ savedFile: { x: 10.6, y: 20.2, width: 1400.7, height: 900.4 }, displays: [MAIN_DISPLAY] })
    const got = restore(FALLBACK)
    for (const v of [got.x, got.y, got.width, got.height]) assert.ok(Number.isInteger(v), `应为整数: ${JSON.stringify(got)}`)
  })
})

test('scheduleSaveWindowBounds', async t => {
  await t.test('防抖 500ms 后把 bounds 落盘', async () => {
    const { sandbox, userData } = buildSandbox({ displays: [MAIN_DISPLAY] })
    const box = { x: 40, y: 60, width: 1500, height: 950 }
    sandbox.__setWin({ isDestroyed: () => false, isFullScreen: () => false, isMaximized: () => false, getBounds: () => box })
    sandbox.__schedule()
    assert.ok(!fs.existsSync(path.join(userData, 'window-bounds.json')), '防抖期内不应落盘')
    await new Promise(r => setTimeout(r, 600))
    const written = JSON.parse(fs.readFileSync(path.join(userData, 'window-bounds.json'), 'utf8'))
    assert.deepStrictEqual(written, box)
  })

  await t.test('连续调用只落盘最后一次（防抖）', async () => {
    const { sandbox, userData } = buildSandbox({ displays: [MAIN_DISPLAY] })
    const boxes = [{ x: 1, y: 1, width: MIN_W, height: MIN_H }, { x: 2, y: 2, width: 1200, height: 700 }, { x: 3, y: 3, width: 1300, height: 800 }]
    let cur = boxes[0]
    sandbox.__setWin({ isDestroyed: () => false, isFullScreen: () => false, isMaximized: () => false, getBounds: () => cur })
    for (const b of boxes) { cur = b; sandbox.__schedule() }
    await new Promise(r => setTimeout(r, 600))
    const written = JSON.parse(fs.readFileSync(path.join(userData, 'window-bounds.json'), 'utf8'))
    assert.deepStrictEqual(written, boxes[2], '只应写入最后一次的 bounds')
  })

  await t.test('全屏/最大化/已销毁时不落盘（避免把特殊状态写成普通尺寸）', async () => {
    for (const state of ['destroyed', 'fullscreen', 'maximized']) {
      const { sandbox, userData } = buildSandbox({ displays: [MAIN_DISPLAY] })
      sandbox.__setWin({
        isDestroyed: () => state === 'destroyed',
        isFullScreen: () => state === 'fullscreen',
        isMaximized: () => state === 'maximized',
        getBounds: () => ({ x: 0, y: 0, width: 1512, height: 982 })
      })
      sandbox.__schedule()
      await new Promise(r => setTimeout(r, 600))
      assert.ok(!fs.existsSync(path.join(userData, 'window-bounds.json')), `${state} 状态不应落盘`)
    }
  })
})
