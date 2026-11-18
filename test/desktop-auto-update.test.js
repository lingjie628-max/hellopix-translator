'use strict'

/**
 * 应用内自动更新。
 *
 * ## 为什么这个模块的测试重点在「拒绝」而不是「成功」
 *
 * 自动更新的攻击面比"打开浏览器下载"大一个量级：它能**下载文件并执行它**。
 * 一旦某条路径可以让渲染层（或任何能影响渲染层的东西）指定下载地址，
 * 就等于给了第三方网页一个「在主进程下载并执行任意文件」的通道。
 *
 * 所以这里的测试大部分在断言"什么情况下必须拒绝"，成功路径只需要一条能跑通。
 *
 * ## 信任链（顺序不可调换）
 *
 *   1. 服务端下发清单 → Ed25519 验签（私钥在构建机，服务器被攻破也签不出）
 *   2. 按清单里的 sha256 下载并逐字节校验
 *   3. 只有 1、2 都过，才把本地文件交给安装
 *
 * 任何一步跳过都会让整条链退化。测试按这三步分别锁。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const test = require('node:test')
const crypto = require('node:crypto')

const {
  createUpdater,
  STATUS,
  replaceAppBundle,
  preserveManualInstaller
} = require('../desktop/src/update/auto-updater')

const desktopDir = path.join(__dirname, '..', 'desktop')

function readSrc (rel) {
  return fs.readFileSync(path.join(desktopDir, rel), 'utf8')
}

function stripComments (src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 最小可用的假 app：只提供 getPath('temp')。 */
function fakeApp (dir) {
  return { getPath: () => dir, quit: () => {} }
}

function makeUpdater (opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-upd-'))
  const events = []
  const logs = []
  const runner = createUpdater(Object.assign({
    app: fakeApp(dir),
    emit: p => events.push(p),
    log: (l, m) => logs.push(l + ':' + m)
  }, opts || {}))
  return { runner, events, logs, dir }
}

/* ---------------------------------------------------------------- 测试服务 */

/** 起一个本地 HTTP 服务当"CDN"，返回可控内容的下载地址。 */
function startServer (body, headers) {
  const http = require('http')
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, Object.assign({ 'content-length': String(body.length) }, headers || {}))
      res.end(body)
    })
    srv.listen(0, '127.0.0.1', () => resolve({
      url: 'http://127.0.0.1:' + srv.address().port + '/HelloPix-Setup-test.exe',
      close: () => new Promise(r => srv.close(r))
    }))
  })
}

function sha256 (buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/* ============================================================== 下载与校验 */

test('★ sha256 不匹配必须删掉文件并标记失败（不能被安装器拿去用）', async () => {
  const body = Buffer.from('this is not the real installer')
  const srv = await startServer(body)
  const { runner, events, dir } = makeUpdater()

  await runner.start({ version: '9.9.9', url: srv.url, sha256: 'a'.repeat(64) })
  // start 是异步跑的，等状态落定
  await new Promise(r => setTimeout(r, 600))
  await srv.close()

  const last = events[events.length - 1]
  assert.equal(last.status, STATUS.FAILED, '摘要不符必须失败，不能静默继续')
  assert.match(last.error, /校验失败|不匹配/)
  // 关键：文件不能留在那里等人误用。
  // state().file 在失败时是空串，先确认它没被登记为可安装文件，
  // 再确认临时目录里没有残留的 .part（下载中途的半个文件）。
  assert.equal(runner.file, '', '失败后不能留下可安装文件的引用')
  const tmpDir = path.join(dir, 'hello-pix-update')
  const leftovers = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []
  assert.equal(leftovers.length, 0,
    '校验失败的文件必须被删除，实际残留：' + JSON.stringify(leftovers))
  assert.equal(runner.state().status, STATUS.FAILED)
})

test('★ 没有 sha256 的清单直接拒绝下载（无法校验等于没验签）', async () => {
  const { runner, events } = makeUpdater()
  const r = await runner.start({ version: '9.9.9', url: 'https://example.com/x.exe', sha256: '' })
  assert.equal(r.ok, false, '必须明确报告失败')
  assert.equal(r.status, STATUS.FAILED)
  assert.match(r.reason, /摘要|sha256/i)
  // 同时也要推一条事件给界面 —— 只返回不推送，用户界面会一直停在「准备中」
  assert.equal(events[events.length - 1].status, STATUS.FAILED)
  assert.match(events[events.length - 1].error, /摘要|sha256/i)
})

test('sha256 匹配时下载成功并进入 ready（可以用 apply）', async () => {
  const body = Buffer.from('real installer bytes '.repeat(100))
  const srv = await startServer(body)
  const { runner, events } = makeUpdater()

  await runner.start({ version: '9.9.9', url: srv.url, sha256: sha256(body) })
  await new Promise(r => setTimeout(r, 800))
  await srv.close()

  const last = events[events.length - 1]
  assert.equal(last.status, STATUS.READY, '摘要匹配应进入 ready：' + JSON.stringify(last))
  assert.equal(last.percent, 100)
  assert.ok(runner.file, 'ready 之后必须有可安装的本地文件')
  assert.ok(fs.existsSync(runner.file), '文件必须真的落在磁盘上')
  // 边下边算的哈希必须和内容一致
  assert.equal(sha256(fs.readFileSync(runner.file)), sha256(body))
})

test('★ 下载极快时也必须推最后一次进度（否则进度条卡在 96% 看着像挂了）', async () => {
  // 本地回环下载 200KB 只用几毫秒，会落在同一个节流窗口里。
  // 如果只在「距上次 ≥200ms」时才推，用户只会看到一条 0% 然后直接跳到 ready。
  const body = Buffer.from('z'.repeat(200 * 1024))
  const srv = await startServer(body)
  const { runner, events } = makeUpdater()

  await runner.start({ version: '9.9.9', url: srv.url, sha256: sha256(body) })
  await new Promise(r => setTimeout(r, 700))
  await srv.close()

  const dl = events.filter(e => e.status === STATUS.DOWNLOADING && e.total > 0)
  assert.ok(dl.length >= 2,
    '至少要有「开始」和「收完」两条下载事件，实际 ' + dl.length + ' 条：' +
    JSON.stringify(dl.map(e => e.percent)))
  const last = dl[dl.length - 1]
  assert.equal(last.received, body.length, '最后一条必须报出完整的字节数')
  assert.ok(last.percent >= 99, '最后一条要接近 100%，实际 ' + last.percent + '%')
})

test('★ start() 必须真的启动下载（IIFE 漏写 () 会让它静默什么都不做）', async () => {
  // 真实踩过：把 `})()` 手滑写成 `})` 后，IIFE 只被创建、从未调用。
  // 表现是 start() 返回 ok:true、界面显示"准备中…"、进度永远 0 —— 没有任何报错。
  // 所有断言最终状态的测试都抓不到它，因为它们等不到 ready 只会超时。
  const body = Buffer.from('payload')
  const srv = await startServer(body)
  const { runner, events } = makeUpdater()

  const r = await runner.start({ version: '9.9.9', url: srv.url, sha256: sha256(body) })
  assert.equal(r.ok, true)

  // 立刻检查：不管是哪个阶段，状态都必须已经离开 idle。
  // 同步执行到第一个 await 之前，setStatus(DOWNLOADING) 必然已经跑过。
  assert.notEqual(runner.state().status, STATUS.IDLE,
    '★ start() 返回后状态还是 idle = 下载根本没开始。检查 IIFE 结尾是不是漏了 ()')
  assert.ok(events.length > 0, '至少推一条事件，否则界面收不到任何更新')
  assert.ok(events.every(e => e.status !== STATUS.IDLE),
    '★ 一条 idle 事件都不该出现在下载启动后：' + JSON.stringify(events.map(e => e.status)))

  await new Promise(r2 => setTimeout(r2, 500))
  await srv.close()
})

test('下载过程中进度事件要有 received/total，且 percent 单调不减', async () => {
  const body = Buffer.from('x'.repeat(200 * 1024))
  const srv = await startServer(body)
  const { runner, events } = makeUpdater()

  await runner.start({ version: '9.9.9', url: srv.url, sha256: sha256(body) })
  await new Promise(r => setTimeout(r, 800))
  await srv.close()

  const downloading = events.filter(e => e.status === STATUS.DOWNLOADING)
  assert.ok(downloading.length >= 1, '至少要推一次下载中事件')
  const dl = downloading.filter(e => e.total > 0)
  assert.ok(dl.length >= 1, '服务端给了 content-length 时应带上 total')
  let prev = -1
  for (const e of dl) {
    assert.ok(e.percent >= prev, 'percent 不能回退：' + prev + ' -> ' + e.percent)
    prev = e.percent
  }
})

test('HTTP 错误（404/500）必须失败并带出状态码', async () => {
  const http = require('http')
  const srv = await new Promise(resolve => {
    const s = http.createServer((req, res) => { res.writeHead(404); res.end('nope') })
    s.listen(0, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + s.address().port + '/x.exe', close: () => new Promise(r => s.close(r)) }))
  })
  const { runner, events } = makeUpdater()
  await runner.start({ version: '9.9.9', url: srv.url, sha256: 'a'.repeat(64) })
  await new Promise(r => setTimeout(r, 500))
  await srv.close()

  const last = events[events.length - 1]
  assert.equal(last.status, STATUS.FAILED)
  assert.match(last.error, /404/, '错误信息要带状态码，否则排障时无从下手')
})

test('apply() 在没下载完成时必须拒绝', async () => {
  const { runner } = makeUpdater()
  const r = await runner.apply()
  assert.equal(r.ok, false)
  assert.match(r.reason, /没有可安装/)
})

test('同一时间只能跑一轮下载（防重复点击把带宽和磁盘打满）', async () => {
  const body = Buffer.from('y'.repeat(50 * 1024))
  const srv = await startServer(body)
  const { runner } = makeUpdater()

  await runner.start({ version: '9.9.9', url: srv.url, sha256: sha256(body) })
  const second = await runner.start({ version: '9.9.9', url: srv.url, sha256: sha256(body) })
  assert.equal(second.ok, false, '第二轮必须被拒绝')
  assert.match(second.reason, /进行中/)
  await new Promise(r => setTimeout(r, 700))
  await srv.close()
})

/* ================================================== IPC 层的信任边界（静态） */

test('★ updateStart 不得接受渲染层传来的 URL（否则等于任意文件下载+执行）', () => {
  const src = stripComments(readSrc('src/ipc/app.js'))
  const block = src.match(/reg\.handle\('app:updateStart',\s*async\s*\(([^)]*)\)\s*=>\s*\{([\s\S]*?)\n  \}\)/)
  assert.ok(block, '找不到 app:updateStart handler')
  const params = block[1].trim()

  assert.equal(params, '',
    '★ handler 不能有参数。渲染层传来的任何地址都不可信 —— ' +
    '收到 url 就必须拒绝，最安全的写法是干脆不接收')
  // 必须自己重新取清单
  assert.match(block[2], /\/client\/update/,
    '★ 必须自己重新向服务端取清单，不能复用渲染层的值')
  assert.match(block[2], /resolveRelease/,
    '★ 必须自己重新验签')
  assert.match(block[2], /isAllowedExternalUrl/,
    '★ 必须自己再过一次域名白名单')
})

test('★ 只有验签通过（hardened）的清单才允许自动安装', () => {
  const src = stripComments(readSrc('src/ipc/app.js'))
  const block = src.match(/reg\.handle\('app:updateStart',[\s\S]*?\n  \}\)/)
  assert.ok(block)
  assert.match(block[0], /resolved\.status\s*!==\s*'hardened'/,
    '★ 必须显式拒绝 non-hardened。legacy 没有哈希，装它等于装一个无法校验的包')
})

test('★ macOS 替换应先保留旧 bundle，失败时可恢复', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-swap-'))
  const app = path.join(root, 'Hello Pix.app')
  const staging = path.join(root, '.HelloPix.staging.app')
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true })
  fs.mkdirSync(path.join(staging, 'Contents'), { recursive: true })
  fs.writeFileSync(path.join(app, 'Contents', 'old.txt'), 'old')
  fs.writeFileSync(path.join(staging, 'Contents', 'new.txt'), 'new')

  assert.equal(await replaceAppBundle(staging, app), true)
  assert.equal(fs.readFileSync(path.join(app, 'Contents', 'new.txt'), 'utf8'), 'new')

  // Force the second rename to fail; the old bundle must remain usable.
  const failureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-swap-fail-'))
  const failureApp = path.join(failureRoot, 'Hello Pix.app')
  fs.mkdirSync(path.join(failureApp, 'Contents'), { recursive: true })
  fs.writeFileSync(path.join(failureApp, 'Contents', 'old.txt'), 'old')
  assert.equal(await replaceAppBundle(path.join(failureRoot, 'does-not-exist.app'), failureApp), false)
  assert.equal(fs.readFileSync(path.join(failureApp, 'Contents', 'old.txt'), 'utf8'), 'old')
})

test('★ updater 的 emit 只能推给主窗口，不能广播给客页', () => {
  const src = stripComments(readSrc('src/ipc/app.js'))
  assert.match(src, /sendToMain/,
    '进度事件必须走 sendToMain')
  assert.doesNotMatch(src, /\.webContents\.send\('app:update-progress'/,
    '★ 不能直接对所有 webContents 广播 —— 账客页是第三方网页，版本信息也不该泄露给它们')
})

test('main.js 的 sendToMain 必须判空（窗口可能还没建好）', () => {
  const src = stripComments(readSrc('main.js'))
  const block = src.match(/sendToMain:\s*\(channel,\s*payload\)\s*=>\s*\{([\s\S]*?)\n    \},/)
  assert.ok(block, '找不到 sendToMain 实现')
  assert.match(block[1], /isDestroyed|!win/,
    '窗口可能未创建或已销毁，必须判空，否则每次更新检查都会抛错')
})

test('preload 只暴露无参的 updateStart（不在前端留传 URL 的口子）', () => {
  const src = stripComments(readSrc('preload.js'))
  assert.match(src, /updateStart:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('app:updateStart'\)/,
    '★ updateStart 必须是无参函数。哪怕主进程不收参数，前端留个 (url) 的签名也会误导后人')
})

/* ==================================================== 渲染层的失败兜底 */

test('★ 自动更新失败时，按钮必须退回浏览器下载（不能把用户卡死）', () => {
  const src = stripComments(readSrc('renderer/collision-update.js'))
  assert.match(src, /updateMode\s*=\s*'browser'/,
    '★ 必须有 browser 兜底模式')
  // failed 分支要设置 browser 模式
  const failedBlock = src.match(/status\s*===\s*'failed'\s*\)\s*\{([\s\S]*?)\n  \}/)
  assert.ok(failedBlock, '找不到 failed 分支')
  assert.match(failedBlock[1], /updateMode\s*=\s*'browser'/,
    '★ failed 时必须切到浏览器模式，否则用户点按钮只会再次失败')
  assert.match(failedBlock[1], /浏览器下载/,
    '按钮文案要明确告诉用户改走浏览器')
})

test('★ updateStart 被拒绝时也要退回浏览器下载', () => {
  const src = stripComments(readSrc('renderer/collision-update.js'))
  const block = src.match(/const r = await window\.pix\.updateStart\(\)[\s\S]*?updateDownloadBtn\.textContent = '暂未发布'/)
  assert.ok(block, '找不到 updateStart 的拒绝处理')
  assert.match(block[0], /updateMode\s*=\s*'browser'/,
    '主进程拒绝（未验签 / 域名不在白名单）时，也要给用户一条能走的路')
})

test('进度条只在下载/校验/安装三个阶段显示', () => {
  const src = stripComments(readSrc('renderer/collision-update.js'))
  const block = src.match(/updateProgressWrap\.classList\.toggle\('hidden',([\s\S]*?)\)/)
  assert.ok(block, '找不到进度条显隐逻辑')
  const cond = block[1]
  for (const s of ['downloading', 'verifying', 'installing']) {
    assert.match(cond, new RegExp(`'${s}'`), `进度条应在 ${s} 阶段显示`)
  }
  assert.doesNotMatch(cond, /'ready'/, 'ready 之后进度条应收起（该显示安装按钮了）')
})

/* ============================================================ 打包配置 */

test('electron-updater 必须在 dependencies 里（打包后要能 require 到）', () => {
  const pkg = JSON.parse(readSrc('package.json'))
  assert.ok(pkg.dependencies && pkg.dependencies['electron-updater'],
    '★ 放 devDependencies 的话打包时会被剪掉，线上 require 直接抛 MODULE_NOT_FOUND')
})

test('★ autoDownload 必须关掉：下载由我们自己控制，不能让 electron-updater 抢先', () => {
  const src = stripComments(readSrc('src/update/auto-updater.js'))
  assert.match(src, /autoUpdater\.autoDownload\s*=\s*false/,
    '★ 开着 autoDownload 的话它会在我们验签之前就去读 latest.yml 下载，绕过整条信任链')
  assert.match(src, /autoUpdater\.autoInstallOnAppQuit\s*=\s*false/,
    '不能让它在我们不知情的时候于退出时安装')
})

test('临时下载目录必须在 temp 下，不能污染 userData', () => {
  const src = stripComments(readSrc('src/update/auto-updater.js'))
  assert.match(src, /getPath\('temp'\)/,
    '半截的 100MB 文件不能留在 userData 里')
})

test('★ cleanup 必须删掉旧安装包（.dmg/.exe），不能只删 .part', async () => {
  const { runner, dir } = makeUpdater()
  const upd = path.join(dir, 'hello-pix-update')
  fs.mkdirSync(upd, { recursive: true })
  // 模拟：上次更新留下的成品 + 本次没有在下的
  fs.writeFileSync(path.join(upd, 'HelloPix-1.2.7.dmg'), 'old')
  fs.writeFileSync(path.join(upd, 'HelloPix-1.2.6.exe'), 'old')
  fs.writeFileSync(path.join(upd, 'HelloPix-1.2.8.dmg.part'), 'half')

  runner.cleanup()

  const left = fs.readdirSync(upd)
  assert.deepEqual(left, [],
    '★ 旧的 .dmg/.exe 也要删 —— 只删 .part 的话每更新一次留 100MB，' +
    '一年下来临目录里全是可执行安装包。实际残留：' + JSON.stringify(left))
})

test('★ cleanup 不能删掉当前待安装的那个文件', async () => {
  const body = Buffer.from('installer')
  const srv = await startServer(body)
  const { runner, dir } = makeUpdater()

  await runner.start({ version: '9.9.9', url: srv.url, sha256: sha256(body) })
  await new Promise(r => setTimeout(r, 700))
  await srv.close()

  assert.equal(runner.state().status, STATUS.READY)
  const target = runner.file
  assert.ok(fs.existsSync(target))

  // 再放一个上一轮遗留的旧包
  fs.writeFileSync(path.join(path.dirname(target), 'HelloPix-0.0.1.dmg'), 'old')
  runner.cleanup()

  assert.ok(fs.existsSync(target),
    '★ 删掉待安装文件的话，用户点「立即安装」会发现包没了，只能重下一遍')
  assert.equal(fs.existsSync(path.join(path.dirname(target), 'HelloPix-0.0.1.dmg')), false,
    '其他旧包应该被清掉')
})

test('★ cleanup 不能删除仍被 Finder 挂载的 DMG（否则挂载卷立刻 I/O 崩溃）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-upd-mounted-'))
  const upd = path.join(dir, 'hello-pix-update')
  fs.mkdirSync(upd, { recursive: true })
  const mounted = path.join(upd, 'HelloPix-1.3.8.dmg')
  const other = path.join(upd, 'HelloPix-1.2.7.dmg')
  const half = path.join(upd, 'HelloPix-1.2.8.dmg.part')
  fs.writeFileSync(mounted, 'mounted')
  fs.writeFileSync(other, 'old')
  fs.writeFileSync(half, 'half')
  const updater = createUpdater({
    app: fakeApp(dir),
    emit: () => {},
    log: () => {},
    mountedDmgPaths: () => ({ known: true, paths: [mounted] })
  })

  updater.cleanup()

  assert.ok(fs.existsSync(mounted), '仍在挂载的 DMG 底层文件绝对不能删')
  assert.equal(fs.existsSync(other), false, '未挂载的旧 DMG 仍应清理')
  assert.equal(fs.existsSync(half), false, '半截 .part 仍应清理')
})

test('★ hdiutil 查询失败时宁可保留 DMG，也不能赌它没被挂载', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-upd-unknown-'))
  const upd = path.join(dir, 'hello-pix-update')
  fs.mkdirSync(upd, { recursive: true })
  const dmg = path.join(upd, 'HelloPix-1.3.8.dmg')
  const exe = path.join(upd, 'HelloPix-1.3.8.exe')
  fs.writeFileSync(dmg, 'dmg')
  fs.writeFileSync(exe, 'exe')
  const updater = createUpdater({
    app: fakeApp(dir),
    emit: () => {},
    log: () => {},
    mountedDmgPaths: () => ({ known: false, paths: [] })
  })

  updater.cleanup()

  assert.ok(fs.existsSync(dmg), '不知道是否挂载时必须保留 DMG')
  assert.equal(fs.existsSync(exe), false, 'Windows exe 不涉及挂载，可以清理')
})

test('★ 另一个存活实例正在使用的更新包，cleanup 不能删', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-upd-lock-live-'))
  const upd = path.join(dir, 'hello-pix-update')
  fs.mkdirSync(upd, { recursive: true })
  const dmg = path.join(upd, 'HelloPix-1.3.8.dmg')
  fs.writeFileSync(dmg, 'active')
  fs.writeFileSync(dmg + '.lock', JSON.stringify({ pid: process.pid }))
  const updater = createUpdater({
    app: fakeApp(dir),
    emit: () => {},
    log: () => {},
    mountedDmgPaths: () => ({ known: true, paths: [] })
  })

  updater.cleanup()

  assert.ok(fs.existsSync(dmg), '持有锁的进程还活着，底层文件不能删')
  assert.ok(fs.existsSync(dmg + '.lock'), '活锁也不能删')
})

test('★ 崩溃进程留下的死锁可以清理', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-upd-lock-stale-'))
  const upd = path.join(dir, 'hello-pix-update')
  fs.mkdirSync(upd, { recursive: true })
  const dmg = path.join(upd, 'HelloPix-1.3.7.dmg')
  fs.writeFileSync(dmg, 'stale')
  fs.writeFileSync(dmg + '.lock', JSON.stringify({ pid: 2147483646 }))
  const updater = createUpdater({
    app: fakeApp(dir),
    emit: () => {},
    log: () => {},
    mountedDmgPaths: () => ({ known: true, paths: [] })
  })

  updater.cleanup()

  assert.equal(fs.existsSync(dmg), false, '死进程锁不能永久拦着清理')
  assert.equal(fs.existsSync(dmg + '.lock'), false, '死锁文件也要删')
})

test('★ macOS 手动安装必须先把已验证 DMG 复制到下载目录', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-manual-'))
  const file = path.join(root, 'HelloPix-1.3.8-arm64.dmg')
  const downloads = path.join(root, 'Downloads')
  const body = Buffer.from('verified dmg bytes')
  fs.writeFileSync(file, body)
  const r = await preserveManualInstaller(file, {
    downloadsDir: downloads,
    expectedSha: sha256(body)
  })
  assert.equal(r.ok, true, r.reason)
  assert.equal(path.dirname(r.file), downloads)
  assert.deepEqual(fs.readFileSync(r.file), body)
  assert.notEqual(r.file, file, '绝不能把 temp 路径直接交给 Finder')
})

test('★ macOS 手动兜底只能 openPath 下载目录里的稳定副本', () => {
  const src = stripComments(readSrc('src/update/auto-updater.js'))
  const block = src.match(/const preserved = await preserveManualInstaller\(file,[\s\S]*?shell\.openPath\(preserved\.file\)/)
  assert.ok(block, '找不到 macOS 手动安装兜底')
  assert.match(block[0], /downloadsDir:\s*app\.getPath\('downloads'\)/)
  assert.doesNotMatch(block[0], /shell\.openPath\(file\)/,
    '★ 不能直接打开 temp 里的 DMG；下次启动 cleanup 会删掉它并破坏挂载卷')
})

test('★ before-quit 要挂上更新包的清理钩子', () => {
  const src = stripComments(readSrc('main.js'))
  assert.match(src, /__pixUpdateCleanup/,
    '清理钩子没被调用 = 临时目录永远不收拾')
  const ipc = stripComments(readSrc('src/ipc/app.js'))
  assert.match(ipc, /global\.__pixUpdateCleanup\s*=/,
    'IPC 层要注册这个钩子')
})
