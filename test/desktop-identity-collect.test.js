/**
 * 客户端身份采集的静态验证。
 *
 * `currentPeer()` 是整条身份链的入口 —— 它解析错了，
 * 后面所有的客户识别与撞单判断都是错的。但它写在 guest-inject.js 里，
 * 那个文件是 Electron preload（依赖 electron 模块、且运行在 sandbox 中），
 * 没法直接 require 进来测。
 *
 * 所以用静态提取：把函数源码从文件里抠出来，放进沙箱求值，再逐例验证。
 * 这样既不引入构建依赖，又能真正跑到那段代码本身 ——
 * 而不是在测试里重写一份"看起来一样"的副本。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'guest-inject.js'), 'utf8')

/**
 * 把身份解析相关的函数源码抠出来求值。
 *
 * 取两个函数而不是一个：`currentPeer` 现在按平台分发
 * （telegramPeer → whatsappPeer），只加载它会因为 telegramPeer 未定义而抛错。
 */
/**
 * 身份解析相关的函数源码。
 *
 * `whatsappPeer` 依赖 `conversationScope`，一起加载 —— 否则会在沙箱里
 * ReferenceError，测不到真正跑的那段代码。
 */
const PEER_FNS = ['telegramPeer', 'whatsappPeer', 'currentPeer', 'conversationScope']

/** 平台配置（`SITE`）：conversationScope 等函数按它取会话容器。 */
const SITE_SRC = SRC.slice(
  SRC.indexOf('// ==== SITE ADAPTERS BEGIN ===='),
  SRC.indexOf('// ==== SITE ADAPTERS END ====')
)

/**
 * 假 document。
 *
 * **必须提供 `#main`**：身份与客户解析只认当前会话。
 * raws 传 null 表示"页面上没有 #main"，此时一律返回 null，
 * 绝不退回整个 document —— 那样会把左侧会话列表里的私聊当成当前客户
 * （0.1.11 真机 P0：群聊自动翻译因此永不生效）。
 */
function fakeDocument(raws) {
  const rows = raws === null
    ? null
    : (Array.isArray(raws) ? raws : [raws]).map(raw => ({ getAttribute: () => raw }))
  const scope = rows === null ? null : { querySelectorAll: () => rows }
  return {
    querySelector: name => (name === '#main' ? scope : null),
    querySelectorAll: () => []
  }
}

function loadPeerFns() {
  const srcs = PEER_FNS.map(name => {
    const m = SRC.match(new RegExp('function ' + name + '\\(\\)\\s*\\{[\\s\\S]*?\\n  \\}'))
    assert.ok(m, `在 guest-inject.js 里找不到 ${name} —— 函数被改名或删掉了？`)
    return m[0]
  })
  const sandbox = { location: { hash: '' }, document: fakeDocument(null) }
  vm.createContext(sandbox)
  vm.runInContext(SITE_SRC + '\n' + srcs.join('\n') + '\nthis.__f = currentPeer', sandbox)
  return hash => { sandbox.location.hash = hash; sandbox.document = fakeDocument(null); return sandbox.__f() }
}

function loadCurrentPeer() { return loadPeerFns() }

test('Telegram peer id 能正确解析', () => {
  const peer = loadCurrentPeer()
  assert.equal(peer('#123456789').peerKey, '123456789')
  assert.equal(peer('#123456789').kind, 'peer_id')
  // 群组带前导负号：必须剥掉，否则同一个群在两次抓取里会得到两个身份
  assert.equal(peer('#-1001234567890').peerKey, '1001234567890')
  assert.equal(peer('#/123456789').peerKey, '123456789')
})

test('用户名归一为带 @ 的小写形式', () => {
  const peer = loadCurrentPeer()
  assert.equal(peer('#@alice_01').peerKey, '@alice_01')
  assert.equal(peer('#alice_01').peerKey, '@alice_01', '不带 @ 时也要补上，保证两种写法归一')
  assert.equal(peer('#@alice_01').kind, 'username')
})

test('拿不到可信身份时**返回 null**，绝不猜', () => {
  const peer = loadCurrentPeer()
  // 宁可漏采集，也不要制造一个错误的客户身份 ——
  // 错误身份会导致两个真人被合并，那是不可逆的
  for (const bad of ['#', '', '#abc', '#中文名', '#a b', '#@', '#--1']) {
    assert.equal(peer(bad), null, `${JSON.stringify(bad)} 不该被当成身份`)
  }
})

test('采集失败不得影响翻译主流程', () => {
  // reportClue 全程包在 try/catch 里；这里断言它确实没有裸抛的分支
  const m = SRC.match(/function reportClue\([\s\S]*?\n  \}/)
  assert.ok(m, '找不到 reportClue')
  assert.match(m[0], /try\s*\{[\s\S]*?\}\s*catch/, 'reportClue 必须包 try/catch —— 采集是尽力而为，不能拖垮翻译')
})

test('上报体不包含 platform / accountKey —— 由主进程按 webContents 反查填入', () => {
  const m = SRC.match(/function reportClue\([\s\S]*?\n  \}/)
  assert.ok(m, '找不到 reportClue')
  // 渲染进程在网页上下文里，可被页面脚本影响；让它自报"我是哪个账号"
  // 等于把归属权交给不可信的一侧
  assert.doesNotMatch(m[0], /platform:\s*platformId\(\)/, 'preload 不得自报 platform')
  assert.doesNotMatch(m[0], /accountKey:\s*accountKey\(\)/, 'preload 不得自报 accountKey')
})

test('撞单横幅先做 warn（不阻止操作）且跨商户不渲染同事信息', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'renderer', 'app.js'), 'utf8')
  const m = app.match(/function showCollisionBanner\([\s\S]*?\n\}/)
  assert.ok(m, '找不到 showCollisionBanner')
  const body = m[0]
  // warn 模式：不能有 disable / preventDefault / 阻止发送之类
  assert.doesNotMatch(body, /preventDefault|disabled\s*=|block/i, 'warn 阶段不得阻止操作')
  // 跨商户必须走匿名分支
  assert.match(body, /cross_merchant/, '必须区分跨商户与同商户')
})

test('WhatsApp 的 chatId 能解析出手机号，且**群聊必须排除**', () => {
  const srcs = ['whatsappPeer', 'conversationScope'].map(name => {
    const m = SRC.match(new RegExp('function ' + name + '\\(\\)\\s*\\{[\\s\\S]*?\\n  \\}'))
    assert.ok(m, '找不到 ' + name)
    return m[0]
  })
  const sandbox = { document: fakeDocument(null) }
  vm.createContext(sandbox)
  vm.runInContext(SITE_SRC + '\n' + srcs.join('\n') + '\nthis.__f = whatsappPeer', sandbox)
  const parse = raw => {
    sandbox.document = fakeDocument(raw)
    return sandbox.__f()
  }

  // 个人聊天：chatId 就是手机号，带国家码，不存在"猜国家码"的歧义
  const p1 = parse('false_8613800138000@c.us_3EB0ABC123')
  assert.equal(p1.peerKey, '8613800138000@c.us')
  assert.equal(p1.phone, '+8613800138000')
  assert.equal(p1.sourceMsgId, '3EB0ABC123', 'WhatsApp 能拿到平台原始消息 ID，必须带上')

  // 本人发出的消息同样能拿到对方 chatId
  assert.equal(parse('true_447911123456@c.us_ABCDEF').phone, '+447911123456')

  // 群聊：群里没有单一"客户"，当成客户会把整个群的人混成一个人
  assert.equal(parse('false_120363012345678901@g.us_XYZ'), null, '群聊必须排除')

  // 脏数据不能让整条链路出错
  assert.equal(parse('false_abc@c.us_XYZ'), null, '非数字 chatId 应跳过')
  assert.equal(parse('garbage'), null)
  assert.equal(parse(null), null)
})

test('没有 #main（拿不到当前会话）时绝不猜客户身份', () => {
  // 左侧会话列表的行也带 [data-id]；退回整个 document 就会把
  // "列表里第一个私聊"当成当前客户 —— 归属错人比漏采集严重得多。
  const srcs = ['whatsappPeer', 'conversationScope'].map(name => {
    const m = SRC.match(new RegExp('function ' + name + '\\(\\)\\s*\\{[\\s\\S]*?\\n  \\}')
    )
    assert.ok(m, '找不到 ' + name)
    return m[0]
  })
  const sandbox = {
    document: {
      // 有左侧列表的 data-id，但**没有 #main**
      querySelector: () => null,
      querySelectorAll: () => [{ getAttribute: () => 'false_8613800138000@c.us_3EB0' }]
    }
  }
  vm.createContext(sandbox)
  vm.runInContext(SITE_SRC + '\n' + srcs.join('\n') + '\nthis.__f = whatsappPeer', sandbox)
  assert.equal(sandbox.__f(), null, '没有 #main 时必须返回 null，不得退回 document')
})

test('拿不到 peer 时不生成 body 之外的任何身份猜测', () => {
  const m = SRC.match(/function reportClue\([\s\S]*?\n  \}/)
  assert.ok(m)
  // phone 必须来自 peer.phone（真实解析结果），不能从昵称之类的地方猜
  assert.match(m[0], /phone:\s*peer\.phone/, 'phone 必须取自解析结果')
  assert.doesNotMatch(m[0], /phone:\s*['"]/, 'phone 不得写死或从别处编造')
})
