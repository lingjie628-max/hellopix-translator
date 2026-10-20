/**
 * LINE 个人号：以内置的 LINE 官方 Chrome 扩展承载（LINE 没有网页版）。
 *
 * 锁住四件事：
 *   1. 安全策略只放行官方扩展 ID 的页面；
 *   2. 垫片只补缺、不覆盖，未读数写进标题且页面改标题后能补回；
 *   3. 打包脚本拒绝指纹不符 / 非官方 ID 的 CRX；
 *   4. main.js 先把扩展装进分区再打开页面，且 LINE 不挂翻译桥、不误报"桥没起来"。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const DESKTOP = path.join(__dirname, '..', 'desktop')
const LINE_ID = 'ophjlpahpchlmihnnnihgmmeilfjmjjc'
const { isAllowedPlatformUrl, PLATFORM_EXTENSION_IDS } = require(path.join(DESKTOP, 'src/config/security-policy.js'))
const platforms = require(path.join(DESKTOP, 'shared/platforms.js'))
const fetcher = require(path.join(DESKTOP, 'scripts', 'fetch-line-ext.js'))
const SHIM = fs.readFileSync(path.join(DESKTOP, 'line-ext-shim.js'), 'utf8')
const MAIN = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8')

const line = platforms.find((p) => p.id === 'line')

test('Line 入口指向官方扩展页面', () => {
  assert.ok(line, 'platforms.js 里没有 line')
  assert.equal(line.extension, 'line')
  assert.equal(PLATFORM_EXTENSION_IDS.line, LINE_ID)
  assert.equal(fetcher.LINE_EXT_ID, LINE_ID)
  assert.equal(line.url, 'chrome-extension://' + LINE_ID + '/index.html')
  assert.ok(platforms.find((p) => p.id === 'line-biz'), 'Line商业版 不能被顺手删掉')
})

test('安全策略：只放行 LINE 官方扩展自己的页面', () => {
  const home = line.url
  assert.equal(isAllowedPlatformUrl(line, home, home), true)
  assert.equal(isAllowedPlatformUrl(line, 'chrome-extension://' + LINE_ID + '/index.html#/chats', home), true)
  assert.equal(isAllowedPlatformUrl(line, 'chrome-extension://aapbdbdomjkkjkaonfhkkikfgjllcleb/index.html', home), false, '其他扩展')
  assert.equal(isAllowedPlatformUrl(line, 'https://line.me/', home), false, 'LINE 页内不该跳到网页')
  assert.equal(isAllowedPlatformUrl(line, 'https://evil.example/', home), false)
  assert.equal(isAllowedPlatformUrl({ id: 'x', extension: 'unknown' }, home, home), false, '未登记的扩展平台一律拒绝')
  // 普通网页平台不受影响，也不能借 chrome-extension 绕过
  const wa = platforms.find((p) => p.id === 'whatsapp-green')
  assert.equal(isAllowedPlatformUrl(wa, 'https://web.whatsapp.com/', wa.url), true)
  assert.equal(isAllowedPlatformUrl(wa, 'chrome-extension://' + LINE_ID + '/index.html', wa.url), false)
})

function runShim (ctx) {
  const sandbox = Object.assign({ setTimeout, Promise }, ctx)
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SHIM, sandbox)
  return sandbox
}

test('垫片：补齐 LINE 启动必需的接口，已有的真实实现一律不覆盖', async () => {
  const realGet = () => 'real'
  const s = runShim({ chrome: { storage: { local: { get: realGet } }, runtime: { getURL: (p) => 'x/' + p } } })
  assert.equal(s.chrome.storage.local.get, realGet)
  for (const ns of ['action', 'windows', 'notifications', 'cookies', 'tabs', 'downloads', 'extension']) {
    assert.ok(s.chrome[ns], '缺 chrome.' + ns)
  }
  assert.equal(typeof s.chrome.windows.onRemoved.addListener, 'function')
  assert.equal(typeof s.chrome.action.onClicked.addListener, 'function')
  assert.ok(Array.isArray(await s.chrome.system.display.getInfo()))
  // 回调风格同样要回调
  const viaCb = await new Promise((resolve) => s.chrome.windows.getCurrent(resolve))
  assert.equal(viaCb.id, 1)
})

test('垫片：tabs.getZoom 在 Electron 抛 "No such tab" 时退回 1', async () => {
  const s = runShim({ chrome: { tabs: { getZoom: () => Promise.reject(new Error('No such tab')) } } })
  assert.equal(await s.chrome.tabs.getZoom(), 1)
  const viaCb = await new Promise((resolve) => s.chrome.tabs.getZoom(resolve))
  assert.equal(viaCb, 1)
})

test('垫片：LINE 报的未读数写成标题前缀，宿主按标题读取', () => {
  const doc = { title: 'LINE', readyState: 'complete', head: null, documentElement: null }
  const s = runShim({ chrome: {}, document: doc })
  s.chrome.action.setBadgeText({ text: '3' })
  assert.equal(doc.title, '(3) LINE')
  s.chrome.action.setBadgeText({ text: '99+' })
  assert.equal(doc.title, '(99+) LINE')
  s.chrome.action.setBadgeText({ text: '' })
  assert.equal(doc.title, 'LINE')
  s.chrome.action.setBadgeText({ text: '0' })
  assert.equal(doc.title, 'LINE', '0 不算未读')
  s.chrome.action.setBadgeText({ text: 'NEW' })
  assert.equal(doc.title, 'LINE', '非数字不写')

  // 与 main.js 的 unreadFromTitle 同一口径
  const src = MAIN.slice(MAIN.indexOf('function unreadFromTitle('))
  const fnSrc = src.slice(0, src.indexOf('\n}\n') + 2)
  const unreadFromTitle = new Function(fnSrc + '\nreturn unreadFromTitle')()
  assert.equal(unreadFromTitle('(3) LINE'), 3)
  assert.equal(unreadFromTitle('(99+) LINE'), 99)
  assert.equal(unreadFromTitle('LINE'), 0)
})

test('打包脚本：指纹不符、非官方 ID 的 CRX 一律拒绝', () => {
  assert.match(fetcher.PINNED_CRX_SHA256, /^[0-9a-f]{64}$/)
  assert.throws(() => fetcher.verifyCrx(Buffer.from('not a crx at all')), /指纹不符/)
  assert.throws(() => fetcher.verifyCrx(Buffer.from('Cr24 garbage'), ''), /CRX/)
  // 构造一个 crx_id 不是 LINE 的 CRX3 头
  const crxId = Buffer.alloc(16, 0)
  const signed = Buffer.concat([Buffer.from([0x0a, 0x10]), crxId])
  const header = Buffer.concat([Buffer.from([0x82, 0xf1, 0x04, signed.length]), signed])
  const head = Buffer.alloc(12)
  head.write('Cr24', 0, 'latin1')
  head.writeUInt32LE(3, 4)
  head.writeUInt32LE(header.length, 8)
  assert.throws(() => fetcher.verifyCrx(Buffer.concat([head, header, Buffer.from('PK')]), ''), /不是 LINE 官方扩展/)
})

test('打包脚本：垫片接入页面与后台 service worker', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pix-line-'))
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><head><script defer src="/static/js/main.js"></script></head></html>')
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ background: { service_worker: 'background.js', type: 'module' } }))
    fetcher.applyShim(dir)
    fetcher.applyShim(dir)
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
    assert.ok(html.indexOf('/pix-shim.js') < html.indexOf('/static/js/main.js'), '垫片必须先于页面脚本')
    assert.equal(html.split('pix-shim.js').length - 1, 1, '重复执行不能插两次')
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    assert.equal(m.background.service_worker, 'pix-bg.js')
    assert.equal(fs.readFileSync(path.join(dir, 'pix-bg.js'), 'utf8'), "import './pix-shim.js'\nimport './background.js'\n")
    assert.ok(fs.existsSync(path.join(dir, 'pix-shim.js')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('main.js：先装扩展再打开页面；LINE 不挂翻译桥、不误报', () => {
  const load = MAIN.slice(MAIN.indexOf('function startTabLoad('), MAIN.indexOf('function bridgeEnabledFor('))
  assert.ok(load.indexOf('ensurePlatformExtension(tab)') >= 0 && load.indexOf('ensurePlatformExtension(tab)') < load.indexOf('loadURL(tab.url)'),
    'loadURL 之前必须先装扩展')
  assert.match(MAIN, /function bridgeEnabledFor\(item\) \{\s*return !!item && !item\.customUrl && item\.id !== 'tickets' && !item\.extension/)
  assert.match(MAIN, /const bridgeEnabled = bridgeEnabledFor\(item\)/)
  const wd = MAIN.slice(MAIN.indexOf('function watchdogBridge('))
  // 取整个函数体来断言，不要用固定字符数切片 —— 函数开头加几行注释/清理
  // 就会把目标断言挤出窗口，那是"测试写脆了"，不是功能坏了。
  const wdBody = wd.slice(0, wd.indexOf('\nfunction ', 10) > 0 ? wd.indexOf('\nfunction ', 10) : 3000)
  assert.match(wdBody, /if \(!bridgeEnabledFor\(tab\.item\)\) return/,
    'watchdogBridge 必须在入口就排除不挂翻译桥的平台，否则 LINE 会误报"桥没起来"')
  assert.match(MAIN, /path\.join\(process\.resourcesPath, name \+ '-ext'\)/)
  const pkg = require(path.join(DESKTOP, 'package.json'))
  assert.ok((pkg.build.extraResources || []).some((r) => r.from === 'vendor/line-ext' && r.to === 'line-ext'),
    '扩展必须作为 extraResources 打进安装包（不能进 asar）')
  for (const k of ['pack:mac', 'pack:win', 'pack:all', 'pack:dir']) {
    assert.match(pkg.scripts[k], /^node scripts\/fetch-line-ext\.js && /, k + ' 打包前没准备 LINE 扩展')
  }
})
