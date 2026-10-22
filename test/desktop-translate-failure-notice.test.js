'use strict'

/**
 * 翻译失败必须可见 —— 不许静默。
 *
 * ## 被修的缺陷（macOS 0.1.11 真机验收暴露）
 *
 * 老 `translateText()` 把"服务端返回失败"和"没有译文"当成同一件事：
 *
 *     const out = String((resp && (resp.translation || resp.text)) || '').trim()
 *     if (out) cache.set(key, out)
 *     return out                    // success:false → 静默返回空串
 *
 * 而 `.catch` 也返回空串。结果是 `INSUFFICIENT_CHARS`（子账号字符余额不足）、
 * `ENGINE_NOT_ALLOWED`（套餐不含该通道）这些**用户必须知道**的失败，
 * 在界面上全部表现成"翻译就是不出来"。
 *
 * 真机验收时这会被直接误判成"自动翻译失效"，而真实原因是余额或权限 ——
 * 排查方向会被带偏一整轮。所以失败必须有可见出口。
 *
 * ## 服务端错误信封（server/lib/http.js:45）
 *
 * `{ success: false, code, msg }`，客户端 `api()` 不检查 HTTP 状态、直接解析
 * JSON，`translate:run` 也原样 return，所以 `code` 一路到达 guest —— 可以按
 * `code` 精确匹配，不必去猜 `msg` 文案。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { JSDOM } = require('jsdom')

const root = path.join(__dirname, '..')
const guest = fs.readFileSync(path.join(root, 'desktop', 'guest-inject.js'), 'utf8')

const BEGIN = '// ==== TRANSLATE FAILURE NOTICE BEGIN ===='
const END = '// ==== TRANSLATE FAILURE NOTICE END ===='

/** 按标记切出提示模块的真实源码。 */
function noticeSlice() {
  const beginAt = guest.indexOf(BEGIN)
  const endAt = guest.indexOf(END)
  assert.ok(beginAt > 0 && endAt > beginAt, 'TRANSLATE FAILURE NOTICE BEGIN/END 标记被删了')
  return guest.slice(beginAt + BEGIN.length, endAt)
}

/** 按大括号配对，把 guest-inject.js 里的真实函数整段抽出来。 */
function grab(name) {
  const start = guest.indexOf('function ' + name + '(')
  assert.ok(start > 0, '找不到函数 ' + name + '（改名了？）')
  let depth = 0
  let started = false
  for (let i = start; i < guest.length; i++) {
    const c = guest[i]
    if (c === '{') { depth++; started = true } else if (c === '}') {
      depth--
      if (started && depth === 0) return guest.slice(start, i + 1)
    }
  }
  throw new Error('大括号不平衡: ' + name)
}

/**
 * 装配真源码 + 真 jsdom。
 *
 * `setTimeout` 用桩注入：提示 9 秒后自动消失，真定时器会把 node:test 的
 * 进程拖住 9 秒，而这里要验的是"有没有弹出来"，不是"会不会自己消失"。
 */
function mount(html) {
  const dom = new JSDOM(html || '<!doctype html><html><body></body></html>')
  const timers = []
  const api = new Function(
    'document', 'setTimeout',
    noticeSlice() + '\nreturn { notifyTranslateIssue }'
  )(dom.window.document, fn => { timers.push(fn); return timers.length })
  return { dom, doc: dom.window.document, api, timers }
}

/** 装配真实的 translateText() 依赖，用来验"失败会不会走到提示"。 */
function mountTranslate(opts) {
  // 缓存 / 去重 / 提示这些逻辑现在住在 translateTextDetailed() 里，
  // translateText() 只是它的字符串外壳（发送链路用）。这里挂载真正干活的那个。
  //
  // 依赖列表要跟着实现走：`withTranslateTimeout`（超时看门狗）和 `trace`
  // 都在 translateTextDetailed 里被调用，不注入就是 ReferenceError。
  // 这里注入一个**直通版**看门狗：本文件验的是"服务端失败会不会弹提示"，
  // 超时行为由 test/guest-translate-timeout.test.js 单独钉住。
  const o = opts || {}
  const src = grab('translateTextDetailed')
  const cache = o.cache || new Map()
  const calls = []
  const fn = new Function(
    'stripEmoji', 'MessageParser', 'cache', 'pending', 'api', 'notifyTranslateIssue',
    'withTranslateTimeout', 'trace',
    src + '\nreturn translateTextDetailed'
  )(
    t => t,
    { stripBusy: t => t },
    cache,
    new Map(),
    o.api || (() => ({ translate: () => Promise.resolve({ success: false, code: 'INSUFFICIENT_CHARS', msg: '字符余额不足' }) })),
    o.notify || (resp => { calls.push(resp); return 'notified' }),
    (key, promise) => promise,
    () => {}
  )
  return { fn, calls, cache }
}

const NOTICE_ID = 'pix-translate-notice'

// ---------------------------------------------------------------------------
// 提示本身
// ---------------------------------------------------------------------------

test('INSUFFICIENT_CHARS 必须给出「子账号余额不足」的明确文案', () => {
  const { doc, api } = mount()
  const text = api.notifyTranslateIssue({ success: false, code: 'INSUFFICIENT_CHARS', msg: '字符余额不足' })
  assert.match(text, /余额不足/, '文案必须点明余额问题')
  assert.match(text, /主账号/, '必须告诉用户找谁加字符')
  const box = doc.getElementById(NOTICE_ID)
  assert.ok(box, '必须真的把提示画进 DOM，只返回字符串用户看不见')
  assert.equal(box.textContent, text)
})

test('ENGINE_NOT_ALLOWED / ENGINE_NOT_CONFIGURED 各有明确文案', () => {
  for (const code of ['ENGINE_NOT_ALLOWED', 'ENGINE_NOT_CONFIGURED', 'ENGINE_RETIRED']) {
    const { doc, api } = mount()
    const text = api.notifyTranslateIssue({ success: false, code, msg: '服务端原文' })
    assert.ok(text && text.length > 0, code + ' 必须给出文案')
    assert.notEqual(text, '服务端原文', code + ' 应当用客户端友好文案而不是直接怼服务端 msg')
    assert.ok(doc.getElementById(NOTICE_ID), code + ' 必须画进 DOM')
  }
})

test('未知 code 退回服务端 msg；两者都没有就什么都不做', () => {
  const a = mount()
  assert.equal(a.api.notifyTranslateIssue({ success: false, code: 'SOMETHING_NEW', msg: '服务端说了一句话' }),
    '服务端说了一句话')
  assert.ok(a.doc.getElementById(NOTICE_ID))

  const b = mount()
  assert.equal(b.api.notifyTranslateIssue({ success: false }), '')
  assert.equal(b.api.notifyTranslateIssue(null), '')
  assert.equal(b.doc.getElementById(NOTICE_ID), null, '没文案就不该画一个空框')
})

// ---------------------------------------------------------------------------
// 节流 —— 余额为 0 时每条新消息都会失败，不能刷屏
// ---------------------------------------------------------------------------

test('同一失败 30 秒内只提示一次', () => {
  const { doc, api } = mount()
  const payload = { success: false, code: 'INSUFFICIENT_CHARS', msg: '字符余额不足' }
  assert.ok(api.notifyTranslateIssue(payload), '第一次必须提示')
  assert.equal(api.notifyTranslateIssue(payload), '', '第二次必须被节流')
  assert.equal(api.notifyTranslateIssue(payload), '', '第三次仍被节流')
  assert.equal(doc.querySelectorAll('#' + NOTICE_ID).length, 1, '不能叠出多个提示框')
})

test('不同失败互不节流，且新提示覆盖旧提示', () => {
  const { doc, api } = mount()
  assert.ok(api.notifyTranslateIssue({ success: false, code: 'INSUFFICIENT_CHARS' }))
  assert.ok(api.notifyTranslateIssue({ success: false, code: 'ENGINE_NOT_ALLOWED' }),
    '另一个 code 不该被上一个的节流吃掉')
  assert.equal(doc.querySelectorAll('#' + NOTICE_ID).length, 1, '同一时刻只留一条提示')
  assert.match(doc.getElementById(NOTICE_ID).textContent, /通道/)
})

// ---------------------------------------------------------------------------
// 不得污染采集 / 解析
// ---------------------------------------------------------------------------

test('提示带 data-pix-ui 标记，采集与解析必须能识别出"这是我们自己的界面"', () => {
  const { doc, api } = mount()
  api.notifyTranslateIssue({ success: false, code: 'INSUFFICIENT_CHARS' })
  const box = doc.getElementById(NOTICE_ID)
  assert.equal(box.getAttribute('data-pix-ui'), 'notice')
  assert.ok(box.style.zIndex, '必须浮在最上层，否则会被 WhatsApp 盖住')
})

// ---------------------------------------------------------------------------
// 接线：translateText 收到 success:false 时必须走提示，而不是静默
// ---------------------------------------------------------------------------

test('translateTextDetailed 收到 success:false 时返回失败结果但必须触发提示', async () => {
  const { fn, calls } = mountTranslate()
  const res = await fn('hello', true, 'auto_receive')
  assert.equal(res.ok, false, '失败时不该返回半个译文')
  assert.equal(res.out, '', '失败时不该返回半个译文')
  assert.equal(res.code, 'INSUFFICIENT_CHARS', '真实错误码必须原样回传，不许吞')
  assert.equal(calls.length, 1, '必须把失败交给提示层')
  assert.equal(calls[0].code, 'INSUFFICIENT_CHARS', 'code 要原样传下去才能匹配文案')
})

test('失败不进翻译缓存 —— 否则下次直接返回空串，用户永远是坏的', async () => {
  const { fn, cache } = mountTranslate()
  await fn('hello', true, 'auto_receive')
  assert.equal(cache.size, 0)
})

test('成功路径仍照常返回译文并写缓存', async () => {
  const { fn, cache } = mountTranslate({
    api: () => ({ translate: () => Promise.resolve({ success: true, translation: '你好' }) }),
    notify: () => { throw new Error('成功路径不该弹提示') }
  })
  const res = await fn('hello', true, 'auto_receive')
  assert.equal(res.ok, true)
  assert.equal(res.out, '你好')
  assert.equal(cache.get('in:hello'), '你好')
})
