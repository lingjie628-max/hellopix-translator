'use strict'

/**
 * 应用级 IPC 的单元测试。
 *
 * 两条主线：
 *   1. 预设模板绝不能带代理 —— 那是实例级敏感配置，带进去就是
 *      下个新实例在别人的出口上聊。
 *   2. customer:ingest 的 platform / accountKey 必须由主进程按
 *      webContents 反查后覆盖，渲染层自报的一律作废。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { registerAppIpc } = require('../desktop/src/ipc/app')

function harness (opts) {
  const o = opts || {}
  const handlers = {}
  const unsafe = new Set()
  const calls = []
  const presets = o.presets ? JSON.parse(JSON.stringify(o.presets)) : {}

  registerAppIpc({
    reg: {
      handle: (ch, fn) => { handlers[ch] = fn },
      handleUnsafe: (ch, fn) => { handlers[ch] = fn; unsafe.add(ch) }
    },
    actions: {
      api: async (path, arg) => {
        calls.push(['api', path, arg])
        if (o.apiResult) return o.apiResult(path, arg)
        return { success: true }
      },
      sendKicked: msg => calls.push(['kicked', msg]),
      platformRows: () => o.rows || [{ id: 'wa' }],
      refreshPlatformUpdates: () => calls.push('refreshUpdates'),
      updatePlatformWeb: id => { calls.push(['updatePlatform', id]); return { success: true } },
      readPresets: () => JSON.parse(JSON.stringify(presets)),
      writePresets: all => { calls.push(['writePresets', all]); Object.assign(presets, all) },
      trustedTabSender: sender => (sender && sender.trusted ? { platform: 'wa' } : null),
      accountSlug: () => 'acc-1'
    },
    env: {
      APP_VERSION: '1.0.0',
      DOWNLOAD_HOSTS: ['download.example.com'],
      isAllowedExternalUrl: (url, hosts) => hosts.some(h => String(url).includes(h)),
      sealSettings: s => ({ sealed: s }),
      // 解密只是把 sealed 拿回来；脏模板（没 sealed）原样返回，
      // 这样能验证"摘代理发生在解密之前"
      unsealSettings: s => (s && s.sealed) || s || {},
      stripProxyFields: s => {
        const out = {}
        for (const k of Object.keys(s || {})) if (!/^proxy/i.test(k)) out[k] = s[k]
        return out
      }
    }
  })
  return { handlers, unsafe, calls, presets }
}

test('customer:* 归客页调用，必须走 handleUnsafe；其余走受保护 handle', () => {
  const { unsafe } = harness()
  assert.ok(unsafe.has('customer:ingest'))
  assert.ok(unsafe.has('customer:reminders'))
  for (const ch of ['app:platforms', 'app:preset', 'app:savePreset', 'app:version', 'app:checkUpdate']) {
    assert.equal(unsafe.has(ch), false, ch + ' 不该对客页开放')
  }
})

test('★ app:savePreset 存模板时摘掉代理字段', () => {
  const { handlers, presets } = harness()
  handlers['app:savePreset']({}, {
    platformId: 'wa',
    name: 'WhatsApp',
    settings: { proxyHost: '1.2.3.4', proxyPass: 'secret', lang: 'zh', fontSize: 15 }
  })
  const tpl = presets.wa
  assert.equal(tpl.name, 'WhatsApp')
  assert.equal(tpl.settings.sealed.proxyHost, undefined, '模板不能带代理主机')
  assert.equal(tpl.settings.sealed.proxyPass, undefined, '模板不能带代理密码')
  assert.equal(tpl.settings.sealed.lang, 'zh', '普通偏好要保留')
  assert.equal(tpl.settings.sealed.fontSize, 15)
})

test('app:savePreset 缺 platformId 时拒绝，不写空模板', () => {
  const { handlers, presets } = harness()
  const r = handlers['app:savePreset']({}, { name: 'x', settings: {} })
  assert.equal(r.success, false)
  assert.deepEqual(presets, {})
})

test('★ app:preset 读模板时先摘代理再解密（自愈旧的脏模板）', () => {
  // 模拟旧版本已经写进磁盘的带代理模板
  const dirty = { wa: { name: 'old', settings: { proxyHost: '9.9.9.9', proxyPass: 'leak', lang: 'en' } } }
  const { handlers } = harness({ presets: dirty })
  const r = handlers['app:preset']({}, 'wa')
  assert.equal(r.success, true)
  assert.equal(r.data.settings.proxyHost, undefined, '脏模板读出来也不能带代理')
  assert.equal(r.data.settings.proxyPass, undefined)
  assert.equal(r.data.settings.lang, 'en', '其他字段照常回传')
})

test('app:preset 不存在的模板返回 null（不是报错）', () => {
  const { handlers } = harness()
  assert.deepEqual(handlers['app:preset']({}, 'nope'), { success: true, data: null })
})

test('app:version 返回当前版本', () => {
  const { handlers } = harness()
  assert.equal(handlers['app:version']({}), '1.0.0')
})

/**
 * 域名白名单这一层单独测。
 *
 * 用降级模式（`PIX_ALLOW_UNSIGNED_UPDATE=1`）跑：下面两条断言关心的是
 * 「地址过不过白名单」，不是「清单有没有签名」。签名那一层由
 * test/update-signature.test.js 覆盖，两层各测各的，互不掩盖。
 */
test('app:checkUpdate 只接受信任域名下的下载地址（白名单层）', async () => {
  process.env.PIX_ALLOW_UNSIGNED_UPDATE = '1'
  const { handlers } = harness({
    apiResult: () => ({ success: true, version: '2.0.0', url: 'https://evil.com/x.dmg' })
  })
  const r = await handlers['app:checkUpdate']({})
  delete process.env.PIX_ALLOW_UNSIGNED_UPDATE
  assert.equal(r.remote, '2.0.0')
  assert.equal(r.url, '', '不信任的下载地址必须丢弃')
})

test('app:checkUpdate 接受信任域名（白名单层）', async () => {
  process.env.PIX_ALLOW_UNSIGNED_UPDATE = '1'
  const { handlers } = harness({
    apiResult: () => ({ success: true, version: '2.0.0', url: 'https://download.example.com/x.dmg' })
  })
  const r = await handlers['app:checkUpdate']({})
  delete process.env.PIX_ALLOW_UNSIGNED_UPDATE
  assert.equal(r.url, 'https://download.example.com/x.dmg')
})

/**
 * 严格模式：没签名清单就**不给下载地址**。
 *
 * 这条是新增行为的护栏。默认（没设 PIX_ALLOW_UNSIGNED_UPDATE）必须严格，
 * 否则「服务端还没升级」会被静默当成「可以降级」，加签名就白加了。
 */
test('app:checkUpdate 默认严格：没有签名清单就不给下载地址', async () => {
  delete process.env.PIX_ALLOW_UNSIGNED_UPDATE
  const { handlers } = harness({
    apiResult: () => ({ success: true, version: '2.0.0', url: 'https://download.example.com/x.dmg' })
  })
  const r = await handlers['app:checkUpdate']({})
  assert.equal(r.success, true)
  assert.equal(r.url, '', '没有签名清单时绝不能给下载地址')
  assert.ok(r.msg, '要告诉用户为什么不能下载')
})

test('app:checkUpdate 网络失败时仍回传本地版本（界面要能显示当前版本）', async () => {
  const { handlers } = harness({ apiResult: () => { throw new Error('down') } })
  const r = await handlers['app:checkUpdate']({})
  assert.equal(r.success, false)
  assert.equal(r.local, '1.0.0')
})

test('app:platforms 被踢时透传踢人消息', async () => {
  const { handlers, calls } = harness({
    apiResult: () => ({ kicked: true, msg: '在其他设备登录' })
  })
  const r = await handlers['app:platforms']({})
  assert.equal(r.success, true)
  assert.deepEqual(calls.find(c => c[0] === 'kicked'), ['kicked', '在其他设备登录'])
})

test('app:platforms 网络失败也返回本地列表（不能白屏）', async () => {
  const { handlers } = harness({
    apiResult: () => { throw new Error('down') },
    rows: [{ id: 'wa' }, { id: 'line' }]
  })
  const r = await handlers['app:platforms']({})
  assert.equal(r.success, true)
  assert.equal(r.rows.length, 2)
})

test('★ customer:ingest 拒绝不可信来源', async () => {
  const { handlers, calls } = harness()
  const r = await handlers['customer:ingest']({ sender: { trusted: false } }, { body: 'hi' })
  assert.equal(r.success, false)
  assert.match(r.msg, /未授权/)
  assert.equal(calls.filter(c => c[0] === 'api').length, 0)
})

test('★ customer:ingest 的身份由主进程覆盖，渲染层自报的值作废', async () => {
  const { handlers, calls } = harness({ apiResult: () => ({ success: true }) })
  await handlers['customer:ingest']({ sender: { trusted: true } }, {
    body: 'hi',
    platform: '伪造平台',
    accountKey: '伪造账号'
  })
  const form = calls.find(c => c[0] === 'api')[2].form
  assert.equal(form.platform, 'wa', 'platform 必须来自可信 tab')
  assert.equal(form.accountKey, 'acc-1', 'accountKey 必须来自主进程')
  assert.equal(form.body, 'hi', '业务字段照常透传')
})

test('★ 出向消息补 senderKey = 本账号（不是对方）', async () => {
  const { handlers, calls } = harness({ apiResult: () => ({ success: true }) })
  await handlers['customer:ingest']({ sender: { trusted: true } }, { direction: 'out', body: 'x' })
  const form = calls.find(c => c[0] === 'api')[2].form
  assert.equal(form.senderKey, 'acc-1')
})

test('入向消息不补 senderKey（对方身份由上游给）', async () => {
  const { handlers, calls } = harness({ apiResult: () => ({ success: true }) })
  await handlers['customer:ingest']({ sender: { trusted: true } }, { direction: 'in', body: 'x' })
  const form = calls.find(c => c[0] === 'api')[2].form
  assert.equal(form.senderKey, undefined)
})

test('customer:ingest 上报失败不影响聊天，但保留原因', async () => {
  const { handlers } = harness({ apiResult: () => { throw new Error('network') } })
  const r = await handlers['customer:ingest']({ sender: { trusted: true } }, { body: 'x' })
  assert.equal(r.success, false)
  assert.match(r.msg, /network/)
})

test('customer:reminders 失败时返回空数组（轮询不能炸）', async () => {
  const { handlers } = harness({ apiResult: () => { throw new Error('down') } })
  assert.deepEqual(await handlers['customer:reminders']({}), [])
})
