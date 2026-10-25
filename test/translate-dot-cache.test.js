/**
 * 客户端本地缓存的句点兜底。
 *
 * 服务端清理只对**新产生的译文**生效。用户机器上 `trans-cache` 里已经存着的
 * 旧译文还是带点的版本，命中本地缓存时根本不会请求服务端 —— 不兜这一层，
 * 那些句子会永远带着点，用户会认为"根本没修好"。
 *
 * 这条测试把 translate:run 的三条路径钉住：
 *   本地缓存命中   → 返回前清理，并写回缓存
 *   服务端返回     → 入库前清理（防旧服务端 / 中间层）
 *   原文自带标点   → 一律不动
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const { registerTranslateIpc } = require('../desktop/src/ipc/translate')

/** 最小可用的寄主环境：只实现 translate:run 会用到的那些。 */
function harness ({ cache = null, upstream = null } = {}) {
  const handlers = {}
  const store = new Map(Object.entries(cache || {}))
  const tab = { id: 1, settings: { sendTo: 'en', recvTo: 'zh' }, wc: {} }

  const actions = {
    trustedTabSender: () => tab,
    rejectUntrustedSender: () => ({ success: false, rejected: true }),
    getTransCached: (from, to, engine, text) => store.get(text) || null,
    putTransCached: (from, to, engine, text, out) => { store.set(text, out) },
    requestTranslate: async () => upstream,
    log: () => {},
    stripEmoji: s => s,
    stripBusyMarks: s => s,
    pickLang: (v, fb) => v || fb
  }

  const reg = {
    handle: (name, fn) => { handlers[name] = fn },
    handleUnsafe: (name, fn) => { handlers[name] = fn },
    // 同步通道（translate:imageUiSource）。本用例不涉及它，给个空壳
    // 让 registerTranslateIpc 能跑完即可。
    handleSync: (name, fn) => { handlers[name] = fn }
  }

  registerTranslateIpc({
    reg,
    state: { tabs: [tab], profile: { langMine: 'zh', activeEngine: 'gpt' }, bridgeHealth: new Map() },
    actions,
    env: {
      tabPrefs: () => tab.settings,
      stripEmoji: s => s,
      stripBusyMarks: s => s,
      pickLang: (v, fb) => v || fb
    }
  })

  const run = text => handlers['translate:run']({ sender: {} }, { text })
  return { run, store }
}

test('本地缓存命中带点旧译文 → 清理并写回缓存', async () => {
  const { run, store } = harness({ cache: { 在吗: 'Are you there.' } })

  const r = await run('在吗')
  assert.equal(r.translation, 'Are you there', '返回给渲染层的不该带点')
  assert.equal(store.get('在吗'), 'Are you there', '缓存也要被顺手修干净')
})

test('本地缓存命中但原文自带句点 → 保留', async () => {
  const { run } = harness({ cache: { '你在吗.': 'Are you there.' } })
  const r = await run('你在吗.')
  assert.equal(r.translation, 'Are you there.')
})

test('服务端返回带点（旧后端）→ 入库前清理', async () => {
  const { run, store } = harness({
    upstream: { success: true, translation: 'What is the date today.' }
  })

  const r = await run('今天几号')
  assert.equal(r.translation, 'What is the date today')
  assert.equal(store.get('今天几号'), 'What is the date today', '写进缓存的必须已经干净')
})

test('新服务端已经清过 → 再清一次无副作用', async () => {
  const { run } = harness({ upstream: { success: true, translation: 'Okay' } })
  const r = await run('好的')
  assert.equal(r.translation, 'Okay')
})

test('中文句号不会被客户端误删', async () => {
  const { run } = harness({ upstream: { success: true, translation: '好的。' } })
  const r = await run('Okay')
  assert.equal(r.translation, '好的。')
})
