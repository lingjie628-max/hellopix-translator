'use strict'

/**
 * 应用内自动更新。
 *
 * ## 为什么不是「直接接 electron-updater 就完事」
 *
 * electron-updater 有自己的信任模型：读 `latest.yml`、按里面的 sha512 校验。
 * 而本项目已经有**一套更严格的体系**：服务端 `/client/update` 现签现发
 * 一份 Ed25519 清单，客户端内置公钥验签（见 `verify-release.js` /
 * `signature.js`）。那套体系的目的是「服务端被攻破时，攻击者也拼不出合法清单」
 * —— 私钥在构建机上，不在服务器上。
 *
 * 如果直接让 electron-updater 自己读 latest.yml，就等于**绕过**了这层保护：
 * 攻破服务器的人只要改最新的 latest.yml 就能给所有用户推任意包。
 *
 * 所以这里的顺序是铁律：
 *
 *   1. 走原有链路拿清单 → **Ed25519 验签**（签名不过，一个字节都不下）
 *   2. 按清单里的 sha256 下载 + 逐字节校验
 *   3. 只有 sha256 也匹配，才把**本地已验证的文件**交给 electron-updater 安装
 *
 * 换句话说：electron-updater 在这里只当一个「安装器」，不承担任何信任判断。
 * 它的 `autoDownload` 必须关掉，`latest.yml` 也只在我们自己验过之后才会用到。
 *
 * ## 为什么分两个阶段
 *
 * 下载可能几十秒到几分钟（100MB+），渲染层要能显示进度、能取消。
 * 用一个同步的 IPC 调用会卡住整个界面，所以：
 *   · `start()` 立刻返回，后台跑
 *   · 进度/结果通过 `app:update-progress` 事件推给渲染层
 *
 * ## 失败必须能回退到「浏览器下载」
 *
 * 自动更新在任何一步失败（没权限、磁盘满、被安全软件拦、electron-updater
 * 在这个平台上不认我们的包），都必须让用户还能手动装上 —— 所以渲染层拿到
 * `failed` 事件后要保留「打开下载页」的按钮。更新功能坏了不能连累用户升级。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const { execFile, execFileSync } = require('child_process')
const { pipeline } = require('stream/promises')

/** 应用在 /Applications 里的名字（productName + .app）。 */
const APP_BUNDLE = 'Hello Pix.app'

/** 跑一个命令，返回 { code, stdout, stderr }，永不 reject。 */
function run (cmd, args, opts) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 180000, ...(opts || {}) }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

/** 返回当前仍挂载的磁盘映像路径；命令失败时 known=false。 */
function mountedDmgPaths () {
  try {
    const stdout = execFileSync('hdiutil', ['info'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024
    })
    const paths = []
    for (const line of String(stdout || '').split('\n')) {
      const match = line.match(/^\s*image-path\s*:\s*(.+?)\s*$/)
      if (match) paths.push(match[1])
    }
    return { known: true, paths }
  } catch (e) {
    return { known: false, paths: [] }
  }
}

function samePath (a, b) {
  const norm = value => {
    let result = path.resolve(String(value || ''))
    try { result = fs.realpathSync(result) } catch (e) {}
    return result
  }
  return norm(a) === norm(b)
}

function sha256FileSync (file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(1024 * 1024)
  try {
    let length = 0
    while ((length = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, length))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function updaterLockPath (file) {
  return file + '.lock'
}

function writeUpdaterLock (file) {
  fs.writeFileSync(updaterLockPath(file), JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString()
  }), { mode: 0o600 })
}

function removeUpdaterLock (file) {
  try { fs.unlinkSync(updaterLockPath(file)) } catch (e) {}
}

function lockOwnerIsAlive (file) {
  try {
    const row = JSON.parse(fs.readFileSync(updaterLockPath(file), 'utf8'))
    const pid = Number(row && row.pid)
    if (!Number.isInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch (e) {
    return false
  }
}

function lockBaseForName (dir, name) {
  const part = /\.part$/i.test(name) ? name.slice(0, -5) : name
  return path.join(dir, part)
}

/**
 * 自动安装失败时，先把已验证安装包复制到下载目录，再交给 Finder。
 *
 * 绝不能直接打开 temp 下的文件：应用退出后，下一次启动的 cleanup 会删除
 * temp 里的旧安装包；若 Finder 已把 DMG 挂载，底层文件消失会让挂载卷变成
 * I/O 错误，用户从卷里启动 App 时就会因为 Electron Framework 读不到而崩溃。
 */
async function preserveManualInstaller (file, deps) {
  const opts = deps || {}
  const downloads = opts.downloadsDir
  const expected = String(opts.expectedSha || '').toLowerCase()
  if (!downloads) return { ok: false, reason: '找不到下载目录' }
  try {
    fs.mkdirSync(downloads, { recursive: true })
    const base = path.basename(file)
    let target = path.join(downloads, base)
    if (fs.existsSync(target)) {
      const same = expected && fs.statSync(target).size === fs.statSync(file).size &&
        sha256FileSync(target) === expected
      if (!same) {
        const ext = path.extname(base)
        const stem = path.basename(base, ext)
        target = path.join(downloads, stem + '-' + Date.now() + ext)
      }
    }
    if (!fs.existsSync(target) || sha256FileSync(target) !== expected) {
      fs.copyFileSync(file, target)
    }
    if (expected && sha256FileSync(target) !== expected) {
      try { fs.unlinkSync(target) } catch (e) {}
      return { ok: false, reason: '复制到下载目录后校验失败' }
    }
    await run('xattr', ['-dr', 'com.apple.quarantine', target])
    if (opts.log) opts.log('已验证安装包已保存到 ' + target)
    return { ok: true, file: target }
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) }
  }
}

/** 删一个目录，先原生删，失败退回 rm -rf（asar 会让 Node 的递归删除出错）。 */
async function removeDir (p) {
  try {
    fs.rmSync(p, { recursive: true, force: true })
    return true
  } catch (e) {
    // macOS 上 Electron 打包的 .app 里有 app.asar，Node 的 rimraf 会抛
    // ENOTDIR（它把 asar 当目录去 rmdir）。rm -rf 没这个问题。
    const r = await run('rm', ['-rf', p])
    return r.code === 0 && !fs.existsSync(p)
  }
}

/**
 * macOS 自动安装：挂载 dmg → ditto 覆盖 /Applications → 卸载 → 清理副本。
 *
 * ## 为什么不 shell.openPath 让用户拖
 *
 * 真机后果（2026-10-30 用户截图）：Dock 里并排两个图标 —— 用户拖拽时
 * 没覆盖原 app（或拖到桌面），每更新一次多一个副本；而 /Applications
 * 里的那个还停在旧版本，从来没被替换过。
 *
 * ## 为什么用 ditto 而不是 cp -R
 *
 * ditto 保留资源分支、扩展属性、代码签名和权限位。cp -R 会把签名信息
 * 搞坏，macOS 随后会报「已损坏，请丢进废纸篓」。
 *
 * ## 为什么必须清理副本
 *
 * 即使这次覆盖成功，之前手动拖出来的孪生副本还在。Dock 按 bundle id
 * 归组，但 Launchpad / 聚焦 / 访达会列出全部 —— 用户看到的还是一堆图标。
 * 所以扫一遍常见位置，只删**同一个 bundle id 且不是当前路径**的副本。
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function installMacDmg (dmgPath, deps) {
  const opts = deps || {}
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const appPath = opts.appPath || '/Applications/' + APP_BUNDLE
  const currentApp = opts.currentApp || process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, '')

  if (!fs.existsSync(dmgPath)) return { ok: false, reason: '安装包不存在' }

  // ① 挂载到一个空目录（-nobrowse 不让它在访达里弹出来）
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'pixupd-'))
  const attach = await run('hdiutil', ['attach', dmgPath, '-nobrowse', '-noverify', '-readonly', '-mountpoint', mnt])
  if (attach.code !== 0) {
    try { fs.rmSync(mnt, { recursive: true, force: true }) } catch (e) {}
    return { ok: false, reason: '挂载失败：' + (attach.stderr || '').trim().slice(0, 120) }
  }

  const cleanup = async () => {
    try { await run('hdiutil', ['detach', mnt, '-force', '-quiet']) } catch (e) {}
    try { fs.rmSync(mnt, { recursive: true, force: true }) } catch (e) {}
  }

  try {
    // ② 从卷里找 .app（卷根目录下唯一一个）
    let entries = []
    try { entries = fs.readdirSync(mnt) } catch (e) {}
    const appName = entries.find(n => n.endsWith('.app'))
    if (!appName) { await cleanup(); return { ok: false, reason: 'dmg 里没有 .app' } }
    const src = path.join(mnt, appName)

    // ③ 先复制到应用目录旁边的暂存包。旧包在复制和校验完成前完全不动。
    //    不能先把 appPath 删掉：磁盘满、ditto 中断或权限变化都会让用户
    //    既没有旧版也没有完整新版。
    const staging = path.join(
      path.dirname(appPath),
      '.HelloPix-update-' + process.pid + '-' + Date.now() + '.app'
    )
    try {
      if (fs.existsSync(staging)) await removeDir(staging)
      const copy = await run('ditto', [src, staging])
      if (copy.code !== 0) {
        await removeDir(staging)
        await cleanup()
        return { ok: false, reason: '复制到暂存目录失败：' + (copy.stderr || '').trim().slice(0, 120) }
      }

      // 暂存包先做签名结构校验，再碰旧包。未签名/损坏包不应该进入替换阶段。
      const verify = await run('codesign', ['--verify', '--deep', '--strict', staging])
      if (verify.code !== 0) {
        await removeDir(staging)
        await cleanup()
        return { ok: false, reason: '暂存包签名校验失败：' + (verify.stderr || '').trim().slice(0, 120) }
      }

      // 去掉隔离属性：从 dmg 复制出来的文件带 com.apple.quarantine，
      // 不处理的话首次打开会弹"下载自互联网，确定要打开吗"。
      await run('xattr', ['-dr', 'com.apple.quarantine', staging])
      const swapped = await replaceAppBundle(staging, appPath)
      if (!swapped) {
        await removeDir(staging)
        await cleanup()
        return { ok: false, reason: '无法原子替换应用，已保留旧版本' }
      }
    } catch (e) {
      await removeDir(staging)
      await cleanup()
      return { ok: false, reason: (e && e.message) || String(e) }
    }
    await cleanup()

    // ⑤ 清理其它位置的孪生副本（这是 Dock 里两个图标的直接原因）
    const removed = await removeTwinCopies(appPath, currentApp, log)
    log('已安装到 ' + appPath + (removed.length ? '，清理副本：' + removed.join(', ') : ''))
    return { ok: true, installedTo: appPath, removed }
  } catch (e) {
    await cleanup()
    return { ok: false, reason: (e && e.message) || String(e) }
  }
}

/**
 * 在同一目录内用暂存 bundle 替换应用。
 *
 * rename 只在同一文件系统内保证不跨设备，因此暂存目录必须和应用目录同级；
 * 旧包先改名为备份，新的 rename 失败时立刻恢复备份。返回 false 表示旧包
 * 已成功保留，调用方可以安全回退到手动安装。
 */
async function replaceAppBundle (staging, appPath) {
  const dir = path.dirname(appPath)
  const backup = path.join(dir, '.HelloPix-old-' + process.pid + '-' + Date.now() + '.app')
  let oldMoved = false
  try {
    if (fs.existsSync(appPath)) {
      fs.renameSync(appPath, backup)
      oldMoved = true
    }
    fs.renameSync(staging, appPath)
    if (oldMoved) {
      // 旧包已经不再需要；清理失败不影响已经完成的新安装。
      await removeDir(backup)
    }
    return true
  } catch (error) {
    try {
      if (fs.existsSync(appPath)) fs.rmSync(appPath, { recursive: true, force: true })
      if (oldMoved && fs.existsSync(backup)) fs.renameSync(backup, appPath)
    } catch (restoreError) {
      try { fs.renameSync(backup, appPath) } catch (e) {}
    }
    return false
  }
}

/**
 * 把 /Applications、~/Applications、桌面、下载里**同一个应用**的其它副本
 * 移入废纸篓。更新失败或用户误留的副本必须可恢复，不能 rm -rf。
 *
 * 判据是 bundle id 相同且路径不是刚装好的那个 —— 只看文件名会把用户
 * 自己改名的 app 漏掉，只按名字删又可能误伤。bundle id 写在 Info.plist 里，
 * 读它最准。
 */
async function removeTwinCopies (keepPath, currentApp, log, rootsOverride) {
  const BUNDLE_ID = 'com.hellopix.desktop'
  const roots = rootsOverride || ['/Applications', path.join(os.homedir(), 'Applications'), path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'Downloads')]
  const removed = []

  // ★ 用 plutil 而不是 defaults ★
  //
  // 2026-10-30 真机验证抓到的 bug：`defaults read <path>/Info/CFBundleIdentifier`
  // 要求路径**不带 .plist 后缀**，而且对任意 app 包的行为不稳定 ——
  // 实测返回非 0，于是所有副本都被判成"不是我们的 app"，一个都没清掉。
  // plutil 直接吃完整路径（带后缀），输出稳定。
  const bundleIdOf = async (p) => {
    const plist = path.join(p, 'Contents', 'Info.plist')
    const r = await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist])
    return r.code === 0 ? r.stdout.trim() : ''
  }

  for (const root of roots) {
    let names = []
    try { names = fs.readdirSync(root) } catch (e) { continue }
    for (const n of names) {
      if (!n.endsWith('.app')) continue
      const full = path.join(root, n)
      if (full === keepPath) continue
      if (currentApp && full === currentApp) continue
      const id = await bundleIdOf(full)
      if (id !== BUNDLE_ID) continue
      try {
        if (!moveToTrash(full)) throw new Error('移入废纸篓失败')
        removed.push(full)
        if (log) log('已把副本移入废纸篓：' + full)
      } catch (e) {
        if (log) log('副本未移动（不影响更新）：' + full + ' ' + ((e && e.message) || e))
      }
    }
  }
  return removed
}

/** 把同 bundle id 的副本移入废纸篓；失败时保留原文件，绝不 rm -rf 用户目录。 */
function moveToTrash (source) {
  const trash = path.join(os.homedir(), '.Trash')
  try {
    if (!fs.existsSync(trash)) return false
    const target = path.join(
      trash,
      path.basename(source) + '.pix-old-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex')
    )
    fs.renameSync(source, target)
    return true
  } catch (e) {
    return false
  }
}

/** 更新状态机。渲染层按 status 决定显示什么。 */
const STATUS = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  DOWNLOADING: 'downloading',
  VERIFYING: 'verifying',
  READY: 'ready', // 已下载并校验通过，等用户点「重启安装」
  INSTALLING: 'installing',
  DONE: 'done',
  FAILED: 'failed'
})

/**
 * @param {object} deps
 * @param {object} deps.app            electron app
 * @param {Function} deps.emit         把状态推给渲染层 (payload) => void
 * @param {Function} deps.log          (level, message) => void
 * @param {object} [deps.env]          便于测试注入
 */
function createUpdater (deps) {
  const { app, emit, log } = deps
  const env = (deps && deps.env) || process.env
  const getMountedImages = typeof deps.mountedDmgPaths === 'function'
    ? deps.mountedDmgPaths
    : mountedDmgPaths

  const state = {
    status: STATUS.IDLE,
    version: '',
    url: '',
    sha256: '',
    file: '',
    received: 0,
    total: 0,
    percent: 0,
    error: '',
    // 用户在下载过程中点了取消 / 关窗口
    cancelled: false
  }

  let task = null

  function snapshot () {
    return {
      status: state.status,
      version: state.version,
      received: state.received,
      total: state.total,
      percent: state.percent,
      error: state.error
    }
  }

  function push (extra) {
    const payload = Object.assign(snapshot(), extra || {})
    try { emit(payload) } catch (e) {}
    return payload
  }

  function setStatus (status, extra) {
    state.status = status
    return push(extra)
  }

  /**
   * 下载到临时目录。**不能**直接写到 userData 里 —— 那是用户数据区，
   * 一个半截的 100MB 文件留在那儿既占空间又让下次启动的清理逻辑复杂。
   */
  function tempFileFor (version, url) {
    const dir = path.join(app.getPath('temp'), 'hello-pix-update')
    fs.mkdirSync(dir, { recursive: true })
    // 保留原扩展名：Windows 上 .exe 的某些安全策略会看扩展名
    const ext = path.extname(String(url || '').split('?')[0]) || '.bin'
    return path.join(dir, 'HelloPix-' + String(version || 'new').replace(/[^\w.-]/g, '_') + ext)
  }

  /**
   * 带进度下载 + 边下边算 sha256。
   *
   * 边算而不是下完再读一遍：100MB 读两遍在机械盘上要多几秒，且多一段
   * 「文件存在但还没校验」的窗口期。
   */
  async function download (url, dest, expectedSha, onProgress) {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error('下载失败：HTTP ' + res.status + '（' + url + '）')
    // 有些 CDN 不回 content-length；此时 total=0，界面显示不确定进度
    const total = Number(res.headers.get('content-length') || 0)

    const hash = crypto.createHash('sha256')
    const tmp = dest + '.part'
    const out = fs.createWriteStream(tmp)

    let received = 0
    const body = res.body
    if (!body) throw new Error('下载失败：响应没有内容')

    // Node 18+ 的 fetch body 是 Web ReadableStream，转成 Node 流才能 pipeline
    const { Readable } = require('stream')
    const nodeStream = Readable.fromWeb(body)

    // 节流：每 200ms 推一次，否则每 64KB 一次会把 IPC 打满。
    // ★ 但「收完最后一个字节时」必须补一次 100% ★ —— 下载极快（本地网 / CDN 命中）
    // 时用户只会看到一条 0%→96% 的事件，然后卡在 96% 直到校验完，看起来像挂了。
    let lastEmit = 0
    let lastPushed = 0
    nodeStream.on('data', chunk => {
      received += chunk.length
      hash.update(chunk)
      const now = Date.now()
      if (now - lastEmit >= 200) {
        lastEmit = now
        lastPushed = received
        onProgress(received, total)
      }
    })

    try {
      await pipeline(nodeStream, out)
    } catch (error) {
      try { fs.unlinkSync(tmp) } catch (e) {}
      throw error
    }

    // 补最后一条：正常情况下最后一个节流窗口可能还差几十 MB 没推过
    if (lastPushed < received) onProgress(received, total)

    const actual = hash.digest('hex')
    if (String(expectedSha || '').toLowerCase() !== actual) {
      try { fs.unlinkSync(tmp) } catch (e) {}
      throw new Error('安装包校验失败：摘要不匹配（期望 ' +
        String(expectedSha || '').slice(0, 12) + '…，实际 ' + actual.slice(0, 12) + '…）')
    }

    // 校验通过才改名成正式文件：临时目录里保留 .part 让下次能清理
    fs.renameSync(tmp, dest)
    return { file: dest, size: received }
  }

  /**
   * 把已验证的文件交给 electron-updater 安装。
   *
   * ## 为什么不让 electron-updater 自己下载
   *
   * 它下载时用的是 latest.yml 里的 sha512，而我们的信任根是服务端签名的
   * sha256。两条链路不能混：混了就会出现「electron-updater 认了、我们没认」
   * 或者反过来。所以这里只让它做最后一步安装。
   *
   * ## 平台差异
   *
   *  · Windows (NSIS)：electron-updater 能跑 `/S` 静默安装，然后自己退出
   *  · macOS (DMG)：Squirrel.Mac 要求 app 是**签名过**的，未签名/未公证时
   *    会直接失败。失败就退回到「用系统打开 dmg，用户手动拖」—— 这也是
   *    `manualInstall` 存在的原因。
   *
   * @returns {Promise<{ok: boolean, manual?: boolean, reason?: string}>}
   */
  async function install (file) {
    // 动态 require：只有真要用到时才加载，避免测试环境里 electron-updater
    // 在缺 electron 的情况下抛错把整个模块拖垮
    let autoUpdater
    try {
      autoUpdater = require('electron-updater').autoUpdater
    } catch (e) {
      return { ok: false, manual: true, reason: '当前构建未包含自动安装组件' }
    }

    // ★ 关键 ★：禁止它自己检查/下载。我们只在最后一步借它的安装能力。
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = null

    // 用一个最小的本地 provider 指向「已经下好、已经校验过」的那个文件。
    // setFeedURL 到 file:// 目录 + 由我们自己写一份 latest.yml 是最稳的做法，
    // 但对「只装本地已知文件」这个场景，NSIS 直接执行安装包更简单、
    // 也少一层由我们伪造 yml 带来的风险。
    if (process.platform === 'win32') {
      const { spawn } = require('child_process')
      // /S = Silent。用户点「重启并安装」时已经明确同意了。
      //
      // ★ 退出时机很关键 ★
      //
      // NSIS 安装器启动后要先把自身解压到临时目录，然后才能替换正在运行的
      // exe。如果我们在它解压完之前就退出，替换时文件仍然被锁 —— 安装器会
      // 弹「无法关闭应用」的对话框，或者直接静默失败，用户看到的只是
      // 「点了没反应，重启还是旧版本」。
      //
      // 所以：等 spawn 真正回调（进程已创建）再多留 800ms 给它解压，
      // 而不是一 spawn 就掐表。detached + unref 让它脱离我们独立存活。
      const child = spawn(file, ['/S'], { detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()

      const waitForSpawn = new Promise(resolve => {
        // spawn 成功时 emit 'spawn'；失败时 'error'。两种都要 resolve，
        // 否则这条路径在 spawn 失败时会永远挂住，界面一直「安装中…」。
        child.once('spawn', resolve)
        child.once('error', resolve)
        // 兜底：某些系统上 'spawn' 事件不触发（极少见），1.5s 后照样继续
        setTimeout(resolve, 1500)
      })
      await waitForSpawn
      setTimeout(() => { try { app.quit() } catch (e) {} }, 800)
      return { ok: true }
    }

    // ── macOS：自己完成"挂载 dmg → 复制到 /Applications → 清理旧副本" ──
    //
    // ★ 2026-10-30 改 ★
    // 原来只是 shell.openPath(dmg) 让用户手动拖。真机后果（用户截图）：
    // Dock 里并排躺着 Hello Pix 1.3.3 和 1.3.4 两个图标 —— 用户拖拽时
    // 没覆盖原 app，或者拖到了桌面，于是每更新一次多一个副本。
    // 而且 /Applications/Hello Pix.app 一直停在 1.2.1 从没被替换过。
    //
    // 现在走完整流程：挂载 → ditto 覆盖 → 卸载 → 删掉其它位置的同名副本。
    // 全程不需要用户动手，也就不会产生副本。
    if (process.platform === 'darwin') {
      const macResult = await installMacDmg(file, {
        log: msg => { if (log) log('info', 'update', msg) }
      })
      if (macResult.ok) {
        setTimeout(() => { try { app.quit() } catch (e) {} }, 600)
        return macResult
      }
      // 自动装失败（公证/权限/只读卷）才退回原来的人工拖拽。
      // 必须先把包从 temp 复制到下载目录；直接打开 temp 文件会在下次启动
      // 清理时被删除，已挂载的 DMG 随之损坏。
      if (log) log('warn', 'update', 'macOS 自动安装失败，退回手动：' + (macResult.reason || ''))
      const preserved = await preserveManualInstaller(file, {
        downloadsDir: app.getPath('downloads'),
        expectedSha: state.sha256,
        log: msg => { if (log) log('info', 'update', msg) }
      })
      if (!preserved.ok) {
        return {
          ok: false,
          manual: true,
          reason: '自动安装失败，安装包也无法保存到下载目录：' + (preserved.reason || '')
        }
      }
      const { shell } = require('electron')
      const err = await shell.openPath(preserved.file)
      if (err) return { ok: false, manual: true, reason: '无法打开安装包：' + err }
      setTimeout(() => { try { app.quit() } catch (e) {} }, 1200)
      return {
        ok: true,
        manual: true,
        reason: '已打开下载目录中的安装包，把 Hello Pix 拖入「应用程序」即可完成更新'
      }
    }

    // Linux：交给系统打开，用户手动完成。
    const { shell } = require('electron')
    const err = await shell.openPath(file)
    if (err) return { ok: false, manual: true, reason: '无法打开安装包：' + err }

    // ★ 打开 dmg/安装包之后要让本进程退出 ★
    // 用户接下来会把新版本拖进「应用程序」覆盖旧包。如果旧进程还活着：
    //   · 覆盖时 macOS 可能提示「应用正在使用中」
    //   · 用户拖完看到旧界面还在，以为没更新成功，再点一次又下一遍
    // 延迟一点点退出，保证 shell.openPath 已经把 dmg 交给 Finder ——
    // 立刻退会让窗口在 dmg 弹出前就消失，看起来像崩了。
    setTimeout(() => { try { app.quit() } catch (e) {} }, 1200)
    return { ok: true, manual: true, reason: '已打开安装包，把 Hello Pix 拖入「应用程序」即可完成更新' }
  }

  /**
   * 开始一轮更新。
   *
   * @param {object} release 已经过 resolveRelease 验签的 { version, url, sha256 }
   */
  async function start (release) {
    if (task) return { ok: false, reason: '已经有更新在进行中' }
    if (!release || !release.url) return { ok: false, reason: '没有可用的更新地址' }

    state.cancelled = false
    state.version = String(release.version || '')
    state.url = String(release.url || '')
    state.sha256 = String(release.sha256 || '').toLowerCase()
    state.received = 0
    state.total = 0
    state.percent = 0
    state.error = ''
    state.file = ''

    // 没有 sha256 就不下 —— 无法校验的包等于没验签。
    if (!state.sha256) {
      state.status = STATUS.FAILED
      state.error = '更新清单缺少安装包摘要，已拒绝下载'
      push()
      return { ok: false, status: state.status, reason: state.error }
    }

    let dest = ''
    task = (async () => {
      try {
        dest = tempFileFor(state.version, state.url)
        writeUpdaterLock(dest)
        setStatus(STATUS.DOWNLOADING)

        const result = await download(state.url, dest, state.sha256, (received, total) => {
          state.received = received
          state.total = total
          // 留 1% 给「已收完、正在校验」这个阶段，否则进度条会一直满格却不动
          state.percent = total ? Math.min(99, Math.floor(received / total * 100)) : 0
          push()
        })

        if (state.cancelled) {
          try { fs.unlinkSync(result.file) } catch (e) {}
          removeUpdaterLock(result.file)
          setStatus(STATUS.IDLE, { error: '' })
          return
        }

        state.file = result.file
        state.total = result.size
        state.percent = 100
        setStatus(STATUS.READY)
        if (log) log('info', 'update', '已下载并校验 ' + state.version + '（' + result.size + ' 字节）')
      } catch (error) {
        if (dest) removeUpdaterLock(dest)
        state.status = STATUS.FAILED
        state.error = String((error && error.message) || error)
        push()
        if (log) log('error', 'update', '自动更新失败：' + state.error)
      } finally {
        task = null
      }
    })()

    push()
    return { ok: true, status: state.status, version: state.version }
  }

  /** 用户点了「重启并安装」。文件必须是本轮下载且校验过的那一个。 */
  async function apply () {
    if (state.status !== STATUS.READY || !state.file) {
      return { ok: false, reason: '没有可安装的更新包' }
    }
    if (!fs.existsSync(state.file)) {
      state.status = STATUS.FAILED
      state.error = '安装包已被清理，请重新检查更新'
      push()
      return { ok: false, reason: state.error }
    }
    setStatus(STATUS.INSTALLING)
    const r = await install(state.file)
    if (!r.ok) {
      state.status = STATUS.READY
      state.error = r.reason || '自动安装失败'
      push()
      return { ok: false, reason: state.error }
    }
    setStatus(STATUS.DONE, { manual: !!r.manual, reason: r.reason || '' })
    return { ok: true, manual: !!r.manual, reason: r.reason || '' }
  }

  function cancel () {
    state.cancelled = true
    return snapshot()
  }

  /**
   * 清理临时目录里上一轮留下的安装包。
   *
   * ## 为什么要清「成功的」那些
   *
   * 下载成功后文件名是 HelloPix-1.2.8.dmg / .exe（约 100MB）。用户装完新版，
   * 这个文件就再也没用了；不清的话每更新一次就留一份，一年下来几百 MB
   * 横在系统临时目录里，还都是可执行的安装包。
   *
   * ## 为什么不清正在下的那个
   *
   * `state.file` 指向的就是当前要安装的文件 —— 安装还没开始时不能删。
   * 所以这里跳过 `state.file`，其他一律删（包括 .part 半截文件）。
   */
  function cleanup () {
    try {
      const dir = path.join(app.getPath('temp'), 'hello-pix-update')
      if (!fs.existsSync(dir)) return
      const keep = state.file ? path.basename(state.file) : ''
      const keepPart = keep ? keep + '.part' : ''
      const mounted = getMountedImages()
      for (const name of fs.readdirSync(dir)) {
        if (name === keep || name === keepPart) continue
        const target = path.join(dir, name)
        if (/\.lock$/i.test(name)) {
          const ownerFile = name.slice(0, -5)
          if (!lockOwnerIsAlive(path.join(dir, ownerFile))) {
            try { fs.unlinkSync(target) } catch (e) {}
          }
          continue
        }
        const lockBase = lockBaseForName(dir, name)
        if (lockOwnerIsAlive(lockBase)) continue
        // Finder 可能仍挂载 temp 里的 DMG。删掉底层文件会让挂载卷立刻变成
        // I/O 错误；查询失败时按“可能仍挂载”处理，只清理可确定安全的文件。
        if (/\.dmg$/i.test(name) && (!mounted.known || mounted.paths.some(p => samePath(p, target)))) {
          continue
        }
        try { fs.unlinkSync(target) } catch (e) {}
      }
    } catch (e) {}
  }

  return {
    STATUS,
    start,
    apply,
    cancel,
    cleanup,
    state: snapshot,
    get file () { return state.file }
  }
}

module.exports = {
  createUpdater,
  STATUS,
  installMacDmg,
  replaceAppBundle,
  removeTwinCopies,
  preserveManualInstaller,
  mountedDmgPaths
}
