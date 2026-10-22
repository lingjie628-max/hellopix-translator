'use strict'

/**
 * `open-apps.json` 的合并语义 —— 防「重启后账号凭空消失」。
 *
 * ## 判决：这个竞态是假的
 *
 * 2026-10-21 用户重启后三个 WhatsApp 账号从标签栏消失，我一度判定是
 * 「`restoreOneApp` 的 `did-stop-loading` 抢跑 `saveOpenApps()`，把还没建出的
 * tab 删掉」，并把 `restoreOpenApps` 改成"先登记再建"。
 *
 * 后来把 `restoreOneApp` 读穿了才发现不成立：
 *
 *     bindTabLoading(tab)   // 注册 did-stop-loading（异步）
 *     tabs.push(tab)        // ← 同步入列
 *     startTabLoad(tab)
 *
 * `did-stop-loading` 是事件循环里**稍后**才派发的，而 `forEach` 循环是同步的 ——
 * 等回调有机会跑时，`tabs` 里已经有全部（恢复成功的）tab 了。用真实 Electron
 * 语义（启动快照 + 落盘）建模跑过，两种登记时机在「双副本」「抢跑」「恢复失败」
 * 三个场景下结果**完全一致**，没有一条路径会丢账号。
 *
 * 那次改动已回退。「先登记」反而会破坏 `seededTabIds` 的另一半语义：
 * 恢复失败（平台下线 / homeUrl 非法）的 id 被当成"我管理过"，下次保存时静默删掉。
 *
 * ## 账号真正是怎么丢的
 *
 * 见下方「事故复盘」用例：`username` 对不上、或启动时读到空列表，才是真凶。
 * `saveOpenApps()` 会以 `byUser[user]` 为**整段覆盖**的最小单位 ——
 * 只要内存里 `tabs` 是空的、且磁盘快照也是空的，写一次就是 0 个。
 */

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8')

function sliceBlock(src, header) {
  const i = src.indexOf(header)
  assert.ok(i > 0, `找不到代码块: ${header}`)
  let depth = 0, started = false
  for (let k = i; k < src.length; k++) {
    const c = src[k]
    if (c === '{') { depth++; started = true }
    else if (c === '}') { depth--; if (started && depth === 0) return src.slice(i, k + 1) }
  }
  throw new Error('括号不配对: ' + header)
}

/**
 * 按真实 Electron 语义搭沙箱：
 *   · `openAppsStore()` 是启动时读一次的**缓存**（看不到别的副本后来写下的内容）
 *   · `writeJson()` 才落盘
 *   · `tabs` 为模块级数组，可手动 push 模拟"已建出"
 */
function makeSandbox(opts) {
  const disk = { file: JSON.parse(JSON.stringify(opts.disk)) }
  const snapshot = JSON.parse(JSON.stringify(opts.disk))   // 启动时读一次
  const tabs = []
  const box = {
    store: disk,
    tabs,
    user: opts.user,
    save: () => vm.runInContext('__api.saveOpenApps()', box.ctx),
    seed: id => box.ctx.__api.seededTabIds.add(String(id)),
    build(id, name) {
      tabs.push({ id, platform: 'whatsapp', name, partition: 'persist:pix-' + opts.user + '-' + id })
      box.seed(id)
    },
    ids: () => ((disk.file.byUser[opts.user] || {}).tabs || []).map(r => r.id)
  }
  box.ctx = vm.createContext({
    currentPixUser: () => box.user,
    openAppsFile: () => 'open-apps.json',
    readJson: (f, d) => JSON.parse(JSON.stringify(d)),
    writeJson: (f, data) => { disk.file = JSON.parse(JSON.stringify(data)) },
    openAppsStore: () => ({ get: d => JSON.parse(JSON.stringify(snapshot)) }),
    sealSettings: s => Object.assign({}, s || {}),
    tabs: tabs,
    usedCount: {},
    nextTab: 4,
    activeId: '',
    showHome: false
  })
  const snippet = [
    sliceBlock(mainSrc, 'const seededTabIds = new Set()'),
    sliceBlock(mainSrc, 'function saveOpenApps()')
  ].join('\n\n')
  vm.runInContext(snippet + '\n\nglobalThis.__api = { saveOpenApps, seededTabIds }', box.ctx)
  return box
}

const TRIPLE = ['whatsapp-green-1', 'whatsapp-green-2', 'whatsapp-green-3']
const NAME = { 'whatsapp-green-1': '凯瑟琳', 'whatsapp-green-2': '卡罗琳', 'whatsapp-green-3': '江顺明星' }

function diskWith(user, ids) {
  const tabs = ids.map((id, i) => ({ id, platform: 'whatsapp', name: NAME[id], partition: `persist:pix-${user}-${id}`, index: i }))
  return { byUser: { [user]: { nextTab: 4, usedCount: { whatsapp: 3 }, activeId: ids[ids.length - 1] || '', showHome: false, tabs } } }
}

test('正常重启：三个账号全部保留', () => {
  const box = makeSandbox({ user: 'ahao', disk: diskWith('ahao', TRIPLE) })
  TRIPLE.forEach(id => box.build(id, NAME[id]))
  box.save()
  assert.deepEqual(box.ids(), TRIPLE)
})

test('恢复期间抢跑写盘（did-stop-loading 早于循环结束）：不删未建出的', () => {
  // 这是被证伪的"竞态"：即使真的抢跑，也不该丢。留作回归哨兵。
  const box = makeSandbox({ user: 'ahao', disk: diskWith('ahao', TRIPLE) })
  box.build(TRIPLE[0], NAME[TRIPLE[0]])       // 只建出第一个
  box.save()                                   // 模拟回调提前触发
  assert.deepEqual(box.ids().sort(), TRIPLE.slice().sort(), '未建出的账号被误删')
})

test('双副本：B 后写不能把 A 的账号冲掉', () => {
  const disk = diskWith('ahao', TRIPLE)
  const A = makeSandbox({ user: 'ahao', disk })
  TRIPLE.forEach(id => A.build(id, NAME[id]))
  const B = makeSandbox({ user: 'ahao', disk })
  TRIPLE.forEach(id => B.build(id, NAME[id]))
  B.save()
  A.save()
  assert.deepEqual(A.ids().sort(), TRIPLE.slice().sort())
})

test('恢复失败的 id 不登记（保留清理僵尸条目的能力）', () => {
  // 这条锁住 seededTabIds 的原语义：只有真的建出来的才算本实例管理。
  // 如果谁再改成"先登记再建"，平台下线的条目会永远堆在盘上。
  const restore = sliceBlock(mainSrc, 'function restoreOpenApps')
  const seedAt = restore.indexOf('seededTabIds.add(')
  const loopAt = restore.indexOf('restoreOneApp(row)')
  assert.ok(seedAt > loopAt, '登记必须在恢复之后 —— 否则恢复失败的 id 会被当成"本实例管理"')
})

// ---------------------------------------------------------------------------
// 事故复盘：账号真正丢失的路径
// ---------------------------------------------------------------------------

test('【复盘】启动时用户名为空 → 写盘不再触碰任何账号', () => {
  const box = makeSandbox({ user: 'ahao', disk: diskWith('ahao', TRIPLE) })
  box.user = ''          // 登录态没恢复出来
  box.build(TRIPLE[0], NAME[TRIPLE[0]])
  box.save()             // currentPixUser() 为空 → 直接 return
  assert.deepEqual(box.ids(), TRIPLE, '用户名缺失时绝不能写盘')
})

test('【复盘】用户名对不上（大小写 / 空格）→ 会写到一个新 key 上', () => {
  // 这正是本次事故的形态：open-apps.json 里出现 `byUser['ahao']` 与
  // `byUser[' demo']` 这类脏 key，原账号的 tabs 还在，但当前会话读的不是它。
  const box = makeSandbox({ user: 'AHao', disk: diskWith('ahao', TRIPLE) })
  box.build(TRIPLE[0], NAME[TRIPLE[0]])
  box.save()
  assert.deepEqual(box.store.file.byUser.ahao.tabs.map(r => r.id), TRIPLE, '原账号条目被改写')
  assert.deepEqual(box.store.file.byUser.AHao.tabs.map(r => r.id), [TRIPLE[0]], '新 key 被创建')
})

test('【复盘】内存与快照都是空 → 写盘就是清空，且无任何报错', () => {
  const box = makeSandbox({ user: 'ahao', disk: diskWith('ahao', []) })
  box.save()
  assert.deepEqual(box.ids(), [], '这是"账号消失"最终落盘的形态')
})

test('nextTab / usedCount 单调，不因旧快照倒退', () => {
  const box = makeSandbox({ user: 'ahao', disk: diskWith('ahao', TRIPLE) })
  box.ctx.nextTab = 2
  box.ctx.usedCount = { whatsapp: 1 }
  box.save()
  assert.equal(box.store.file.byUser.ahao.nextTab, 4, 'nextTab 倒退会生成重复 tab id / 分区名')
})
