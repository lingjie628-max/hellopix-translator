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
  if (pendingUpdateUrl) {
    updateDesc.textContent = '新版本已经准备好，建议更新以获得更稳定的使用体验。'
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

updateDownloadBtn.onclick = () => {
  if (!pendingUpdateUrl) return
  window.pix.openUrl(pendingUpdateUrl)
  showOverlay(updatePanel, false)
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
