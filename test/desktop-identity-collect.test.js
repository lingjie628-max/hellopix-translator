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

/** 从源码里抠出 currentPeer 函数体并求值 */
function loadCurrentPeer() {
  const m = SRC.match(/function currentPeer\(\)\s*\{[\s\S]*?\n  \}/)
  assert.ok(m, '在 guest-inject.js 里找不到 currentPeer —— 函数被改名或删掉了？')
  const sandbox = { location: { hash: '' } }
  vm.createContext(sandbox)
  vm.runInContext(m[0] + '\nthis.__f = currentPeer', sandbox)
  return hash => { sandbox.location.hash = hash; return sandbox.__f() }
}

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
