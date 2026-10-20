'use strict'

/**
 * 代理实例级隔离守卫。
 *
 * ## 被修的两个实例级串联问题
 *
 * **问题一：新建应用错误继承上一次代理。**
 * 根因不是"哪里复制了一个变量"，而是**代理被当成了模板内容**：
 *
 *   给 WhatsApp A 配了代理 X
 *     → 标签页设置连同代理被写进 app-presets.json（`app:savePreset` 存整份 settings）
 *     → 用户点「新增应用」，渲染进程拉该平台预设（`app:preset`，还会解密 proxyPass）
 *     → `fillAddForm` 把预设并进表单默认值 → 代理字段被填成 X
 *     → 新实例 B 带着 X 出生
 *
 * 还有一条更隐蔽的泄漏：`app:rename` 的兜底值是 `tab.settings` ——
 * 用户给实例**改个名字**，那条实例正在用的代理就被写进了模板。
 *
 * **问题二：实例必须完全独立。**
 * 审计结论是这一层本来就设计对了 —— `socksRelays` 按 `tab.id` 存、
 * `proxyAuthByWebContents` 按 `webContents.id` 存，没有任何全局共享代理状态
 * （无 currentProxy / lastProxy / sharedProxy / 全局 relay / 共享 auth 缓存）。
 * 下面 13、14 两项就是把这层"本来就对"的性质固化下来，防止以后被改坏。
 *
 * ## 怎么测
 *
 * 行为测试用一个**忠实复刻 main.js 语义**的小模拟器（模板读写 + 实例存储 + 中继 + 凭据），
 * 逻辑全部走真实的 `desktop/proxy-isolation.js`；同时用源码断言把
 * main.js / renderer/app.js 的接线钉死 —— 只测纯函数的话，接线退回老样子
 * （比如 `fillAddForm` 又去读 `settings.proxyType`）测试是发现不了的。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const isolation = require(path.join(root, 'desktop', 'src/proxy/proxy-isolation.js'))
const proxySettings = require(path.join(root, 'desktop', 'src/proxy/proxy-settings.js'))

const mainSrc = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
const appSrc = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'app.js'), 'utf8')

const { PROXY_FIELDS, DIRECT_PROXY, stripProxyFields, isDirectProxy } = isolation

// ---------------------------------------------------------------------------
// 模拟器：忠实复刻 main.js 的持久化与实例语义
// ---------------------------------------------------------------------------

const SEAL_PREFIX = 'safe:v1:'

/** 与 main.js 的 sealSettings 同构：有 safeStorage 就加密，否则**删掉** —— 绝不明文落盘。 */
function seal(settings) {
  const copy = Object.assign({}, settings || {})
  const password = String(copy.proxyPass || '')
  if (!password || password.startsWith(SEAL_PREFIX)) return copy
  copy.proxyPass = SEAL_PREFIX + Buffer.from('enc:' + password, 'utf8').toString('base64')
  return copy
}

function unseal(settings) {
  const copy = Object.assign({}, settings || {})
  const value = String(copy.proxyPass || '')
  if (!value.startsWith(SEAL_PREFIX)) return copy
  const raw = Buffer.from(value.slice(SEAL_PREFIX.length), 'base64').toString('utf8')
  copy.proxyPass = raw.startsWith('enc:') ? raw.slice(4) : ''
  return copy
}

/** 渲染进程的 defaultAppSettings()：新建实例的一切默认值，代理部分就是直连。 */
function defaultAppSettings() {
  return Object.assign({
    fontSize: 15,
    sendTo: 'en',
    recvTo: 'zh',
    engine: 'gpt',
    groupMode: 'manual'
  }, DIRECT_PROXY)
}

function makeApp() {
  const state = {
    tabs: new Map(),
    order: [],
    presets: {},
    nextTab: 1,
    usedCount: {},
    relays: new Map(),
    creds: new Map(),
    nextWcId: 1
  }

  const persisted = () => ({
    byUser: {
      t: {
        tabs: state.order.map(id => Object.assign({}, state.tabs.get(id), {
          settings: seal(state.tabs.get(id).settings)
        }))
      }
    }
  })

  const api = {
    state: state,
    persisted: persisted,

    /** app:savePreset —— 模板只留可继承的普通偏好，代理一律摘掉。 */
    savePreset(platformId, name, settings) {
      state.presets[platformId] = {
        name: name,
        settings: seal(stripProxyFields(settings))
      }
    },

    /** app:preset —— 读出来再摘一次（自愈旧版本磁盘上的带代理模板）。 */
    readPreset(platformId) {
      const row = state.presets[platformId]
      if (!row) return null
      return { name: row.name, settings: unseal(stripProxyFields(row.settings)) }
    },

    /** app:rename —— 兜底值以前是 tab.settings，会把实例的代理写进模板。 */
    rename(tabId, name) {
      const tab = state.tabs.get(tabId)
      const prev = state.presets[tab.platform] || {}
      state.presets[tab.platform] = {
        name: name,
        settings: seal(stripProxyFields(prev.settings || tab.settings || {}))
      }
    },

    /**
     * fillAddForm —— 渲染进程的表单填充。
     *
     * 普通偏好从模板继承（字体、语言、通道…），**代理只认直连初值**，
     * 不看模板也不看任何别的实例。
     */
    fillAddForm(platformId) {
      const preset = api.readPreset(platformId)
      const inherited = Object.assign(defaultAppSettings(), (preset && preset.settings) || {})
      const direct = defaultAppSettings()
      const form = Object.assign({}, inherited)
      for (const name of PROXY_FIELDS) form[name] = direct[name]
      return form
    },

    /** app:open —— 新实例：新 id、新 partition、新 session，设置来自表单。 */
    openPlatform(platformId, formValues) {
      const index = (state.usedCount[platformId] || 0) + 1
      state.usedCount[platformId] = index
      const id = platformId + '-' + state.nextTab
      state.nextTab += 1
      state.tabs.set(id, {
        id: id,
        platform: platformId,
        index: index,
        partition: 'persist:pix-t-' + platformId + '-' + index,
        wcId: state.nextWcId++,
        settings: Object.assign({}, formValues)
      })
      state.order.push(id)
      api.syncProxy(id)
      return id
    },

    /** updateTabSettings —— 只碰这一条实例。 */
    updateTabSettings(tabId, patch) {
      const tab = state.tabs.get(tabId)
      const before = Object.assign({}, tab.settings)
      tab.settings = Object.assign({}, before, patch || {})
      const changed = isolation.proxyFieldsChanged(before, tab.settings)
      if (changed) api.syncProxy(tabId)
      return { success: true, proxyChanged: changed }
    },

    /** 把这条实例的代理落成"正在生效的出口"，并挂上独立的凭据。 */
    syncProxy(tabId) {
      const tab = state.tabs.get(tabId)
      const s = tab.settings
      // 换线必须重建中继（key 覆盖 host/port/user/pass）
      if (!isDirectProxy(s)) {
        state.relays.set(tabId, { key: [s.proxyHost, s.proxyPort, s.proxyUser, s.proxyPass].join('|'), port: 40000 + state.relays.size })
        state.creds.set(tab.wcId, { host: s.proxyHost, port: s.proxyPort, user: s.proxyUser, pass: s.proxyPass })
      } else {
        state.relays.delete(tabId)
        state.creds.delete(tab.wcId)
      }
    },

    /** 出口 IP：直连就是本机，否则用代理标识代表它自己的出口。 */
    egress(tabId) {
      const tab = state.tabs.get(tabId)
      if (!tab) return null
      if (isDirectProxy(tab.settings)) return 'DIRECT'
      const relay = state.relays.get(tabId)
      return relay ? 'via:' + relay.key.split('|')[0] + '#' + relay.port : 'CONNECTING'
    },

    /** 重启：从 open-apps.json 恢复，每条实例带自己的代理。 */
    restart() {
      const fresh = makeApp()
      for (const row of persisted().byUser.t.tabs) {
        fresh.state.tabs.set(row.id, {
          id: row.id,
          platform: row.platform,
          index: row.index,
          partition: row.partition,
          wcId: fresh.state.nextWcId++,
          settings: unseal(row.settings)
        })
        fresh.state.order.push(row.id)
        fresh.state.usedCount[row.platform] = Math.max(fresh.state.usedCount[row.platform] || 0, row.index)
        const n = Number(String(row.id).split('-').pop())
        if (n) fresh.state.nextTab = Math.max(fresh.state.nextTab, n + 1)
        fresh.syncProxy(row.id)
      }
      fresh.state.presets = JSON.parse(JSON.stringify(state.presets))
      return fresh
    }
  }
  return api
}

function proxyX() {
  return { proxyType: 'socks5', proxyHost: '10.0.0.1', proxyPort: '1080', proxyUser: 'userA', proxyPass: 'passA' }
}
function proxyY() {
  return { proxyType: 'socks5', proxyHost: '10.0.0.2', proxyPort: '1081', proxyUser: 'userB', proxyPass: 'passB' }
}

// ---------------------------------------------------------------------------
// 验收 1-11：新建默认直连 + 实例之间互不影响 + 重启恢复
// ---------------------------------------------------------------------------

test('验收 1：新建 A → 默认 Direct', () => {
  const app = makeApp()
  const a = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  assert.equal(app.egress(a), 'DIRECT')
  assert.ok(isDirectProxy(app.state.tabs.get(a).settings), '新建实例必须是直连')
})

test('验收 2：A 设置 Proxy X', () => {
  const app = makeApp()
  const a = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(a, proxyX())
  assert.equal(app.egress(a), 'via:10.0.0.1#40000')
  assert.equal(app.state.relays.size, 1, 'A 应该有自己的中继')
})

test('验收 3：A 用了代理后，新建 B 必须仍然 Direct（修复前必挂）', () => {
  const app = makeApp()
  const a = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(a, proxyX())
  // 用户给 A 存了模板（改个设置就会走这条路），模板里**不能**留下代理
  app.savePreset('whatsapp-pro', 'WhatsApp', app.state.tabs.get(a).settings)
  const b = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  assert.equal(app.egress(b), 'DIRECT', '新建 B 继承了 A 的代理 —— 正是本次要修的缺陷')
  assert.equal(app.egress(a), 'via:10.0.0.1#40000', 'A 不受影响')
})

test('验收 4：B 设置 Proxy Y，A 与 B 各走各的', () => {
  const app = makeApp()
  const a = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(a, proxyX())
  const b = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(b, proxyY())
  const ipa = app.egress(a)
  const ipb = app.egress(b)
  assert.notEqual(ipa, ipb, 'A 与 B 的出口必须不同')
  assert.equal(ipa, 'via:10.0.0.1#40000')
  assert.match(ipb, /^via:10\.0\.0\.2#/)
  assert.equal(app.state.relays.size, 2, 'A/B 各有一个中继，不得共用')
})

test('验收 5：新建 C 仍然 Direct，且没有自己的 relay', () => {
  const app = makeApp()
  const a = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(a, proxyX())
  const b = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(b, proxyY())
  const c = app.openPlatform('telegram', app.fillAddForm('telegram'))
  assert.equal(app.egress(c), 'DIRECT')
  assert.equal(app.state.relays.has(c), false, '直连实例不该起中继')
  assert.equal(app.state.creds.has(app.state.tabs.get(c).wcId), false, '直连实例不该挂代理凭据')
})

test('验收 6：A/B/C 同时在线：A=X、B=Y、C=Direct，partition 全不同', () => {
  const app = makeApp()
  const a = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(a, proxyX())
  const b = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(b, proxyY())
  const c = app.openPlatform('telegram', app.fillAddForm('telegram'))
  assert.equal(app.egress(a), 'via:10.0.0.1#40000')
  assert.match(app.egress(b), /^via:10\.0\.0\.2#/)
  assert.equal(app.egress(c), 'DIRECT')
  const parts = new Set([a, b, c].map(id => app.state.tabs.get(id).partition))
  assert.equal(parts.size, 3, '三条实例的 partition 必须互不相同')
  const wcs = new Set([a, b, c].map(id => app.state.tabs.get(id).wcId))
  assert.equal(wcs.size, 3, '三条实例的 webContents 必须互不相同')
})

test('验收 7：修改 A → 只有 A 的出口变化', () => {
  const app = makeApp()
  const a = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(a, proxyX())
  const b = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(b, proxyY())
  const beforeA = app.egress(a)
  const beforeB = app.egress(b)
  const res = app.updateTabSettings(a, { proxyHost: '10.0.0.9', proxyPass: 'passA2' })
  assert.equal(res.proxyChanged, true, '改了代理必须触发重新应用')
  assert.notEqual(app.egress(a), beforeA, 'A 的出口应该变了')
  assert.equal(app.egress(b), beforeB, 'B 的出口不该受 A 影响')
})

test('验收 8 + 9：删除 A 代理 → 只 A 恢复直连，B 继续保持 Y', () => {
  const app = makeApp()
  const a = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(a, proxyX())
  const b = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(b, proxyY())
  app.updateTabSettings(a, Object.assign({}, DIRECT_PROXY))
  assert.equal(app.egress(a), 'DIRECT', 'A 应该恢复直连')
  assert.equal(app.state.relays.has(a), false, 'A 的中继应该被释放')
  assert.match(app.egress(b), /^via:10\.0\.0\.2#/, 'B 必须继续保持 Y')
  assert.equal(app.state.relays.size, 1, '只剩 B 的中继')
})

test('验收 10：重启后 A 保持最终状态、B 恢复 Y、C 保持 Direct', () => {
  const app = makeApp()
  const a = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(a, proxyX())
  const b = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(b, proxyY())
  const c = app.openPlatform('telegram', app.fillAddForm('telegram'))
  // A 后来又改了一次，重启必须恢复到**最终**状态
  app.updateTabSettings(a, { proxyHost: '10.0.0.7', proxyPort: '2080' })

  const restarted = app.restart()
  assert.match(restarted.egress(a), /^via:10\.0\.0\.7#/, 'A 要恢复自己的最终代理')
  assert.match(restarted.egress(b), /^via:10\.0\.0\.2#/, 'B 要恢复 Y')
  assert.equal(restarted.egress(c), 'DIRECT', 'C 要保持直连')
  // 恢复出来的代理凭据也必须各归各的
  assert.equal(restarted.state.creds.get(restarted.state.tabs.get(b).wcId).user, 'userB')
  assert.equal(restarted.state.creds.get(restarted.state.tabs.get(c).wcId), undefined)
})

test('验收 11：重启后再新增 D → 仍然 Direct，不允许出现 X 或 Y', () => {
  const app = makeApp()
  const a = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(a, proxyX())
  app.savePreset('whatsapp-pro', 'WhatsApp', app.state.tabs.get(a).settings)
  const b = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(b, proxyY())
  const restarted = app.restart()
  const d = restarted.openPlatform('whatsapp-pro', restarted.fillAddForm('whatsapp-pro'))
  const ds = restarted.state.tabs.get(d).settings
  assert.equal(restarted.egress(d), 'DIRECT')
  assert.ok(!JSON.stringify(ds).includes('10.0.0.1'), 'D 不允许带出上一实例的主机')
  assert.ok(!JSON.stringify(ds).includes('10.0.0.2'), 'D 不允许带出上一实例的主机')
  assert.equal(ds.proxyPass, '', 'D 不允许带出任何密码')
})

test('改名字不会把实例的代理泄漏进模板（app:rename 的兜底值）', () => {
  const app = makeApp()
  const a = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(a, proxyX())
  app.rename(a, '我的 WhatsApp')
  // 模板里不能有代理；再新建实例必须还是直连
  const stored = app.state.presets['whatsapp-pro'].settings
  for (const name of PROXY_FIELDS) {
    assert.equal(stored[name], undefined, '模板里不该有 ' + name)
  }
  const b = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  assert.equal(app.egress(b), 'DIRECT')
})

test('反例：旧写法必然串联 —— 证明两处修复缺一不可', () => {
  // 用修复前的写法复刻一遍缺陷，确认它真的会串联。
  // 这样"验收 3"才有意义：如果哪天有人把任一处改回去，这里描述的机制就会重现。
  const state = { presets: {}, nextTab: 1, usedCount: {} }
  const tabs = new Map()

  // 旧 app:savePreset —— 整份 settings 直接进模板
  const oldSavePreset = (platformId, settings) => {
    state.presets[platformId] = { name: '', settings: settings }
  }
  // 旧 fillAddForm —— 代理字段从 settings（默认值 + 模板）里读
  const oldFillAddForm = (platformId) => {
    const preset = state.presets[platformId]
    const settings = Object.assign(defaultAppSettings(), (preset && preset.settings) || {})
    const form = Object.assign({}, settings)
    form.proxyType = settings.proxyType || 'none'
    form.proxyHost = settings.proxyHost || settings.proxyNode || ''
    form.proxyPass = settings.proxyPass || ''
    return form
  }
  const oldOpen = (platformId, values) => {
    const index = (state.usedCount[platformId] || 0) + 1
    state.usedCount[platformId] = index
    const id = platformId + '-' + state.nextTab++
    tabs.set(id, { settings: Object.assign({}, values) })
    return id
  }

  const a = oldOpen('whatsapp-pro', Object.assign(defaultAppSettings(), proxyX()))
  oldSavePreset('whatsapp-pro', tabs.get(a).settings)   // ← 缺陷的入口
  const b = oldOpen('whatsapp-pro', oldFillAddForm('whatsapp-pro'))

  assert.equal(tabs.get(b).settings.proxyHost, '10.0.0.1',
    '旧写法下 B 应当继承 A 的主机 —— 缺陷没能复现，说明这个反例写错了')
  assert.equal(tabs.get(b).settings.proxyPass, 'passA', '旧写法下连密码也一起继承')
  assert.ok(!isDirectProxy(tabs.get(b).settings), '旧写法下 B 不是直连')

  // 两处修复各自都能单独挡住这次串联 —— 所以它们是互补的，不是二选一
  // ① 模板摘代理：旧表单逻辑也拿不到代理
  const stripped = stripProxyFields(tabs.get(a).settings)
  const viaStrip = Object.assign(defaultAppSettings(), stripped)
  assert.ok(isDirectProxy(viaStrip), '模板摘干净后，即使旧的表单逻辑也不该继承到代理')
  // ② 表单只认直连初值：模板里残留代理也不会被带进去
  const viaForm = Object.assign(defaultAppSettings(), tabs.get(a).settings)
  for (const name of PROXY_FIELDS) viaForm[name] = DIRECT_PROXY[name]
  assert.ok(isDirectProxy(viaForm), '表单只认直连初值后，模板残留代理也带不进来')
})

test('磁盘上的旧模板（带代理）读出来也会被摘干净 —— 自愈', () => {
  const app = makeApp()
  // 模拟升级前写下的模板：整份 settings，含代理与加密后的密码
  app.state.presets['whatsapp-pro'] = {
    name: 'WhatsApp',
    settings: seal(Object.assign({ fontSize: 16, engine: 'deepseek' }, proxyX()))
  }
  const preset = app.readPreset('whatsapp-pro')
  for (const name of PROXY_FIELDS) {
    assert.equal(preset.settings[name], undefined, '旧模板的 ' + name + ' 必须被摘掉')
  }
  // 可继承的普通偏好仍然保留
  assert.equal(preset.settings.fontSize, 16)
  assert.equal(preset.settings.engine, 'deepseek')
  const form = app.fillAddForm('whatsapp-pro')
  assert.equal(form.fontSize, 16, '普通偏好照常继承')
  assert.equal(form.engine, 'deepseek')
  assert.ok(isDirectProxy(form), '表单的代理必须是直连')
})

// ---------------------------------------------------------------------------
// 验收 12-14：落盘与共享资源
// ---------------------------------------------------------------------------

test('验收 12：proxyPass 不得明文落盘（模板与实例存储都是）', () => {
  const app = makeApp()
  const a = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(a, proxyX())
  app.savePreset('whatsapp-pro', 'WhatsApp', app.state.tabs.get(a).settings)

  const presetJson = JSON.stringify(app.state.presets)
  assert.ok(!presetJson.includes('passA'), '模板里出现了明文密码：' + presetJson)
  const storeJson = JSON.stringify(app.persisted())
  assert.ok(storeJson.includes(SEAL_PREFIX), '实例存储里的密码应当是封装的')
  assert.ok(!storeJson.includes('"proxyPass":"passA"'), '实例存储里出现了明文密码')
  // 解封后能拿回原值（否则重启就丢密码）
  assert.equal(unseal(app.persisted().byUser.t.tabs[0].settings).proxyPass, 'passA')

  // 真实的 sealSettings 也必须走 safeStorage，拿不到就删掉 —— 绝不退回明文
  assert.match(mainSrc, /safeStorage\.encryptString\(password\)/, 'sealSettings 没有用 safeStorage 加密')
  assert.match(mainSrc, /} else \{\s*\n\s*delete copy\.proxyPass/, '拿不到 safeStorage 时必须删掉密码，而不是留明文')
  assert.match(mainSrc, /settings: sealSettings\(t\.settings\)/, '实例存储没有封装 proxyPass')
})

test('验收 13：不同实例不得共享 SOCKS relay', () => {
  // 产品侧：中继按 tab.id 存，key 覆盖 host/port/账密
  assert.match(mainSrc, /const socksRelays = new Map\(\)\s*\/\/ tab\.id/, 'socksRelays 不是按 tab.id 存的')
  assert.match(mainSrc, /function relayKeyOf\(target\) \{\s*\n\s*return \[target\.host, target\.port, target\.user, target\.pass\]/,
    'relayKeyOf 必须覆盖 host/port/账密 —— 少了哪一项都会"改了还在用旧隧道"')
  assert.match(mainSrc, /await releaseSocksRelay\(tab\)/, '重建中继前没有释放旧的')
  // destroyTab 里还会做别的清理（比如翻译桥看门狗的定时器），所以只要求
  // "两件事都做了"，不把顺序和相邻性钉死 —— 那种断言会在无关改动上误报。
  const destroyBody = mainSrc.slice(mainSrc.indexOf('function destroyTab(tab) {'))
  const destroyHead = destroyBody.slice(0, destroyBody.indexOf('\n}'))
  assert.match(destroyHead, /stopSshTunnel\(tab\)/, '关闭实例时要停掉 SSH 隧道')
  assert.match(destroyHead, /releaseSocksRelay\(tab\)/, '关闭实例时必须释放它自己的中继')
  // 不得存在全局共享的中继
  assert.ok(!/const\s+\w*relay\w*\s*=\s*\{\s*\}/i.test(mainSrc), '出现了全局共享的 relay 对象')

  // 行为侧：两条实例用不同代理时，中继是两份、端口不同
  const app = makeApp()
  const a = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(a, proxyX())
  const b = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(b, proxyY())
  assert.equal(app.state.relays.size, 2)
  assert.notEqual(app.state.relays.get(a).port, app.state.relays.get(b).port)
  // 即使两条实例配了**同一个**代理，中继也必须是两份（不共用隧道、不串凭据）
  const c = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(c, proxyX())
  assert.equal(app.state.relays.size, 3)
})

test('验收 14：不同实例不得共享代理认证凭据', () => {
  // 产品侧：凭据按触发挑战的那个 webContents 查，而不是任何全局变量
  assert.match(mainSrc, /const proxyAuthByWebContents = new Map\(\)\s*\/\/ webContents\.id/, '凭据表不是按 webContents.id 存的')
  assert.match(mainSrc, /if \(!authInfo \|\| authInfo\.isProxy !== true\) return/,
    '必须只接管代理认证，站点自己的 Basic Auth 一律放行')
  const loginAt = mainSrc.indexOf("app.on('login', (event")
  assert.ok(loginAt > 0, '找不到 app.on(login) 处理器（注意别匹配到注释里的那处）')
  const login = mainSrc.slice(loginAt, loginAt + 700)
  assert.match(login, /proxyAuthByWebContents\.get\(webContents\.id\)/, '凭据没有按 webContents 精确取')
  assert.match(login, /const tab = tabOfWebContents\(webContents\)/, '没有反查所属实例')
  assert.ok(!/proxyAuthByWebContents\.get\(\s*['"]/.test(mainSrc), '凭据表里出现了写死的 key')
  assert.ok(!/\blastProxy\b|\bcurrentProxy\b|\bsharedProxy\b/.test(mainSrc),
    '存在全局共享代理状态（lastProxy/currentProxy/sharedProxy）')

  // 行为侧：A 的账密不可能被 B 取到
  const app = makeApp()
  const a = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(a, proxyX())
  const b = app.openPlatform('whatsapp-pro', app.fillAddForm('whatsapp-pro'))
  app.updateTabSettings(b, proxyY())
  const wcA = app.state.tabs.get(a).wcId
  const wcB = app.state.tabs.get(b).wcId
  assert.notEqual(wcA, wcB)
  assert.equal(app.state.creds.get(wcA).pass, 'passA')
  assert.equal(app.state.creds.get(wcB).pass, 'passB')
  // 删除 A 的代理不会动到 B 的凭据
  app.updateTabSettings(a, Object.assign({}, DIRECT_PROXY))
  assert.equal(app.state.creds.get(wcA), undefined)
  assert.equal(app.state.creds.get(wcB).pass, 'passB', 'B 的凭据不该被 A 的删除影响')
})

// ---------------------------------------------------------------------------
// 接线：纯函数对了，接线错了照样出问题
// ---------------------------------------------------------------------------

test('模板的三个写入/读取口子都摘了代理', () => {
  // app:rename 在 src/ipc/tabs.js；app:preset / app:savePreset 在 src/ipc/app.js
  const tabsSrc = fs.readFileSync(
    path.join(__dirname, '..', 'desktop', 'src', 'ipc', 'tabs.js'), 'utf8')
  const appSrc = fs.readFileSync(
    path.join(__dirname, '..', 'desktop', 'src', 'ipc', 'app.js'), 'utf8')
  // app:preset —— 注意必须是 `unsealSettings(stripProxyFields(...))`：
  // 摘代理这一步要**嵌在解密里面**，模板里的密码连解密都不会走到。
  assert.match(appSrc, /unsealSettings\(env\.stripProxyFields\(row\.settings\)\)/,
    'app:preset 没有先摘代理再解密')
  assert.match(appSrc, /sealSettings\(env\.stripProxyFields\(\(payload && payload\.settings\) \|\| \{\}\)\)/,
    'app:savePreset 没有摘代理')
  assert.match(tabsSrc, /sealSettings\(env\.stripProxyFields\(prev\.settings \|\| tab\.settings \|\| \{\}\)\)/,
    'app:rename 的兜底值没有摘代理')
})

test('渲染层：新增应用表单的代理字段只认直连初值', () => {
  const fillAt = appSrc.indexOf('function fillAddForm(')
  assert.ok(fillAt > 0, '找不到 fillAddForm')
  const fill = appSrc.slice(fillAt, appSrc.indexOf('function readAddSettings(', fillAt))
  // 代理字段绝不能再从 settings（= 默认值 + 模板）里读
  for (const name of PROXY_FIELDS) {
    assert.ok(!new RegExp('value = settings\\.' + name + '\\b').test(fill),
      '代理字段 ' + name + ' 又在从继承来的 settings 里读了')
    assert.ok(!new RegExp('checked = !!settings\\.' + name + '\\b').test(fill),
      '代理字段 ' + name + ' 又在从继承来的 settings 里读了')
  }
  assert.match(fill, /const direct = defaultAppSettings\(\)/, '代理字段没有走直连初值')
  assert.match(fill, /addProxyType\.value = direct\.proxyType/)
  assert.match(fill, /addProxyHost\.value = direct\.proxyHost/)
  assert.match(fill, /addProxyPass\.value = direct\.proxyPass/)
  // 普通偏好必须照常继承（不能矫枉过正，把字体/语言也一起干掉）
  assert.match(fill, /addFontSize\.value = String\(settings\.fontSize \|\| 15\)/, '普通偏好被误伤')
  assert.match(fill, /addProxyChannel\.value = direct\.proxyChannel/)
})

test('代理字段清单：隔离口径必须覆盖 proxy-settings 的清单', () => {
  // 两份清单解决的问题不同，但必须保持包含关系。
  // 往 proxy-settings 加字段却忘了同步这里 → 新字段会悄悄跨实例继承。
  for (const name of proxySettings.PROXY_FIELDS) {
    assert.ok(PROXY_FIELDS.includes(name),
      'proxy-settings.PROXY_FIELDS 里的 ' + name + ' 不在隔离清单里 —— 它会跨实例继承')
  }
  // 直连初值必须覆盖全部代理字段，且默认就是直连
  for (const name of PROXY_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(DIRECT_PROXY, name),
      'DIRECT_PROXY 缺字段 ' + name)
  }
  assert.ok(isDirectProxy(DIRECT_PROXY), 'DIRECT_PROXY 本身必须是直连')
  assert.ok(isDirectProxy({}), '空设置必须判为直连')
  assert.ok(!isDirectProxy({ proxyType: 'socks5', proxyHost: 'h' }))
})

test('实例存储必须保留代理（否则重启恢复不了）', () => {
  // 隔离的目标是"实例之间"和"模板到实例"，不是"实例到磁盘"。
  // 一旦有人顺手也给 open-apps.json 摘了代理，重启就会全部退回直连。
  assert.match(mainSrc, /function saveOpenApps\(\)/, '找不到 saveOpenApps')
  const saveAt = mainSrc.indexOf('function saveOpenApps()')
  const save = mainSrc.slice(saveAt, mainSrc.indexOf('function platformHomeUrl', saveAt))
  assert.ok(!save.includes('stripProxyFields'), 'saveOpenApps 不该摘代理 —— 各实例要记住自己的代理')
  assert.match(save, /settings: sealSettings\(t\.settings\)/, '实例设置应当封装后落盘')
})
