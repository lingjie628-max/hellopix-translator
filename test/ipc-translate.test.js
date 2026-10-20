'use strict'

/**
 * 翻译 IPC 的单元测试。
 *
 * 最要紧的两件事：
 *   1. 客页通道（composer* / guestPrefs / run）必须自校验来源 ——
 *      它们走 handleUnsafe，注册器不再兜底，这里漏了就是任意页面
 *      都能驱动 WhatsApp 输入框、花用户的余额。
 *   2. 铁律不能破：占位符不进接口、超长本地就拒、网络错误不冒充服务故障。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { registerTranslateIpc, errorCodeOf, MAX_TRANSLATE_CHARS } =
  require('../desktop/src/ipc/translate')

function harness (opts) {
  const o = opts || {}
  const handlers = {}
  const unsafe = new Set()
  const logged = []
  const cache = new Map()
  const calls = []
  const tabs = [{ id: 't1', name: 'WhatsApp', settings: o.settings || {}, view: { webContents: Object.assign({ isDestroyed: () => false }, o.wc || {}) } }]

  const state = {
    tabs,
    profile: o.profile === undefined ? { username: 'u', langMine: 'zh', activeEngine: 'e1' } : o.profile,
    bridgeHealth: o.bridgeHealth || { get: () => undefined }
  }

  registerTranslateIpc({
    reg: {
      handle: (ch, fn) => { handlers[ch] = fn },
      handleUnsafe: (ch, fn) => { handlers[ch] = fn; unsafe.add(ch) }
    },
    state,
    actions: {
      // 默认：只有 sender 标了 trusted 才算我们管理的 tab
      trustedTabSender: sender => (sender && sender.trusted ? tabs[0] : null),
      rejectUntrustedSender: () => ({ success: false, msg: '来源不可信' }),
      bridgeReport: (id, ok, reason) => { calls.push(['bridgeReport', id, ok, reason]) },
      api: async (path, arg) => {
        calls.push(['api', path, arg])
        if (o.apiResult) return o.apiResult(path, arg)
        return { success: true }
      },
      pushGuestPrefs: () => { calls.push(['pushGuestPrefs']) },
      nativeComposer: {
        selectAllAndClear: wc => ({ ok: true, focused: true }),
        insertText: (wc, text) => ({ ok: true, chars: text.length }),
        insertTextLines: (wc, text) => ({ ok: true, lines: text.split('\n').length })
      },
      log: (ch, msg) => { logged.push([ch, msg]) },
      getTransCached: (f, t, e, text) => cache.get([f, t, e, text].join('|')),
      putTransCached: (f, t, e, text, out) => { cache.set([f, t, e, text].join('|'), out) },
      transRequestId: () => 'rid-1',
      requestTranslate: async (text, from, to, engine, trigger) => {
        calls.push(['request', { text, from, to, engine, trigger }])
        if (o.requestImpl) return o.requestImpl(text, from, to, engine, trigger)
        return { success: true, translation: 'T:' + text }
      }
    },
    env: {
      tabPrefs: tab => ({ recv: true, id: tab.id }),
      stripBusyMarks: s => String(s).replace(/\[\[BUSY\]\]/g, '').trim(),
      stripEmoji: s => s,
      pickLang: (v, d) => v || d
    }
  })
  return { handlers, unsafe, logged, calls, cache, tabs, state }
}

test('客页通道必须显式走 handleUnsafe（否则注册器会拿 isMainSender 卡死它们）', () => {
  const { unsafe } = harness()
  for (const ch of ['translate:guestPrefs', 'translate:composerSelectAllDelete',
    'translate:composerInsertText', 'translate:run']) {
    assert.ok(unsafe.has(ch), ch + ' 必须用 handleUnsafe 注册')
  }
  // 主界面通道反过来不能裸奔
  for (const ch of ['translate:bridgeStatus', 'translate:engines', 'translate:savePrefs']) {
    assert.equal(unsafe.has(ch), false, ch + ' 不该是 handleUnsafe')
  }
})

test('★ 客页通道：来源不可信时一律拒绝，且不执行业务', async () => {
  const { handlers, calls } = harness()
  const bad = { trusted: false }
  assert.equal((await handlers['translate:run'](bad, { text: 'hi' })).success, false)
  assert.equal(handlers['translate:guestPrefs']({ sender: bad }).success, false)
  assert.equal(handlers['translate:composerSelectAllDelete']({ sender: bad }).success, false)
  assert.equal(handlers['translate:composerInsertText']({ sender: bad }, { text: 'x' }).success, false)
  assert.equal(calls.filter(c => c[0] === 'request').length, 0, '不可信来源不能触发翻译请求')
  assert.equal(calls.filter(c => c[0] === 'pushGuestPrefs').length, 0)
})

test('guestPrefs 成功时上报桥存活（这是最可靠的存活证据）', () => {
  const { handlers, calls } = harness()
  const r = handlers['translate:guestPrefs']({ sender: { trusted: true } })
  assert.equal(r.id, 't1')
  assert.deepEqual(calls.find(c => c[0] === 'bridgeReport'), ['bridgeReport', 't1', true, ''])
})

test('translate:run 摘掉占位符后再进缓存和上游', async () => {
  const { handlers, calls } = harness()
  await handlers['translate:run']({ sender: { trusted: true } }, { text: '  [[BUSY]] 你好  ' })
  const req = calls.find(c => c[0] === 'request')[1]
  assert.equal(req.text, '你好', '占位符绝不能进翻译接口')
})

test('translate:run 只剩占位符时直接返回 skipped=busy，不请求', async () => {
  const { handlers, calls } = harness()
  const r = await handlers['translate:run']({ sender: { trusted: true } }, { text: '[[BUSY]]' })
  assert.equal(r.success, true)
  assert.equal(r.skipped, 'busy')
  assert.equal(r.translation, '')
  assert.equal(calls.filter(c => c[0] === 'request').length, 0)
})

test('translate:run 超长文本在本地就拒（不烧上游配额）', async () => {
  const { handlers, calls } = harness()
  const r = await handlers['translate:run']({ sender: { trusted: true } },
    { text: 'a'.repeat(MAX_TRANSLATE_CHARS + 1) })
  assert.equal(r.success, false)
  assert.match(r.msg, new RegExp(String(MAX_TRANSLATE_CHARS)))
  assert.equal(calls.filter(c => c[0] === 'request').length, 0)
})

test('translate:run 恰好等于上限时放行', async () => {
  const { handlers, calls } = harness()
  await handlers['translate:run']({ sender: { trusted: true } },
    { text: 'a'.repeat(MAX_TRANSLATE_CHARS) })
  assert.equal(calls.filter(c => c[0] === 'request').length, 1)
})

test('translate:run 命中缓存时不发请求', async () => {
  const { handlers, calls, cache } = harness()
  handlers['translate:run'] && await handlers['translate:run']({ sender: { trusted: true } }, { text: 'hi' })
  const before = calls.filter(c => c[0] === 'request').length
  const r = await handlers['translate:run']({ sender: { trusted: true } }, { text: 'hi' })
  assert.equal(r.cached, true)
  assert.equal(r.translation, 'T:hi')
  assert.equal(calls.filter(c => c[0] === 'request').length, before, '第二次应命中缓存')
  assert.ok(cache.size > 0)
})

test('translate:run 成功后写入反向缓存（回译直接命中）', async () => {
  const { handlers, cache } = harness()
  await handlers['translate:run']({ sender: { trusted: true } }, { text: 'hi' })
  // 正向：auto→en "hi" = "T:hi"；反向：auto→zh "T:hi" = "hi"
  assert.equal(cache.get('auto|zh|e1|T:hi'), 'hi', '回译必须命中反向缓存')
})

test('translate:run 把 requestId 带回渲染层（真机 trace 需要）', async () => {
  const { handlers } = harness()
  const r = await handlers['translate:run']({ sender: { trusted: true } }, { text: 'hi' })
  assert.equal(r.requestId, 'rid-1')
})

test('translate:run 的收发方向决定 from/to', async () => {
  const settings = { sendFrom: 'zh', sendTo: 'en', recvFrom: 'en', recvTo: 'zh' }
  const { handlers, calls } = harness({ settings })
  await handlers['translate:run']({ sender: { trusted: true } }, { text: 'a', incoming: true })
  await handlers['translate:run']({ sender: { trusted: true } }, { text: 'b', incoming: false })
  const reqs = calls.filter(c => c[0] === 'request').map(c => c[1])
  assert.deepEqual([reqs[0].from, reqs[0].to], ['en', 'zh'], '收消息：对方语言 → 我的语言')
  assert.deepEqual([reqs[1].from, reqs[1].to], ['zh', 'en'], '发消息：我的语言 → 对方语言')
})

test('translate:run 透传 trigger（用于区分手动翻译和扫描自动翻译）', async () => {
  const { handlers, calls } = harness()
  await handlers['translate:run']({ sender: { trusted: true } }, { text: 'x', trigger: 'scan' })
  assert.equal(calls.find(c => c[0] === 'request')[1].trigger, 'scan')
})

test('★ 网络错误不能冒充"翻译服务坏了"', async () => {
  // 真实的 api-net.js 把错误码挂在 err.code，pix 只装取证信息
  const err = new Error('connect timeout')
  err.code = 'UND_ERR_CONNECT_TIMEOUT'
  err.pix = { causeCode: 'ECONNREFUSED' }
  const { handlers } = harness({ requestImpl: () => { throw err } })
  const r = await handlers['translate:run']({ sender: { trusted: true } }, { text: 'x' })
  assert.equal(r.success, false)
  assert.equal(r.code, 'UND_ERR_CONNECT_TIMEOUT', '必须原码上报，否则用户排查方向全错')
})

test('服务端翻译失败按 TRANSLATE_FAILED 上报', () => {
  assert.equal(errorCodeOf(new Error('boom')), 'TRANSLATE_FAILED')
  assert.equal(errorCodeOf(null), 'TRANSLATE_FAILED')
  const e = new Error('x'); e.code = 'INSUFFICIENT_BALANCE'
  assert.equal(errorCodeOf(e), 'INSUFFICIENT_BALANCE')
  // 兼容老位置：有些旧调用链把码塞进 pix
  const old = new Error('y'); old.pix = { code: 'LEGACY_CODE' }
  assert.equal(errorCodeOf(old), 'LEGACY_CODE')
  // err.code 优先于 pix.code
  const both = new Error('z'); both.code = 'REAL'; both.pix = { code: 'PIX' }
  assert.equal(errorCodeOf(both), 'REAL')
})

test('bridgeStatus 只列出桥挂掉的窗口', () => {
  const health = new Map([['t1', { ok: false, reason: 'no-preload' }]])
  const { handlers, tabs } = harness({ bridgeHealth: { get: id => health.get(id) } })
  tabs.push({ id: 't2', name: 'LINE', settings: {} })
  health.set('t2', { ok: true })
  const r = handlers['translate:bridgeStatus']({})
  assert.equal(r.rows.length, 1)
  assert.deepEqual(r.rows[0], { id: 't1', name: 'WhatsApp', reason: 'no-preload' })
})

test('engines 请求失败时返回空列表而不是抛错', async () => {
  const { handlers } = harness({ apiResult: () => { throw new Error('down') } })
  assert.deepEqual(await handlers['translate:engines']({}), { success: false, rows: [] })
})

test('savePrefs 成功后同步本地 profile，且布尔值统一成 0/1', async () => {
  const { handlers, state, calls } = harness({ profile: { username: 'u' } })
  await handlers['translate:savePrefs']({}, { transRecv: true, transSend: '0', engine: 'e9', langMine: 'ja' })
  const p = state.profile
  assert.equal(p.transRecv, 1, 'true 要存成 1')
  assert.equal(p.transSend, 0, '字符串 "0" 也要存成 0')
  assert.equal(p.activeEngine, 'e9')
  assert.equal(p.langMine, 'ja')
  assert.equal(calls.filter(c => c[0] === 'pushGuestPrefs').length, 1, '改完要推给客页')
})

test('savePrefs 服务端失败时不改本地 profile（避免本地与后台不一致）', async () => {
  const { handlers, state } = harness({
    profile: { username: 'u', transRecv: 1 },
    apiResult: () => { throw new Error('save failed') }
  })
  const r = await handlers['translate:savePrefs']({}, { transRecv: false })
  assert.equal(r.success, false)
  assert.equal(state.profile.transRecv, 1, '服务端没存上，本地不能先改')
})

test('composer 插入：linewise 走逐行通道，否则走整段', () => {
  const { handlers, logged } = harness()
  const a = handlers['translate:composerInsertText']({ sender: { trusted: true } }, { text: 'a\nb' })
  assert.equal(a.ok, true)
  const b = handlers['translate:composerInsertText']({ sender: { trusted: true } },
    { text: 'a\nb', linewise: true })
  assert.equal(b.lines, 2)
  assert.ok(logged.some(l => /NATIVE_TEXT_INSERTED/.test(l[1])), '原生输入必须留 trace')
})

test('composer 在 webContents 已销毁时返回 NO_WEB_CONTENTS', () => {
  const { handler } = (() => {
    const h = harness()
    // 换一个已销毁的 wc
    h.tabs[0].view.webContents.isDestroyed = () => true
    return { handler: h.handlers }
  })()
  const r = handler['translate:composerSelectAllDelete']({ sender: { trusted: true } })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'NO_WEB_CONTENTS')
})
