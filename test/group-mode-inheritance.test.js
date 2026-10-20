'use strict'

/**
 * 群组翻译「三态」与实例级设置持久化守卫。
 *
 * ## 被修的两个真机缺陷（macOS 0.1.11，新子账号）
 *
 * 1. **「我明明切了自动，群消息就是不翻」**
 *    群组翻译有两个开关：账号级 `trans_group`（服务端）与实例级
 *    `tab.settings.groupMode`。老实现只有两态，且实例级**无条件覆盖**账号级：
 *
 *        transGroup: hasTab ? s.groupMode === 'auto' : g.transGroup
 *
 *    而新建实例的 `groupMode` 被硬编码成 `'manual'`。于是账号里开着自动，
 *    实例一建出来就把它**静默压成手动** —— 界面显示"自动"也不会翻。
 *    修法：引入第三态 `'inherit'`（跟随账号级），新建实例默认取它。
 *
 * 2. **「设置改了却没保存」**
 *    两个独立的丢失点：
 *      · `saveOpenApps()` 整段覆盖 `tabs`：同一账号开两个副本时，后写的那个
 *        用自己内存里的旧 tabs 把另一个副本刚改的设置盖回去；
 *      · `paintTransBar()` 的 `transBarSilent` 闸门没有 try/finally：中间一抛
 *        异常就永远停在 true，之后用户在翻译栏改的任何东西都被静默丢弃。
 *
 * ## 为什么 `inherit` 不能当存量实例的默认值
 *
 * 账号级 `trans_group` 的库默认是 **true**（migration 003）。把"没有显式选择"
 * 解释成"跟随账号"，等于给所有存量实例**打开自动扣费**。所以：
 * 字段缺失一律按 `'manual'`，只有**新建**实例才拿到 `'inherit'`。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
const appSrc = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'app.js'), 'utf8')
const htmlSrc = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'index.html'), 'utf8')

/**
 * 从源码里切出 `header` 那段定义（函数按花括号配对，常量取整行）。
 *
 * 不猜行号 —— 行号会随任何一次无关编辑漂走，测试得跟着源码结构走。
 */
function sliceBlock(src, header) {
  const start = src.indexOf(header)
  assert.ok(start >= 0, '找不到源码片段：' + header)
  const lineEnd = src.indexOf('\n', start)
  const line = src.slice(start, lineEnd)
  // ⚠️ `line.indexOf('{')` 是**行内**下标，必须加上 `start` 才是源码里的位置。
  // 用行内下标去遍历 src 会从文件开头附近的某个花括号开始配平，切出一段
  // 毫不相干的代码 —— 而且不报错，只是被测函数"不存在"。
  const open = line.indexOf('{')
  if (open < 0) return line
  let depth = 0
  for (let i = start + open; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error('花括号不配对：' + header)
}

/**
 * 在隔离的 vm 上下文里跑 `groupModeOf` / `resolveGroupEnabled` 的**真身**。
 *
 * 这两个是纯函数，直接执行比断言源码里"有没有那几个词"强得多 ——
 * 源码断言在改名、抽公共函数这类重构时会误报。
 */
/**
 * 加载群组三态的**真身**。
 *
 * 原先从 main.js 切 3 个源码块塞进 VM。这块逻辑已经搬进
 * desktop/src/window/instance-prefs.js（纯函数、零依赖），直接 require 即可 ——
 * 测的是产品实际调用的实现，不再是一份复制出来的源码。
 */
function loadGroupModeHelpers () {
  const mod = require('../desktop/src/window/instance-prefs')
  return {
    GROUP_MODES: mod.GROUP_MODES,
    groupModeOf: mod.groupModeOf,
    resolveGroupEnabled: mod.resolveGroupEnabled
  }
}

/**
 * 在隔离上下文里跑 `saveOpenApps` 的真身，验证"合并而非覆盖"。
 *
 * 这是**并发写丢失**，只在同一账号开两个副本时出现。源码断言抓不到，
 * 必须真的造出"磁盘上已经有另一个副本的 tab"这个局面。
 */
function makeOpenAppsSandbox(seed) {
  const store = { file: JSON.parse(JSON.stringify(seed)) }
  const ctx = vm.createContext({
    currentPixUser: () => 'alice',
    openAppsFile: () => 'open-apps.json',
    readJson: (file, def) => (store.file === undefined ? def : JSON.parse(JSON.stringify(store.file))),
    writeJson: (file, data) => { store.file = JSON.parse(JSON.stringify(data)) },
    // saveOpenApps 通过 openAppsStore().get() 读、writeJson 写。
    // 这里让 store 的读也走同一份内存文件，保持"读到的就是上一次写下的"语义。
    openAppsStore: () => ({
      get: def => (store.file === undefined ? def : JSON.parse(JSON.stringify(store.file)))
    }),
    sealSettings: s => Object.assign({}, s || {}),
    tabs: [],
    usedCount: {},
    nextTab: 1,
    activeId: '',
    showHome: false
  })
  const snippet = [
    sliceBlock(mainSrc, 'const seededTabIds = new Set()'),
    sliceBlock(mainSrc, 'function saveOpenApps()')
  ].join('\n\n')
  vm.runInContext(snippet + '\n\nglobalThis.__api = { saveOpenApps, seededTabIds }', ctx)
  return {
    ctx,
    store,
    save: () => vm.runInContext('__api.saveOpenApps()', ctx),
    seeded: id => ctx.__api.seededTabIds.add(String(id))
  }
}

function diskTabIds(store) {
  return store.file.byUser.alice.tabs.map(row => row.id)
}

function seededUser(nextTab, usedCount, tabs) {
  return {
    byUser: {
      alice: { nextTab, usedCount, activeId: '', showHome: false, tabs }
    }
  }
}

// ---------------------------------------------------------------------------
// 1. 三态判定
// ---------------------------------------------------------------------------

test('新建实例的默认群组模式是 inherit，不是写死的 manual', () => {
  const { groupModeOf } = loadGroupModeHelpers()
  assert.match(appSrc, /groupMode: 'inherit'/,
    '新建实例必须默认「跟随账号」，否则账号级开了自动也会被压成手动')
  assert.equal(groupModeOf({ groupMode: 'inherit' }), 'inherit')
})

test('存量实例（字段缺失 / 非法值）一律按 manual，绝不能默认成 inherit', () => {
  const { groupModeOf } = loadGroupModeHelpers()
  assert.equal(groupModeOf({}), 'manual', '缺字段必须按手动')
  assert.equal(groupModeOf(undefined), 'manual', '整个 settings 缺失也按手动')
  assert.equal(groupModeOf(null), 'manual')
  assert.equal(groupModeOf({ groupMode: 'MANUAL' }), 'manual', '非法值不能被当合法值放行')
  assert.equal(groupModeOf({ groupMode: 'yes' }), 'manual')
  assert.equal(groupModeOf({ groupMode: '' }), 'manual')
})

test('inherit 跟随账号级：账号开着自动就自动，账号关着就不自动', () => {
  const { resolveGroupEnabled } = loadGroupModeHelpers()
  assert.equal(resolveGroupEnabled({ groupMode: 'inherit' }, { transGroup: true }), true,
    '账号开着自动时，跟随账号的实例必须真的自动 —— 这正是真机上"切了自动却不翻"的那个断点')
  assert.equal(resolveGroupEnabled({ groupMode: 'inherit' }, { transGroup: false }), false)
  assert.equal(resolveGroupEnabled({ groupMode: 'inherit' }, null), false,
    '账号级拿不到时宁可不翻，也不能误扣')
})

test('实例级显式选择必须压过账号级（两个方向都要能压）', () => {
  const { resolveGroupEnabled } = loadGroupModeHelpers()
  // 账号关着，实例强行自动 —— 用户在这个实例上的明确意图优先
  assert.equal(resolveGroupEnabled({ groupMode: 'auto' }, { transGroup: false }), true)
  // 账号开着，实例强行手动 —— 止损开关，绝不能被账号级翻回来（否则会误扣字符）
  assert.equal(resolveGroupEnabled({ groupMode: 'manual' }, { transGroup: true }), false,
    '手动是计费止损开关，任何情况下都不允许被账号级覆盖成自动')
})

test('存量实例不会因为升级而被"顺带"打开自动扣费', () => {
  const { resolveGroupEnabled } = loadGroupModeHelpers()
  // 存量实例：settings 里没有 groupMode；账号级默认是 true（migration 003）
  const legacy = { enableTranslate: true, sendTo: 'en' }
  assert.equal(resolveGroupEnabled(legacy, { transGroup: true }), false,
    '缺字段解释成"跟随账号"= 给所有存量实例打开自动扣费；拿别人的钱做默认值不可接受')
})

// ---------------------------------------------------------------------------
// 2. 实例级设置持久化
// ---------------------------------------------------------------------------

test('saveOpenApps 不再整段覆盖 tabs：另一个副本的行必须保留', () => {
  const seed = seededUser(5, { telegram: 2 }, [
    { id: 'other-tab', platform: 'telegram', settings: { groupMode: 'auto' } }
  ])
  const box = makeOpenAppsSandbox(seed)
  // 本副本只动自己的 tab，从没见过 other-tab
  box.ctx.tabs.push({ id: 'mine', platform: 'whatsapp', settings: { groupMode: 'auto' } })
  box.seeded('mine')
  box.save()

  const ids = diskTabIds(box.store)
  assert.ok(ids.includes('other-tab'),
    '别的副本的实例被覆盖掉了 —— 这正是真机上"设置保存了却没生效"')
  assert.ok(ids.includes('mine'), '本副本的实例必须写进去')
})

test('saveOpenApps 会删掉"本副本恢复过、但已关闭"的 tab', () => {
  const seed = seededUser(5, {}, [
    { id: 'closed', platform: 'telegram', settings: {} },
    { id: 'foreign', platform: 'telegram', settings: {} }
  ])
  const box = makeOpenAppsSandbox(seed)
  // 本副本恢复过 closed（已登记），用户随后把它关了（不在内存 tabs 里）
  box.seeded('closed')
  box.save()

  const ids = diskTabIds(box.store)
  assert.equal(ids.includes('closed'), false, '本副本关掉的实例必须从磁盘消失')
  assert.ok(ids.includes('foreign'), '没见过的实例属于另一个副本，不能顺手删掉')
})

test('本副本改过的设置不会被磁盘上的旧值盖回去', () => {
  const seed = seededUser(5, {}, [
    { id: 'shared', platform: 'whatsapp', settings: { groupMode: 'manual' } }
  ])
  const box = makeOpenAppsSandbox(seed)
  // 本副本把同一个实例改成自动
  box.ctx.tabs.push({ id: 'shared', platform: 'whatsapp', settings: { groupMode: 'auto' } })
  box.seeded('shared')
  box.save()

  const row = box.store.file.byUser.alice.tabs.find(t => t.id === 'shared')
  assert.equal(row.settings.groupMode, 'auto', '本副本内存里的新值必须胜出（内存优先于磁盘）')
  assert.equal(box.store.file.byUser.alice.tabs.length, 1, '同名实例不能被写成两条')
})

test('restoreOneApp 失败的 id 不登记，避免保存时把别人的实例删掉', () => {
  const body = sliceBlock(mainSrc, 'function restoreOpenApps')
  const forEachAt = body.indexOf('data.tabs.forEach')
  const seedAt = body.indexOf('tabs.forEach(t => seededTabIds.add(String(t.id)))')
  assert.ok(seedAt > 0, 'seededTabIds 必须在恢复后登记，否则合并逻辑无从判断"谁是我管的"')
  assert.ok(seedAt > forEachAt,
    '先登记再恢复会把"恢复失败"的 id 也算成自己管的 —— 保存时它会被删掉，那是数据丢失')
})

test('nextTab / usedCount 单调合并，不因另一个副本写盘而倒退', () => {
  const seed = seededUser(20, { telegram: 7, whatsapp: 3 }, [])
  const box = makeOpenAppsSandbox(seed)
  // 本副本内存里的计数器落后于磁盘（另一个副本已经开过更多实例）
  box.ctx.nextTab = 4
  box.ctx.usedCount = { telegram: 2, whatsapp: 9 }
  box.save()

  const row = box.store.file.byUser.alice
  assert.equal(row.nextTab, 20, 'nextTab 倒退会生成重复 tab id / 重复分区名')
  assert.equal(row.usedCount.telegram, 7, '按槽位取大值')
  assert.equal(row.usedCount.whatsapp, 9, '本副本更大的计数要被保留')
})

// ---------------------------------------------------------------------------
// 3. 渲染进程：闸门与下拉
// ---------------------------------------------------------------------------

test('paintTransBar 的 transBarSilent 闸门必须有 try/finally', () => {
  const body = sliceBlock(appSrc, 'function paintTransBar')
  const closeAt = body.indexOf('} finally {')
  assert.ok(closeAt > 0,
    '闸门没有 try/finally：中途一抛异常，之后用户改的每一项设置都会被静默丢弃')
  assert.match(body.slice(closeAt), /transBarSilent = false/,
    'finally 里必须把闸门放回 false')
  // 裸的 `transBarSilent = false` 不能出现在 finally 之外
  assert.equal(/transBarSilent = false/.test(body.slice(0, closeAt)), false,
    '不能再有裸的 transBarSilent = false')
})

test('渲染进程的 groupModeUiValue 认三态，且缺省回落 manual', () => {
  const ctx = vm.createContext({})
  vm.runInContext(
    sliceBlock(appSrc, 'function groupModeUiValue(mode)') + '\n\nglobalThis.__f = groupModeUiValue',
    ctx
  )
  assert.equal(ctx.__f('inherit'), 'inherit')
  assert.equal(ctx.__f('auto'), 'auto')
  assert.equal(ctx.__f('manual'), 'manual')
  assert.equal(ctx.__f(undefined), 'manual',
    '老实例缺字段时不能回落到 inherit（会把手动实例变成自动）')
  assert.equal(ctx.__f(''), 'manual')
  assert.equal(ctx.__f('AUTO'), 'manual')
})

test('两个「群组翻译」下拉都提供「跟随账号」，否则用户永远切不回继承态', () => {
  const bar = htmlSrc.match(/<select id="barGroupMode">[\s\S]*?<\/select>/)
  const add = htmlSrc.match(/<select id="addGroupMode">[\s\S]*?<\/select>/)
  assert.ok(bar, '找不到翻译栏的 groupMode 下拉')
  assert.ok(add, '找不到新建实例的 groupMode 下拉')
  for (const [name, block] of [['barGroupMode', bar[0]], ['addGroupMode', add[0]]]) {
    assert.match(block, /value="inherit"/, name + ' 缺少 inherit 选项')
    assert.match(block, /value="auto"/, name + ' 缺少 auto 选项')
    assert.match(block, /value="manual"/, name + ' 缺少 manual 选项')
  }
})
