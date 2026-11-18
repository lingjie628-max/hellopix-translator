/**
 * 撞单提醒 + 软件更新检测。
 *
 * ## 为什么这两件事放一个文件
 *
 * 它们都是"服务端主动告诉客户端一件事，客户端弹一个横幅/面板"的同一类流程：
 * 拉取 → 过滤 → 渲染一次 → 用户关掉就不再重复。拆成两个文件反而要把
 * `showOverlay`、`closeOperationMenus` 这些抽屉状态各引一遍。
 *
 * ## 撞单为什么只做 warn
 *
 * 按产品要求先观察：误报时不应挡住正常工作。等真实数据出来才知道哪些场景
 * 该升级为 block。另外跨商户撞单是**匿名**的 —— 服务端只给一句提示，
 * 客户端不要试图渲染姓名或账号（返回体里根本没有，也刻意不查）。
 *
 * ## 版本号的唯一持有者
 *
 * `appVersion` 由 app.js 声明（它还要写到页脚和「关于」面板）。这里通过
 * `window.__appVersion` 读写 —— 模块之间靠 `let` 互相赋值会变成
 * "谁后加载谁说了算"，而脚本加载顺序换个 <script> 标签就变了。
 *
 * ★ 必须在 app.js 之前加载（app.js 启动时会调 checkCollisions）★
 */

/** 已提醒过的撞单 id。同一单不重复弹 —— 轮询是周期性的，不去重会一直闪。 */
const seenCollisions = new Set()

function showCollisionBanner(items) {
  const box = document.getElementById('pixCollision')
  if (!box) return
  const fresh = items.filter(it => !seenCollisions.has(String(it.id)))
  // 没有新单但有旧单在展示：保持现状。全清空了才收起横幅。
  if (!fresh.length) { if (!items.length) box.classList.remove('on'); return }
  fresh.forEach(it => seenCollisions.add(String(it.id)))

  const it = fresh[0]
  // 跨商户撞单不显示"同事 ID"：那会暴露另一家商户的人，服务端也没给。
  const who = it.kind === 'cross_merchant'
    ? ''
    : (it.colleagueEmployeeId ? '（同事 ID ' + it.colleagueEmployeeId + '）' : '')
  box.innerHTML = ''
  // 一律 textContent：客户 ID 与 message 来自服务端，拼 HTML 等于开洞。
  const title = document.createElement('b')
  title.textContent = '⚠ ' + (it.title || '检测到客户撞单')
  const body = document.createElement('span')
  body.textContent = '客户 ' + it.customerId + ' — ' + it.message + who
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '知道了'
  close.onclick = () => { box.classList.remove('on'); box.innerHTML = '' }
  box.appendChild(title); box.appendChild(body); box.appendChild(close)
  box.classList.add('on')
}

async function checkCollisions() {
  if (!window.pix || !window.pix.customerReminders) return
  try {
    const items = await window.pix.customerReminders()
    if (Array.isArray(items) && items.length) showCollisionBanner(items)
  } catch (e) {
    // 撞单提醒失败绝不能影响主流程：它是增值提示，不是必需功能。
  }
}

// ---------------------------------------------------------------------------
// 软件更新
// ---------------------------------------------------------------------------

/** 已发现的新版本下载地址。空字符串 = 服务端说"有新版但还没发安装包"。 */
let pendingUpdateUrl = ''

/**
 * 当前软件版本号。
 *
 * `appVersion` 由 app.js 用 `let` 声明（它还要写到页脚和「关于」面板）。
 * 所有非模块脚本共享同一个全局词法环境，所以这里**直接引用**即可 ——
 * 只是读它，不重新声明。反过来在这里再 `let appVersion = ...` 会在
 * app.js 加载时抛 SyntaxError（重复声明），整份 app.js 不执行。
 */
function currentAppVersion() {
  return typeof appVersion === 'undefined' ? '-' : String(appVersion || '-')
}

/** 同目录的 app.js 持有 appVersion；这里只写它需要的那一处刷新。 */
function setAppVersion(v) {
  if (typeof appVersion !== 'undefined') appVersion = String(v || '-')
}

function showUpdateNotice(resp) {
  const local = String((resp && resp.local) || currentAppVersion() || '-')
  const remote = String((resp && resp.remote) || '-')
  pendingUpdateUrl = String((resp && resp.url) || '')
  updateVersionText.textContent = '当前版本 ' + local + '  →  最新版本 ' + remote
  // 每次打开面板先把进度条收起来：上一次的下载状态由 onUpdateProgress 决定
  if (updateProgressWrap) updateProgressWrap.classList.add('hidden')
  if (pendingUpdateUrl) {
    updateDesc.textContent = '新版本已经准备好，点击「立即更新」直接下载并安装。'
    updateDownloadBtn.disabled = false
    updateDownloadBtn.textContent = '立即更新'
  } else {
    // 明确区分"没更新"和"有更新但还没发包"：后者是服务端的中间态，
    // 说成"已是最新"会误导用户以为不用管了。
    updateDesc.textContent = '已检测到新版本，但安装包尚未发布。发布后可在这里直接下载。'
    updateDownloadBtn.disabled = true
    updateDownloadBtn.textContent = '暂未发布'
  }
  closeOperationMenus()
  showOverlay(updatePanel, true)
}

/* ---------------------------------------------------------------------------
 * 应用内自动更新
 *
 * ## 和以前的行为差别
 *
 * 以前：点「立即更新」→ `window.pix.openUrl(url)` → 浏览器下载 → 用户自己装。
 * 现在：点「立即更新」→ 主进程下载 + 逐字节校验 sha256 → 装 / 打开安装包。
 *
 * ## 为什么按钮还是同一个
 *
 * 用户的心智模型没变（"点它就能更新"），变的是它背后做了什么。多一个
 * 「自动更新」按钮反而让人犹豫要选哪个。
 *
 * ## 失败必须能退回浏览器
 *
 * 自动更新会在很多地方失败：没写权限、被安全软件拦、磁盘满、macOS 未公证。
 * 任何一种失败都要把「打开下载页」还回给用户 —— 更新功能坏了不能连累升级。
 * 所以 failed 状态下按钮文案改成「浏览器下载」，点击退回 openUrl。
 * ------------------------------------------------------------------------ */

/** 当前面板该走哪条路：'auto'（应用内）还是 'browser'（浏览器兜底）。 */
let updateMode = 'auto'

function formatBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB'
  return (v / 1024 / 1024).toFixed(1) + ' MB'
}

function renderUpdateProgress(p) {
  if (!p) return
  const status = String(p.status || '')
  if (updateProgressWrap) {
    updateProgressWrap.classList.toggle('hidden',
      status !== 'downloading' && status !== 'verifying' && status !== 'installing')
  }

  if (status === 'downloading') {
    updateMode = 'auto'
    const pct = Number(p.percent) || 0
    if (updateProgressBar) updateProgressBar.style.width = pct + '%'
    if (updateProgressText) {
      updateProgressText.textContent = p.total
        ? '正在下载 ' + formatBytes(p.received) + ' / ' + formatBytes(p.total) + '（' + pct + '%）'
        : '正在下载 ' + formatBytes(p.received)
    }
    updateDesc.textContent = '正在下载新版本，下载完成后会自动校验安装包。'
    updateDownloadBtn.disabled = true
    updateDownloadBtn.textContent = '下载中…'
    return
  }

  if (status === 'verifying') {
    if (updateProgressBar) updateProgressBar.style.width = '100%'
    if (updateProgressText) updateProgressText.textContent = '正在校验安装包完整性…'
    updateDownloadBtn.disabled = true
    updateDownloadBtn.textContent = '校验中…'
    return
  }

  if (status === 'ready') {
    updateMode = 'auto'
    if (updateProgressBar) updateProgressBar.style.width = '100%'
    if (updateProgressText) updateProgressText.textContent = '下载完成，安装包已通过完整性校验'
    updateDesc.textContent = '点击「立即安装」完成更新，应用会自动重启。'
    updateDownloadBtn.disabled = false
    updateDownloadBtn.textContent = '立即安装'
    return
  }

  if (status === 'installing') {
    if (updateProgressText) updateProgressText.textContent = '正在启动安装程序…'
    updateDownloadBtn.disabled = true
    updateDownloadBtn.textContent = '安装中…'
    return
  }

  if (status === 'done') {
    updateDesc.textContent = p.reason || '更新已安装，请重新打开应用。'
    updateDownloadBtn.disabled = true
    updateDownloadBtn.textContent = '已完成'
    return
  }

  if (status === 'failed') {
    // ★ 退回浏览器：自动更新坏了不能让用户卡死在这里 ★
    updateMode = 'browser'
    if (updateProgressWrap) updateProgressWrap.classList.add('hidden')
    updateDesc.textContent = (p.error || '自动更新失败') + '。可以改用浏览器下载安装包。'
    updateDownloadBtn.disabled = !pendingUpdateUrl
    updateDownloadBtn.textContent = '浏览器下载'
  }
}

updateDownloadBtn.onclick = async () => {
  // 「浏览器下载」兜底路径（自动更新失败后）
  if (updateMode === 'browser') {
    if (!pendingUpdateUrl) return
    window.pix.openUrl(pendingUpdateUrl)
    showOverlay(updatePanel, false)
    return
  }
  // 「立即安装」：上一轮已经下载并校验完成
  const st = await window.pix.updateState().catch(() => null)
  if (st && st.status === 'ready') {
    updateDownloadBtn.disabled = true
    updateDownloadBtn.textContent = '安装中…'
    const r = await window.pix.updateApply().catch(e => ({ ok: false, reason: String(e && e.message || e) }))
    if (r && !r.ok) {
      updateMode = 'browser'
      updateDesc.textContent = (r.reason || '自动安装失败') + '。可以改用浏览器下载安装包。'
      updateDownloadBtn.disabled = !pendingUpdateUrl
      updateDownloadBtn.textContent = '浏览器下载'
    }
    return
  }
  // 正常路径：开始应用内下载
  updateDownloadBtn.disabled = true
  updateDownloadBtn.textContent = '准备中…'
  const r = await window.pix.updateStart().catch(e => ({ ok: false, reason: String(e && e.message || e) }))
  if (!r || !r.ok) {
    updateMode = 'browser'
    updateDesc.textContent = ((r && r.reason) || '无法自动更新') + '。已切换为浏览器下载。'
    updateDownloadBtn.disabled = !pendingUpdateUrl
    updateDownloadBtn.textContent = '浏览器下载'
    if (!pendingUpdateUrl) updateDownloadBtn.textContent = '暂未发布'
  }
}

async function checkUpdate() {
  const hint = document.getElementById('updateHint')
  const btn = document.getElementById('checkUpdateBtn')
  if (hint) hint.textContent = '正在检查…'
  if (btn) btn.disabled = true
  try {
    const resp = await window.pix.checkUpdate()
    if (!resp || !resp.success) {
      if (hint) hint.textContent = (resp && resp.msg) || '暂时无法检查更新'
      return
    }
    if (resp.local) setAppVersion(resp.local)
    if (!resp.remote) {
      if (hint) hint.textContent = '当前已是最新版本'
      return
    }
    // 版本比较必须走 cmpVer：'1.10.0' < '1.9.0' 的字符串比较会把新版判成旧版。
    if (cmpVer(resp.remote, resp.local) > 0) {
      if (hint) hint.textContent = '发现新版本 ' + resp.remote
      showUpdateNotice(resp)
    } else if (hint) hint.textContent = '当前已是最新版本'
  } catch (e) {
    if (hint) hint.textContent = friendlyError(e, '暂时无法检查更新')
  } finally {
    if (btn) btn.disabled = false
  }
}

/* ---------------------------------------------------------------------------
 * 自动更新的进度推送
 *
 * 注册在脚本顶层：这个文件是普通 <script>，加载完就要能收到主进程的事件。
 * 事件可能在面板还没打开时就到达（用户在下载中途关掉面板又打开），所以
 * 收到事件时无条件更新状态，面板是否可见由 showOverlay 决定。
 * ------------------------------------------------------------------------ */
if (window.pix && typeof window.pix.onUpdateProgress === 'function') {
  window.pix.onUpdateProgress(renderUpdateProgress)
}
