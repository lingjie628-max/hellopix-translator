'use strict'

/**
 * 渲染层纯函数。
 *
 * app.js 本身跑不进单测（依赖 DOM 和 window.pix），但这些恰好是
 * 最容易出错的一类：版本号比较、代理链接解析、语种排序、错误文案映射。
 * 以前验证方式只有"装个包点一遍"。
 *
 * ## 怎么 require
 *
 * pure.js 是传统 <script>，没有 module.exports。这里用 vm 在
 * 一个干净的上下文里执行它，拿到同名的顶层绑定 —— 和浏览器里的
 * 语义一致（顶层 const 是脚本作用域，不是 window 属性）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const src = fs.readFileSync(
  path.join(__dirname, '..', 'desktop', 'renderer', 'pure.js'), 'utf8')

const EXPORTS = '({friendlyError,cmpVer,esc,langDisplayName,orderedLangs,' +
  'langOptionHtml,groupModeUiValue,speedText,speedClass,formatProxyTime,' +
  'parseProxyLine,LANGS,LANG_PRIORITY})'

/** 每个用例单独跑一份，避免互相污染。 */
function load () {
  const ctx = vm.createContext({ console })
  vm.runInContext(src, ctx)
  return vm.runInContext(EXPORTS, ctx)
}

const P = load()

/** vm 里造的对象原型不同，比较前转成普通对象 */
const plain = o => JSON.parse(JSON.stringify(o))

// ---------------------------------------------------------------- friendlyError

test('friendlyError：剥掉 Electron 的 "Error invoking remote method" 包装', () => {
  const e = new Error("Error invoking remote method 'auth:login': Error: 密码错误")
  assert.equal(P.friendlyError(e, '失败'), '密码错误',
    '不该把方法名和错误分层泄漏给用户')
})

test('friendlyError：套了好几层也能剥干净', () => {
  const e = new Error("Error invoking remote method 'a': Error: Error: Error: 真话")
  assert.equal(P.friendlyError(e, 'x'), '真话')
})

test('known 文案：网络类错误换成可行动的提示', () => {
  assert.match(P.friendlyError('getaddrinfo ENOTFOUND api.x.com', 'x'), /无法解析服务器地址/)
  assert.match(P.friendlyError('connect ECONNREFUSED 127.0.0.1:3000', 'x'), /连接服务器超时/)
  assert.match(P.friendlyError('请求 timeout', 'x'), /连接服务器超时/)
  assert.match(P.friendlyError('fetch failed', 'x'), /网络连接失败/)
  assert.match(P.friendlyError('API 线路不符合安全策略', 'x'), /当前线路不可用/)
})

test('★ friendlyError：空消息要回落到 fallback，不能显示 "Error"', () => {
  assert.equal(P.friendlyError(new Error(''), '默认提示'), '默认提示',
    'new Error("").toString() 是 "Error"，不能当有效消息')
  assert.equal(P.friendlyError('', '默认提示'), '默认提示')
  assert.equal(P.friendlyError(null, '默认提示'), '默认提示')
  assert.equal(P.friendlyError(undefined, '默认提示'), '默认提示')
  assert.equal(P.friendlyError('Error', '默认提示'), '默认提示')
})

test('friendlyError：认不出的消息原样给出（不要吞掉）', () => {
  assert.equal(P.friendlyError('账号已被禁用', 'x'), '账号已被禁用')
})

// ------------------------------------------------------------------------ esc

test('esc：五个 HTML 特殊字符全部转义', () => {
  assert.equal(P.esc(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
})

test('esc：空值与数字不抛', () => {
  assert.equal(P.esc(null), '')
  assert.equal(P.esc(undefined), '')
  assert.equal(P.esc(0), '')
  assert.equal(P.esc(42), '42')
})

// --------------------------------------------------------------------- cmpVer

test('cmpVer：逐段数字比较，不是字符串比较', () => {
  assert.equal(P.cmpVer('1.10.0', '1.9.0'), 1, '字符串比较会把 1.10 判成小于 1.9')
  assert.equal(P.cmpVer('1.9.0', '1.10.0'), -1)
  assert.equal(P.cmpVer('2.0', '2.0.0'), 0, '段数不同但要补齐比较')
})

test('cmpVer：分隔符随便写都能比', () => {
  assert.equal(P.cmpVer('v1.2.3', '1.2.3'), 0)
  assert.equal(P.cmpVer('1-2-4', '1.2.3'), 1)
})

test('★ cmpVer：带 v 前缀不能被判成更旧（split 会产生空段）', () => {
  // 'v1.2.3'.split(/[^\d]+/) 是 ['', '1', '2', '3']，开头空段被当成 0，
  // 于是同一个版本被判成更旧 —— 更新检查会永远说"已是最新"。
  assert.equal(P.cmpVer('v1.2.3', '1.2.3'), 0)
  assert.equal(P.cmpVer('V2.0.0', '2.0.0'), 0)
  assert.equal(P.cmpVer('v1.0.1', 'v1.0.0'), 1)
})

test('cmpVer：全是分隔符的输入当 0.0.0，不崩', () => {
  assert.equal(P.cmpVer('v', '0'), 0)
  assert.equal(P.cmpVer('...', ''), 0)
  assert.equal(P.cmpVer('v', '1.0.0'), -1)
})

test('cmpVer：空值当 0，不抛', () => {
  assert.equal(P.cmpVer('', ''), 0)
  assert.equal(P.cmpVer(null, '0.0.1'), -1)
  assert.equal(P.cmpVer(undefined, undefined), 0)
})

// ------------------------------------------------------------- orderedLangs 等

test('orderedLangs：auto 永远置顶', () => {
  const rows = [{ id: 'en', name: 'English' }, { id: 'auto', name: '自动' }, { id: 'zh', name: '中文' }]
  assert.equal(P.orderedLangs(rows)[0].id, 'auto',
    'auto 排到中间会让用户以为默认值变了')
})

test('orderedLangs：常用语种按 LANG_PRIORITY 排，其余跟在后面', () => {
  const rows = [
    { id: 'xx', name: '冷门' }, { id: 'ja', name: '日语' },
    { id: 'en', name: '英语' }, { id: 'zh', name: '中文' }
  ]
  assert.deepEqual(plain(P.orderedLangs(rows).map(l => l.id)), ['zh', 'en', 'ja', 'xx'])
})

test('orderedLangs：不修改入参（slice 过）', () => {
  const rows = [{ id: 'ja' }, { id: 'zh' }]
  P.orderedLangs(rows)
  assert.deepEqual(plain(rows.map(l => l.id)), ['ja', 'zh'], '排序不能就地改调用方的数组')
})

test('langDisplayName：auto 与 zh 有专用文案', () => {
  assert.equal(P.langDisplayName({ id: 'auto', name: 'x' }), '自动识别')
  assert.equal(P.langDisplayName({ id: 'zh', name: 'x' }), '简体中文')
  assert.equal(P.langDisplayName({ id: 'fr', name: '法语' }), '法语')
})

test('langOptionHtml：分隔线插在常用语种之后，且不可选', () => {
  const html = P.langOptionHtml([
    { id: 'auto', name: 'a' }, { id: 'zh', name: '中' }, { id: 'zz', name: '冷' }
  ])
  const split = html.indexOf('<option value="" disabled>')
  assert.ok(split > 0, '必须有分隔线')
  assert.ok(html.indexOf('value="zz"') > split, '冷门语种要在分隔线之后')
  assert.ok(html.indexOf('value="zh"') < split, '常用语种要在分隔线之前')
})

test('langOptionHtml：rows 为空时用内置 LANGS 兜底', () => {
  const html = P.langOptionHtml(null)
  assert.match(html, /value="auto"/)
  assert.ok(html.length > 1000, '内置语种表应该很全')
})

test('groupModeUiValue：只认三种，其余归 manual', () => {
  assert.equal(P.groupModeUiValue('inherit'), 'inherit')
  assert.equal(P.groupModeUiValue('auto'), 'auto')
  assert.equal(P.groupModeUiValue('manual'), 'manual')
  assert.equal(P.groupModeUiValue('随便什么'), 'manual')
  assert.equal(P.groupModeUiValue(undefined), 'manual')
})

// ------------------------------------------------------------------ 测速文案

test('speedText：四种状态各自可读', () => {
  assert.equal(P.speedText({ pending: true }), '测速中')
  assert.equal(P.speedText({ ok: false }), '超时')
  assert.equal(P.speedText({ ms: null }), '--')
  assert.equal(P.speedText({ ms: 88 }), '88ms')
})

test('speedClass：>300 红、>120 黄、其余正常', () => {
  assert.equal(P.speedClass({ ok: false }), 'ms bad')
  assert.equal(P.speedClass({ ms: null }), 'ms')
  assert.equal(P.speedClass({ ms: 500 }), 'ms bad')
  assert.equal(P.speedClass({ ms: 200 }), 'ms slow')
  assert.equal(P.speedClass({ ms: 50 }), 'ms')
})

test('speedClass：pending 时不标红（还没测完）', () => {
  assert.equal(P.speedClass({ pending: true, ms: 999 }), 'ms')
})

// ---------------------------------------------------------------- formatProxyTime

test('formatProxyTime：补零到 yyyy-MM-dd HH:mm:ss', () => {
  const d = new Date(2026, 0, 5, 9, 8, 7)
  assert.equal(P.formatProxyTime(d.getTime()), '2026-01-05 09:08:07')
})

test('formatProxyTime：无效时间返回空串，不显示 1970', () => {
  assert.equal(P.formatProxyTime(0), '')
  assert.equal(P.formatProxyTime(null), '')
  assert.equal(P.formatProxyTime('不是时间'), '')
})

// ---------------------------------------------------------------- parseProxyLine

test('parseProxyLine：host:port', () => {
  assert.deepEqual(plain(P.parseProxyLine('127.0.0.1:1080')), { host: '127.0.0.1', port: '1080' })
})

test('parseProxyLine：带协议前缀也能剥', () => {
  assert.deepEqual(plain(P.parseProxyLine('socks5://1.2.3.4:1080')), { host: '1.2.3.4', port: '1080' })
  assert.deepEqual(plain(P.parseProxyLine('https://1.2.3.4:8080')), { host: '1.2.3.4', port: '8080' })
  assert.deepEqual(plain(P.parseProxyLine('socks5h://1.2.3.4:1080')), { host: '1.2.3.4', port: '1080' })
})

test('parseProxyLine：user:pass@host:port', () => {
  assert.deepEqual(plain(P.parseProxyLine('u:p@1.2.3.4:1080')), { user: 'u', pass: 'p', host: '1.2.3.4', port: '1080' })
})

test('★ parseProxyLine：密码里有 @ 时按最后一个 @ 切（否则密码被截断）', () => {
  const r = P.parseProxyLine('u:p@ss@1.2.3.4:1080')
  assert.equal(r.user, 'u')
  assert.equal(r.pass, 'p@ss')
  assert.equal(r.host, '1.2.3.4')
})

test('parseProxyLine：密码里有冒号', () => {
  const r = P.parseProxyLine('u:a:b@1.2.3.4:1080')
  assert.equal(r.pass, 'a:b', '冒号只切第一个，剩下的都算密码')
})

test('parseProxyLine：四段冒号形式 host:port:user:pass', () => {
  assert.deepEqual(plain(P.parseProxyLine('1.2.3.4:1080:u:p')), { host: '1.2.3.4', port: '1080', user: 'u', pass: 'p' })
})

test('parseProxyLine：四段以上时剩下的都归密码', () => {
  assert.deepEqual(plain(P.parseProxyLine('1.2.3.4:1080:u:a:b:c')), { host: '1.2.3.4', port: '1080', user: 'u', pass: 'a:b:c' })
})

test('parseProxyLine：两段且第二段不是数字 → 当成只有 host', () => {
  assert.deepEqual(plain(P.parseProxyLine('example.com:notaport')), { host: 'example.com:notaport' })
})

test('parseProxyLine：空输入返回 null', () => {
  assert.equal(P.parseProxyLine(''), null)
  assert.equal(P.parseProxyLine('   '), null)
  assert.equal(P.parseProxyLine(null), null)
})

test('parseProxyLine：只有 host 时 port 缺失，上层要能判出来', () => {
  const r = P.parseProxyLine('example.com')
  assert.equal(r.host, 'example.com')
  assert.equal(r.port, undefined)
})

// -------------------------------------------------------------- 内置语种表

test('LANGS：auto 必须在第一位，且 id 唯一', () => {
  assert.equal(P.LANGS[0].id, 'auto')
  const ids = P.LANGS.map(l => l.id)
  assert.equal(new Set(ids).size, ids.length, '语种 id 有重复')
})

test('LANG_PRIORITY 里的每个 id 都真的在 LANGS 里', () => {
  const ids = new Set(P.LANGS.map(l => l.id))
  const missing = P.LANG_PRIORITY.filter(id => !ids.has(id))
  assert.deepEqual(plain(missing), [], '常用语种表里有 LANGS 不认识的 id')
})
