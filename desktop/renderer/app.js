/**
 * 把异常转成能直接给用户看的一句话。
 *
 * 为什么需要：ipcRenderer.invoke 抛出的错误会被 Electron 包一层，
 * 原样显示出来是
 *   Error invoking remote method 'auth:login': Error: API 线路不符合安全策略
 * 既泄漏内部实现（方法名、错误分层），又不是用户能处理的措辞。
 * 这里剥掉包装，并把几个已知原因换成可执行的提示。
 */

let proxyPresetRows = []
let proxyDetectTimer = 0
let geoManual = false

let current = null
let appVersion = '-'
let refreshTimer = null
let speedTimer = null
let lineRows = []
let preferAuto = true
let selectedId = 'auto'
let fastest = null
let skipAutoLogin = false
let supportUrl = ''
let supportNote = ''
let footerOfficialUrl = ''
let footerGuideUrl = ''
let footerDownloads = {}

function siteSupport(info) {
  const d = (info && (info.data || info)) || {}
  const url = String(d.telegramUrl || '').trim()
  const account = String(d.telegram || '').trim()
  return {
    url: url || (account ? 'https://t.me/' + account.replace(/^@/, '') : ''),
    note: String(d.supportNote || ''),
    btnText: d.supportBtnText || '联系客服',
    show: Number(d.supportShow) !== 0,
    officialUrl: String(d.officialUrl || d.websiteUrl || ''),
    guideUrl: String(d.guideUrl || ''),
    downloads: Object.assign({ app: String(d.clientDownloadUrl || '') }, d.clientDownloads || {})
  }
}

function applySupport(info) {
  const s = siteSupport(info)
  supportUrl = s.url
  supportNote = s.note
  footerOfficialUrl = s.officialUrl
  footerGuideUrl = s.guideUrl
  footerDownloads = s.downloads
  supportBtn.textContent = s.btnText
  supportBtn.style.display = s.show ? '' : 'none'
  syncFooterDownloads(s.downloads)
}

/**
 * 纯函数：某个下载入口在当前下发数据下是否该显示。
 *
 * 刻意与 DOM 操作分开，是为了能被测试**直接执行** —— 渲染层没有 DOM 环境
 * （仓库里没有 jsdom），抽不出纯逻辑的话就只能退化成正则匹配源码，那测不出
 * "点击是否真的会失效"这种语义。
 */
function footerDownloadVisible(key, downloads) {
  // app 走 checkUpdate()，不依赖 downloads.app，因此不能按 URL 判断。
  if (key === 'app') return true
  // standalone 走 standaloneApps：**只有真有在架独立应用时才显示**。
  // 曾经写死返回 true，于是"套餐承诺了独立应用版、实际一条 standalone 发布记录
  // 都没有"时按钮照样出现 —— 用户点下去只得到「独立应用尚未上架」。那正是迁移
  // 036 要摘掉的那类"有权益、没东西"。改成按数据显隐之后，将来登记了发布记录
  // 就会自动重新出现，不必再发一次客户端。
  if (key === 'standalone') {
    const apps = (downloads || {}).standaloneApps
    return Array.isArray(apps) && apps.some(item => item && item.url)
  }
  return Boolean(String((downloads || {})[key] || ''))
}

/**
 * 让底部下载入口按**真实上架情况**显隐。
 *
 * 背景：index.html 里「安卓手机版」「苹果手机版」是静态写死的按钮，而产品
 * 没有任何移动端 —— 服务端 `clientDownloads.android` / `.ios` 下发的是空字符串
 * （core-service.js 的 `download()` 在 client_releases 里找不到记录就返回 ''，
 * 2026-09-27 在生产 /apis/site/info 上实测确实为空）。
 *
 * 于是用户点下去**毫无反应**：`runFooterAction` 对空 URL 直接 `return`，
 * 既不打开链接也不报错，看起来就是"软件坏了"。这与迁移 035 的结论也直接冲突 ——
 * 035 刚把「手机版」这个兑现不了的权益承诺从套餐文案里摘掉，客户端底部却还在
 * 暗示有两个手机版可以下载。（「独立应用版」是同一种病，见迁移 036。）
 *
 * 三点讲究：
 *
 *   1. 用**排除法**而不是白名单：除了 app 这一个特例（它走 checkUpdate），其余
 *      一律"没东西可下就不显示"。这样以后新增任何下载入口都自动安全，不会又冒
 *      出一个死按钮 —— 白名单会让新入口默认可见。
 *   2. standalone **也**按数据显隐（见 footerDownloadVisible）：它曾经是第二个
 *      特例、恒显。恒显的代价是"有权益、没东西"时按钮还在，点下去只得到
 *      「独立应用尚未上架」—— 与迁移 036 摘「独立应用版」的理由直接冲突。
 *   3. 是**显隐**而不是删按钮：哪天移动端 / 独立应用真上架、后台配了发布记录，
 *      按钮自动出现，不需要再改客户端代码、也就不必再发一次版。
 */
function syncFooterDownloads(downloads) {
  document.querySelectorAll('[data-footer-action="download"]').forEach(btn => {
    const key = btn.dataset.downloadKey || ''
    btn.style.display = footerDownloadVisible(key, downloads) ? '' : 'none'
  })
}

async function loadSupport() {
  try {
    applySupport(await window.pix.siteInfo())
  } catch (e) {}
}

async function openSupport() {
  await loadSupport()
  if (supportUrl) window.pix.openUrl(supportUrl)
}

async function runFooterAction(action, downloadKey) {
  await loadSupport()
  if (action === 'support') return openSupport()
  if (action === 'official' && footerOfficialUrl) return window.pix.openUrl(footerOfficialUrl)
  if (action === 'guide') {
    if (footerGuideUrl) return window.pix.openUrl(footerGuideUrl)
    return openSupport()
  }
  if (action === 'download') {
    if (downloadKey === 'standalone') return openStandaloneDownload()
    const url = String(footerDownloads[downloadKey] || '')
    if (url) return window.pix.openUrl(url)
    if (downloadKey !== 'app') return
    const resp = await window.pix.checkUpdate()
    if (resp && resp.url) return window.pix.openUrl(resp.url)
    if (resp && resp.remote && cmpVer(resp.remote, resp.local) > 0) showUpdateNotice(resp)
  }
}

function standaloneApps() {
  return (footerDownloads.standaloneApps || []).filter(item => item && item.url)
}

function showStandaloneNotice(message) {
  standaloneTitle.textContent = '独立应用版'
  standaloneMsg.textContent = message
  standaloneList.innerHTML = ''
  showOverlay(standalonePanel, true)
}

function showStandalonePicker(apps) {
  standaloneTitle.textContent = '选择独立应用'
  standaloneMsg.textContent = '请选择要下载的单应用翻译客户端。'
  standaloneList.innerHTML = apps.map(item => {
    const name = esc(item.title || item.app || '独立应用')
    const meta = esc([item.version, item.os].filter(Boolean).join(' · '))
    return '<button type="button" data-url="' + esc(item.url) + '"><b>' + name + '</b><span>' + meta + '</span></button>'
  }).join('')
  showOverlay(standalonePanel, true)
}

function openStandaloneDownload() {
  if (!current || Number(current.standaloneClient) !== 1) {
    return showStandaloneNotice('当前套餐未包含独立应用版')
  }
  const apps = standaloneApps()
  if (!apps.length) return showStandaloneNotice('独立应用尚未上架')
  if (apps.length === 1) return window.pix.openUrl(apps[0].url)
  return showStandalonePicker(apps)
}

async function persistAuth() {
  await window.pix.saveAuth({
    remember: rememberPwd.checked,
    autoLogin: autoLogin.checked,
    username: usernameEl.value.trim(),
    password: passwordEl.value
  })
}

function bindAuthToggles() {
  rememberPwd.onchange = () => {
    if (!rememberPwd.checked) autoLogin.checked = false
    persistAuth()
  }
  autoLogin.onchange = () => {
    if (autoLogin.checked) rememberPwd.checked = true
    persistAuth()
  }
}

function isActive(id) {
  return (preferAuto && id === 'auto') || (!preferAuto && id === selectedId)
}

function addLineRow(id, name, extra, extraClass) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'line-item' + (isActive(id) ? ' active' : '')
  row.innerHTML = '<span>' + esc(name) + '</span>' + (extra ? '<span class="' + extraClass + '">' + esc(extra) + '</span>' : '')
  row.onclick = (event) => {
    event.stopPropagation()
    chooseLine(id)
  }
  lineMenu.appendChild(row)
}

function renderTrigger() {
  if (preferAuto) {
    lineTriggerName.textContent = '自动选择'
    lineTriggerMs.textContent = ''
    return
  }
  const line = lineRows.find(l => l.id === selectedId)
  lineTriggerName.textContent = (line && line.name) || '自动选择'
  lineTriggerMs.textContent = line ? speedText(line) : ''
  lineTriggerMs.className = line ? speedClass(line) : 'ms'
}

function renderLines() {
  lineMenu.innerHTML = ''
  // 只有一条线路时不展示选择器：既没有可选项，"自动选择"也没有意义。
  // 多线路（服务器部署了分区节点）时自动恢复显示，不需要改代码。
  const single = lineRows.length === 1
  const dd = lineDd
  // 连"线路"标签所在的外层 field 一起隐藏，否则会留下一个空标签
  const field = dd && dd.closest ? dd.closest('.field') : null
  if (field) field.classList.toggle('hidden', single)
  else if (dd) dd.classList.toggle('hidden', single)
  if (single) {
    // 只有一条就固定用它，跳过测速与"自动选择"逻辑
    preferAuto = false
    selectedId = lineRows[0].id
    renderTrigger()
    return
  }
  addLineRow('auto', '自动选择', '', '')
  lineRows.forEach(line => {
    addLineRow(line.id, line.name || '线路', speedText(line), speedClass(line))
  })
  renderTrigger()
}

function chooseLine(id) {
  preferAuto = id === 'auto'
  selectedId = id
  lineDd.classList.remove('open')
  renderLines()
  if (!preferAuto) window.pix.selectLine(id)
}

async function pingAll(silent) {
  if (!silent) {
    lineRows.forEach(line => { line.pending = true })
    renderLines()
  }
  const result = await window.pix.pingAll()
  if (result && result.rows) {
    lineRows = result.rows.map(row => Object.assign({}, row, { pending: false }))
  } else {
    lineRows.forEach(line => { line.pending = false })
  }
  fastest = result && result.best
  renderLines()
  return fastest
}

function startSpeedWatch() {
  stopSpeedWatch()
  pingAll(false)
  speedTimer = setInterval(() => {
    if (!loginScreen.classList.contains('hidden')) pingAll(true)
  }, 8000)
}

function stopSpeedWatch() {
  if (speedTimer) {
    clearInterval(speedTimer)
    speedTimer = null
  }
}

async function pickLine() {
  if (!preferAuto) {
    await window.pix.selectLine(selectedId)
    return
  }
  const best = fastest || await pingAll(true)
  if (!best) throw new Error('线路暂时连不上，请确认后台已启动')
  await window.pix.selectLine(best.id)
}

function show(el, on) {
  el.classList.toggle('hidden', !on)
}

function overlayVisible() {
  return !profile.classList.contains('hidden') || !transPanel.classList.contains('hidden') || !lockScreen.classList.contains('hidden') || !addApp.classList.contains('hidden') || !proxySettings.classList.contains('hidden') || !updatePanel.classList.contains('hidden') || !standalonePanel.classList.contains('hidden')
}

function syncOverlay() {
  if (window.pix && window.pix.setOverlay) window.pix.setOverlay(overlayVisible())
}

function showOverlay(el, on) {
  if (on) {
    show(profile, el === profile)
    show(transPanel, el === transPanel)
    show(lockScreen, el === lockScreen)
    show(addApp, el === addApp)
    show(proxySettings, el === proxySettings)
    show(updatePanel, el === updatePanel)
    show(standalonePanel, el === standalonePanel)
  } else {
    show(el, false)
  }
  syncOverlay()
}

function bindModalDismiss(el) {
  el.addEventListener('click', (event) => {
    if (event.target === el) showOverlay(el, false)
  })
}

let dndOn = false
let checkedIds = {}

function setAnnounce() {}

function setProfile(data) {
  current = data
  setAnnounce(data.announcement)
  profileBody.innerHTML =
    '<div class="kv"><span>账号</span><b>' + esc(data.username) + (data.role === 'sub' ? '（子账号）' : '') + '</b></div>' +
    '<div class="kv"><span>字符余额</span><b class="num">' + (data.charBalance || 0) + '</b></div>' +
    '<div class="kv"><span>已用字符</span><b class="num">' + (data.charUsed || 0) + '</b></div>' +
    '<div class="kv"><span>当前软件版本</span><span class="ver-side"><b class="num">' + esc(appVersion) + '</b><button type="button" id="checkUpdateBtn" class="mini">检查更新</button></span></div>' +
    '<p id="updateHint" class="update-hint"></p>'
  const btn = document.getElementById('checkUpdateBtn')
  if (btn) btn.onclick = checkUpdate
}


let pendingUpdateUrl = ''

// ---------------------------------------------------------------------------
// 撞单提醒
//
// 按产品要求先做 warn（只提醒、不阻止操作）—— 误报时不会挡住正常工作，
// 等真实数据出来再决定哪些场景需要升级为 block。
//
// 跨商户撞单是**匿名**的：服务端只给一句提示，客户端不要试图渲染姓名或账号
// （返回体里根本没有，也刻意不查）。
// ---------------------------------------------------------------------------
const seenCollisions = new Set()

function showCollisionBanner(items) {
  const box = document.getElementById('pixCollision')
  if (!box) return
  const fresh = items.filter(it => !seenCollisions.has(String(it.id)))
  if (!fresh.length) { if (!items.length) box.classList.remove('on'); return }
  fresh.forEach(it => seenCollisions.add(String(it.id)))

  const it = fresh[0]
  const who = it.kind === 'cross_merchant'
    ? ''
    : (it.colleagueEmployeeId ? '（同事 ID ' + it.colleagueEmployeeId + '）' : '')
  box.innerHTML = ''
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
  } catch (e) {}
}

function showUpdateNotice(resp) {
  const local = String((resp && resp.local) || appVersion || '-')
  const remote = String((resp && resp.remote) || '-')
  pendingUpdateUrl = String((resp && resp.url) || '')
  updateVersionText.textContent = '当前版本 ' + local + '  →  最新版本 ' + remote
  if (pendingUpdateUrl) {
    updateDesc.textContent = '新版本已经准备好，建议更新以获得更稳定的使用体验。'
    updateDownloadBtn.disabled = false
    updateDownloadBtn.textContent = '立即更新'
  } else {
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
    if (resp.local) appVersion = resp.local
    if (!resp.remote) {
      if (hint) hint.textContent = '当前已是最新版本'
      return
    }
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


let platformCache = []

function appIcon(id, icon) {
  return 'icons/' + encodeURIComponent(icon || id) + '.svg'
}

function iconTag(id, cls, icon) {
  return '<img class="' + (cls || '') + '" src="' + appIcon(id, icon) + '" alt="" draggable="false">'
}

async function openApp(id) {
  // 返回值里可能带 success:false（例如已达实例上限、系统句柄不足）。
  // 主进程会同时弹原生提示；这里不再重复弹窗，只是别把结果丢掉。
  try {
    const resp = await window.pix.open({ platformId: id, multi: true })
    return resp
  } catch (e) {
    return { success: false, msg: (e && e.message) || '打开失败' }
  }
}

// 语言选项：常用语种置顶，其余按代码字母序跟在后面。
// LANGS 本身是按语言代码排的（aa 阿法尔语、ace 亚齐语…），直接用会让最常用的
// 中文落到第 186 位、俄语第 136 位 —— 用户每选一次都要滚过上百个冷门语种。
// 这里只改**展示顺序**，不动 LANGS 数据本身。

/**
 * 界面应当显示的翻译通道。
 *
 * 套餐不允许切换时，服务端会用「套餐内第一个已接通且启用的通道」，
 * 账号里存的那点选择一律被忽略 —— 此时必须显示服务端的解析结果，
 * 否则用户看到的通道与实际调用/计费的不是同一个（真机表现：
 * 显示 GPT、实际走 DeepSeek）。
 */
async function fillApps() {
  const resp = await window.pix.platforms()
  fillAppLists((resp && resp.rows) || [])
}

function tabLabel(tab) {
  if (tab.showTabName === false) return ''
  return tab.name || tab.title || ''
}

let lastTabs = []
let editingEnabledId = ''

function enabledName(tab) {
  return String((tab && (tab.name || tab.title)) || '').trim()
}

function startRename(tab, label) {
  const span = label.querySelector('.enabled-name')
  if (!span || editingEnabledId) return
  editingEnabledId = tab.id
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'enabled-name-input'
  input.value = enabledName(tab)
  input.maxLength = 40
  span.replaceWith(input)
  input.focus()
  input.select()
  let done = false
  const finish = async (ok) => {
    if (done) return
    done = true
    editingEnabledId = ''
    const next = input.value.trim()
    if (ok && next && next !== enabledName(tab)) {
      try { await window.pix.renameTab(tab.id, next) } catch (e) {}
    } else {
      fillEnabled(lastTabs)
    }
  }
  input.onkeydown = event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      finish(true)
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      finish(false)
    }
  }
  input.onblur = () => finish(true)
  input.onclick = event => event.stopPropagation()
  input.ondblclick = event => event.stopPropagation()
}

function fillEnabled(rows) {
  lastTabs = rows || []
  // "已启用的应用"只列**在标签栏里能看见的**窗口。
  // 隐藏的窗口进程还活着，但它是"后台运行"，不属于"已启用"这个列表 ——
  // 混进来会让计数虚高（明明只开着 2 个窗口却显示 3 个），
  // 而且点它会把窗口叫回来，与"隐藏"的语义冲突。
  const list = lastTabs.filter(tab => !tab.hidden)
  enabledMeta.textContent = list.length ? list.length + ' 个应用' : '暂无启用'
  if (editingEnabledId && enabledList.querySelector('.enabled-name-input')) return
  enabledList.innerHTML = ''
  list.forEach(tab => {
    const row = document.createElement('div')
    row.className = 'enabled-row'
    const label = document.createElement('div')
    label.className = 'enabled-label'
    label.innerHTML = iconTag(tab.platform, '', tab.icon) + '<span class="enabled-name">' + esc(enabledName(tab)) + '</span>'
    let clickTimer = 0
    label.onclick = event => {
      event.stopPropagation()
      clearTimeout(clickTimer)
      clickTimer = setTimeout(() => window.pix.switchTab(tab.id), 280)
    }
    label.ondblclick = event => {
      event.preventDefault()
      event.stopPropagation()
      clearTimeout(clickTimer)
      startRename(tab, label)
    }
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = !!checkedIds[tab.id]
    box.onclick = (event) => event.stopPropagation()
    box.onchange = () => {
      if (box.checked) checkedIds[tab.id] = true
      else delete checkedIds[tab.id]
    }
    row.appendChild(label)
    row.appendChild(box)
    row.onclick = () => window.pix.switchTab(tab.id)
    enabledList.appendChild(row)
  })
}

function paintStatus(state, home, rows) {
  show(appStatus, false)
  appStatusText.textContent = ''
}

function closeOperationMenus(except) {
  ;[appOpsWrap, systemOpsWrap].forEach(el => {
    if (el && el !== except) el.classList.remove('open')
  })
}

function activeTabState() {
  const state = window.__lastTabState || {}
  return ((state.rows || []).find(tab => tab.id === state.activeId)) || null
}

function paintOperationMenus(home, rows) {
  const hasActiveApp = !home && !!activeTabState()
  // 应用内：工具行清空，只在正中留翻译开关；主页按钮全部保留
  const utilityEl = document.querySelector('.utility')
  if (utilityEl) utilityEl.classList.toggle('in-app', hasActiveApp)
  if (appOpsWrap) appOpsWrap.classList.toggle('hidden', !hasActiveApp)
  // 进/出应用时把两个下拉都收掉：此前只清 appOpsWrap 的 open，systemOpsWrap
  // 从不清理，实测"主页打开系统操作 → 进应用 → 回主页"后菜单自己还开着
  // （wrapOpen=true、opacity=1）。closeOperationMenus() 不带参数即关全部。
  if (!hasActiveApp) closeOperationMenus()
  if (!rows || !rows.length) closeOperationMenus()
}

function flashMenuButton(button, text, delay) {
  if (!button) return
  const label = button.querySelector('b')
  if (!label) return
  const original = button.dataset.originalLabel || label.textContent
  button.dataset.originalLabel = original
  label.textContent = text
  clearTimeout(button._labelTimer)
  button._labelTimer = setTimeout(() => {
    label.textContent = original
    button.classList.remove('busy', 'danger-confirm')
  }, delay || 1800)
}

async function runMenuAction(button, busyText, action) {
  if (!button || button.classList.contains('busy')) return
  button.classList.add('busy')
  flashMenuButton(button, busyText, 10000)
  try {
    const result = await action()
    flashMenuButton(button, (result && result.msg) || '操作完成', 1800)
  } catch (e) {
    flashMenuButton(button, (e && e.message) || '操作失败', 2200)
  }
}


let contextPoint = { x: 0, y: 0 }

function hidePixContextMenu() {
  if (pixContextMenu) pixContextMenu.classList.add('hidden')
}

function renderPixContextMenu(x, y, title, items, tab) {
  if (!pixContextMenu) return
  contextPoint = { x: x, y: y }
  pixContextMenu.innerHTML =
    '<div class="pix-context-title"><i></i>' + esc(title) + '</div>' +
    items.map(item => {
      if (item.sep) return '<div class="pix-context-sep"></div>'
      return '<button type="button" data-action="' + esc(item.action) + '"' +
        (item.danger ? ' class="danger"' : '') + '>' +
        '<span>' + item.icon + '</span><b>' + esc(item.label) + '</b>' +
        (item.key ? '<em>' + esc(item.key) + '</em>' : '') + '</button>'
    }).join('')
  pixContextMenu.classList.remove('hidden')
  pixContextMenu.style.left = '0px'
  pixContextMenu.style.top = '0px'
  const box = pixContextMenu.getBoundingClientRect()
  pixContextMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8)) + 'px'
  pixContextMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) + 'px'
  pixContextMenu.querySelectorAll('button[data-action]').forEach(button => {
    button.onclick = event => {
      event.stopPropagation()
      const action = button.dataset.action
      hidePixContextMenu()
      runPixContextAction(action, tab)
    }
  })
}

function showPixContextMenu(event, tab) {
  event.preventDefault()
  event.stopPropagation()
  closeOperationMenus()
  hidePixContextMenu()
  window.pix.showContextMenu({
    home: !tab,
    id: tab ? tab.id : ''
  })
}

async function runPixContextAction(action, tab) {
  if (action === 'rename') {
    if (tab && !editingTabId) {
      const el = tabsEl.querySelector('[data-tab-id="' + tab.id + '"]')
      if (el) startTabRename(tab, el)
    }
    return
  }
  if (action === 'account') {
    userBox.click()
    return
  }
  if (action === 'softwareUpdate') {
    systemUpdateBtn.click()
    return
  }
  if (action === 'restartAsk') {
    renderPixContextMenu(contextPoint.x, contextPoint.y, '确认重启', [
      { action: 'restartConfirm', icon: '↯', label: '确认重启软件', danger: true },
      { action: 'cancel', icon: '←', label: '取消' }
    ], null)
    return
  }
  if (action === 'restartConfirm') {
    window.pix.restartApp()
    return
  }
  if (action === 'cancel') return
  if (!tab) return
  if (action === 'appUpdate') {
    await window.pix.updatePlatform(tab.platform)
    return
  }
  await window.pix.contextAction(tab.id, action)
}

let editingTabId = ''

function startTabRename(tab, el) {
  if (editingTabId) return
  let span = el.querySelector('.tab-name')
  if (!span) {
    // 「不在标签上显示名称」时本来没有名字节点。重命名是明确的操作意图，
    // 这里临时补一个输入框 —— 否则用户右键点了重命名，界面毫无反应。
    span = document.createElement('span')
    span.className = 'tab-name'
    el.appendChild(span)
  }
  editingTabId = tab.id
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'tab-name-input'
  input.value = enabledName(tab)
  input.maxLength = 40
  span.replaceWith(input)
  input.focus()
  input.select()
  let done = false
  const finish = async (ok) => {
    if (done) return
    done = true
    editingTabId = ''
    const next = input.value.trim()
    if (ok && next && next !== enabledName(tab)) {
      try { await window.pix.renameTab(tab.id, next) } catch (e) {}
    } else if (window.__lastTabState) {
      renderTabs(window.__lastTabState)
    }
  }
  input.onkeydown = event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      finish(true)
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      finish(false)
    }
  }
  input.onblur = () => finish(true)
  input.onclick = event => event.stopPropagation()
  input.ondblclick = event => event.stopPropagation()
}

/**
 * 关闭窗口前的二次确认。
 *
 * ## 为什么必须有
 *
 * 标签上的「×」紧贴着账号名称，鼠标一滑就点到；一关，那个号的窗口连同
 * 登录状态当场消失，而且**没有任何撤销手段** —— 用户只能重新扫码登录。
 * 误点一次的代价远大于多确认一次的成本。
 *
 * ## 实现要点
 *
 * - 用原生 `<dialog>`：进 top-layer，能盖住原生视图（普通 div 会被遮挡）。
 * - **默认焦点在「取消」**：手快的人直接回车 / 空格，结果是"没关"，
 *   而不是"关了"。危险操作永远不该是默认选项。
 * - 返回 Promise 而不是回调：调用方 `await` 之后才知道到底关不关，
 *   批量关闭时能逐个确认，逻辑不会乱。
 * - 同一时刻只允许一个确认框（连点两次 × 不能让两个框叠起来）。
 */
let closeConfirmResolve = null

/**
 * 通用二次确认。
 *
 * @param {string} title  标题，例如「关闭这个窗口？」
 * @param {string} text   后果说明
 * @param {string} okText 确认按钮文案
 * @returns {Promise<boolean>} 只有明确点了确认按钮才为 true
 */
function confirmAction(title, text, okText) {
  const dialog = document.getElementById('closeConfirm')
  const titleEl = document.getElementById('closeConfirmTitle')
  const textEl = document.getElementById('closeConfirmText')
  const okBtn = document.getElementById('closeConfirmOk')
  const cancelBtn = document.getElementById('closeConfirmCancel')
  if (!dialog || typeof dialog.showModal !== 'function') {
    // 环境不支持 dialog（极老内核）：宁可放行也不能把关闭功能卡死。
    return Promise.resolve(true)
  }
  titleEl.textContent = title || '确认操作？'
  textEl.textContent = text || ''
  okBtn.textContent = okText || '确认'

  // 上一个还开着就先按"取消"结掉，避免两个 Promise 悬着。
  if (closeConfirmResolve) {
    const prev = closeConfirmResolve
    closeConfirmResolve = null
    prev(false)
  }

  return new Promise(resolve => {
    const finish = answer => {
      if (closeConfirmResolve !== finish) return
      closeConfirmResolve = null
      okBtn.onclick = null
      cancelBtn.onclick = null
      dialog.oncancel = null
      dialog.onclose = null
      try { if (dialog.open) dialog.close() } catch (e) {}
      resolve(answer)
    }
    closeConfirmResolve = finish
    okBtn.onclick = () => finish(true)
    cancelBtn.onclick = () => finish(false)
    // ESC / 点遮罩：一律当作取消。对话框关掉的任何非明确确认路径都必须
    // 落到"不关"，否则就等于绕过确认。
    dialog.oncancel = event => { event.preventDefault(); finish(false) }
    dialog.onclose = () => finish(false)
    try {
      if (dialog.open) dialog.close()
      dialog.showModal()
      // 焦点显式落到取消上（autofocus 在某些内核对 dialog 不生效）
      cancelBtn.focus()
    } catch (e) {
      finish(false)
    }
  })
}


function syncHomeVideo(home) {
  if (stageEl) stageEl.classList.toggle('is-home', !!home)
  if (!homeBgVideo) return
  if (home && !shellScreen.classList.contains('hidden')) homeBgVideo.play().catch(() => {})
  else homeBgVideo.pause()
}

async function enterShell(data) {
  stopSpeedWatch()
  if (loginBgVideo) loginBgVideo.pause()
  syncHomeVideo(true)
  setProfile(data)
  show(loginScreen, false)
  show(shellScreen, true)
  try {
    const info = await window.pix.siteInfo()
    const notice = info && (info.announcement || (info.data && info.data.announcement))
    if (notice) setAnnounce(notice)
  } catch (e) {}
  await fillApps()
  try {
    const resp = await window.pix.translateEngines()
    engineRows = ((resp && resp.rows) || []).filter(e => e.allowed !== false)
    canSwitchEngine = !(resp && resp.canSwitch === false)
    // 套餐锁定时，服务端解析出的通道才是真实会用的那个；显示必须跟着它走。
    authoritativeEngine = canSwitchEngine ? '' : String((resp && resp.activeEngine) || '')
  } catch (e) {
    engineRows = []
    authoritativeEngine = ''
  }
  renderTabs(await window.pix.tabs())
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(async () => {
    const resp = await window.pix.session()
    if (resp && resp.kicked) return
    if (resp && resp.obj) setProfile(resp.obj)
    // 撞单提醒搭这趟车，不另开定时器
    checkCollisions()
  }, 8000)
}

async function doLogin() {
  loginError.textContent = ''
  loginBtn.disabled = true
  try {
    await pickLine()
    const resp = await window.pix.login({
      username: usernameEl.value.trim(),
      password: passwordEl.value
    })
    if (!resp || !resp.success) {
      loginError.textContent = (resp && resp.msg) || '登录失败'
      skipAutoLogin = true
      return
    }
    await persistAuth()
    await enterShell(resp.obj)
  } catch (err) {
    loginError.textContent = friendlyError(err, '无法连接后台')
  } finally {
    loginBtn.disabled = false
  }
}

loginBtn.onclick = doLogin
supportBtn.onclick = openSupport
pixFooter.onclick = (event) => {
  const btn = event.target.closest('[data-footer-action]')
  if (btn) runFooterAction(btn.dataset.footerAction, btn.dataset.downloadKey || '')
}
lineTrigger.onclick = (event) => {
  event.stopPropagation()
  lineDd.classList.toggle('open')
}
document.addEventListener('click', () => {
  lineDd.classList.remove('open')
  closeOperationMenus()
  hidePixContextMenu()
})
pixContextMenu.addEventListener('click', event => event.stopPropagation())
lineMenu.addEventListener('click', (event) => event.stopPropagation())
passwordEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') doLogin()
})
if (toolbarLogo) toolbarLogo.onclick = () => window.pix.home()
userBox.onclick = async () => {
  closeOperationMenus()
  try {
    const resp = await window.pix.session()
    if (resp && resp.obj) setProfile(resp.obj)
  } catch (e) {}
  showOverlay(profile, true)
}
profileClose.onclick = () => showOverlay(profile, false)
bindModalDismiss(profile)
bindModalDismiss(transPanel)
bindModalDismiss(addApp)
bindModalDismiss(updatePanel)
bindModalDismiss(standalonePanel)
standaloneClose.onclick = () => showOverlay(standalonePanel, false)
standaloneList.onclick = (event) => {
  const btn = event.target.closest('button[data-url]')
  if (btn && btn.dataset.url) window.pix.openUrl(btn.dataset.url)
}
updateLaterBtn.onclick = () => showOverlay(updatePanel, false)
// 已存在线路的「代理设置」弹窗
proxySettingsX.onclick = () => showOverlay(proxySettings, false)
psProxyCancel.onclick = () => showOverlay(proxySettings, false)
psProxyType.onchange = () => {
  const preset = psPresetOf()
  psSchemeOptions(preset)
  psSyncFields(null)
  if ((preset.hosts || []).length && psProxyHostSel.value !== 'custom') psApplyHostChoice(preset)
}
psProxyHostSel.onchange = () => {
  const preset = psPresetOf()
  if (psProxyHostSel.value === 'custom') {
    psProxyHost.readOnly = false
    psProxyHost.focus()
    return
  }
  psApplyHostChoice(preset)
  psProxyHost.readOnly = !preset.hostEditable && preset.kind !== 'custom'
}
// 与「新增应用」一致：粘贴整行时自动拆成主机/端口/账号/密码
psProxyHost.addEventListener('blur', () => {
  const value = psProxyHost.value.trim()
  if (!value.includes(':') || value.split(':').length < 2) return
  const parsed = parseProxyLine(value)
  if (!parsed) return
  if (parsed.host) psProxyHost.value = parsed.host
  if (parsed.port) psProxyPort.value = parsed.port
  if (parsed.user) psProxyUser.value = parsed.user
  if (parsed.pass !== undefined) psProxyPass.value = parsed.pass
})
psProxySave.onclick = () => {
  const patch = readProxySettingsForm()
  if (patch.proxyType !== 'none' && !patch.proxyHost) {
    psProxyMsg.textContent = '请填写代理主机'
    psProxyHost.focus()
    return
  }
  psProxyMsg.textContent = ''
  saveProxySettings(patch)
}
// 删除代理：显式写 proxyType='none'，主进程会把这条线路的 session 复位成 direct
psProxyDirect.onclick = () => saveProxySettings({
  proxyType: 'none',
  proxyScheme: '',
  proxyHost: '',
  proxyPort: '',
  proxyUser: '',
  proxyPass: ''
})
bindModalDismiss(proxySettings)
addAppX.onclick = () => showOverlay(addApp, false)
addCancel.onclick = () => showOverlay(addApp, false)
addProxyType.onchange = () => syncProxyFields(false)
addProxyHostSel.onchange = () => {
  const preset = currentProxyPreset()
  if (addProxyHostSel.value === 'custom') {
    addProxyHost.readOnly = false
    addProxyHost.focus()
    return
  }
  applyHostChoice(preset, false)
  addProxyHost.readOnly = !preset.hostEditable && preset.kind !== 'custom'
}
addProxyHost.addEventListener('blur', () => {
  const value = addProxyHost.value.trim()
  if (value.includes(':') && (value.split(':').length >= 2)) applyProxyPaste(value)
  scheduleProxyDetect()
})
addProxyPort.addEventListener('blur', scheduleProxyDetect)
addProxyUser.addEventListener('blur', scheduleProxyDetect)
addProxyPass.addEventListener('blur', scheduleProxyDetect)
addProxyChannel.onchange = () => { if (addProxyHost.value.trim()) scheduleProxyDetect() }
addProxyDetectBtn.onclick = () => runProxyDetect()
addProxyCopyBtn.onclick = async () => {
  const lines = [
    'IP: ' + geoIp.value,
    '国家/地区: ' + geoCountry.value,
    '州/省: ' + geoRegion.value,
    '城市: ' + geoCity.value,
    '经度/纬度: ' + geoLoc.value,
    '时区: ' + geoTz.value,
    '邮编: ' + geoZip.value
  ].join('\n')
  try { await navigator.clipboard.writeText(lines) } catch (e) {}
  setDetectMsg('已复制检测结果', 'ok')
}
;[geoCountry, geoRegion, geoCity, geoLoc, geoTz, geoZip, geoIp].forEach(el => {
  el.addEventListener('input', () => { geoManual = true })
})
geoQuality.onclick = event => {
  const ip = geoIp.value.trim()
  if (!ip) {
    event.preventDefault()
    return
  }
  event.preventDefault()
  window.pix.openUrl('https://scamalytics.com/ip/' + encodeURIComponent(ip))
}
addUpdateBtn.onclick = async () => {
  if (!addAppItem || addAppItem.badge === false || addUpdateBtn.disabled) return
  addUpdateBtn.disabled = true
  addUpdateBtn.textContent = '更新中'
  try {
    const resp = await window.pix.updatePlatform(addAppItem.id)
    if (resp && resp.rows) fillAppLists(resp.rows)
    const latest = platformCache.find(row => row.id === addAppItem.id) || addAppItem
    addAppItem = latest
    paintAddVersion(latest)
  } catch (e) {
    addUpdateBtn.disabled = false
    addUpdateBtn.textContent = '点击更新'
  }
}
addConfirm.onclick = async () => {
  if (!addAppItem) return
  const settings = readAddSettings()
  const name = addName.value.trim() || addAppItem.name
  if (addAppItem.customUrl) {
    try {
      const url = new URL(settings.customUrl)
      if (!/^https?:$/.test(url.protocol)) throw new Error('protocol')
      settings.customUrl = url.href
    } catch (e) {
      addCustomUrl.focus()
      addCustomUrl.select()
      addCustomUrl.setCustomValidity('请输入完整网址，例如 https://example.com')
      addCustomUrl.reportValidity()
      return
    }
    addCustomUrl.setCustomValidity('')
  }
  try {
    await window.pix.savePreset({ platformId: addAppItem.id, name: name, settings: settings })
  } catch (e) {}
  await window.pix.open({ platformId: addAppItem.id, name: name, settings: settings, multi: true })
  showOverlay(addApp, false)
}
dndBtn.onclick = () => {
  dndOn = !dndOn
  dndText.textContent = dndOn ? '开' : '关'
}
lockBtn.onclick = () => {
  lockError.textContent = ''
  lockPwd.value = ''
  showOverlay(lockScreen, true)
  lockPwd.focus()
}

// --- 主题切换（日间 / 夜间）---------------------------------------------------
// 主题只做一件事：给 <html> 加/去 data-theme="light"，剩下全靠 CSS 变量覆盖。
// 持久化在主进程（config.json），所以重启、换窗口都记得住。

function paintThemeButton(mode) {
  const light = mode === 'light'
  // 图标表示"当前模式"，文字也跟随；title 说明点下去会切到哪边
  themeIco.textContent = light ? '☀️' : '🌙'
  themeText.textContent = light ? '日间' : '夜间'
  themeBtn.title = light ? '当前：日间模式，点击切换到夜间' : '当前：夜间模式，点击切换到日间'
}

function applyTheme(mode) {
  const next = mode === 'light' ? 'light' : 'dark'
  if (next === 'light') document.documentElement.setAttribute('data-theme', 'light')
  else document.documentElement.removeAttribute('data-theme')
  paintThemeButton(next)
  return next
}

// 启动时按主进程存的偏好应用（拿不到就保持深色）。
// 注意 theme.js 已在首帧前用 localStorage 预热过一次；这里用主进程的权威值
// 校正（换机/清缓存后仍正确），并把结果回写缓存供下次首帧使用。
if (themeBtn) {
  ;(async () => {
    let saved = 'light'
    try {
      const cfg = await window.pix.getConfig()
      saved = (cfg && cfg.theme) || 'light'
    } catch (e) {}
    applyTheme(saved)
    try { localStorage.setItem('pix-theme', saved) } catch (e) {}

    themeBtn.onclick = async () => {
      const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
      const next = current === 'light' ? 'dark' : 'light'
      applyTheme(next)                                      // 先切，界面立刻响应
      try { localStorage.setItem('pix-theme', next) } catch (e) {}   // 供下次首帧预热
      try { await window.pix.setTheme(next) } catch (e) {}  // 权威值落盘
    }
  })()
}

unlockBtn.onclick = async () => {
  lockError.textContent = ''
  const pwd = lockPwd.value
  let result
  try {
    result = await window.pix.verifyLock(pwd)
  } catch (e) {
    lockError.textContent = '暂时无法验证密码'
    return
  }
  if (!result || !result.success) {
    lockError.textContent = (result && result.msg) || '密码不正确'
    return
  }
  showOverlay(lockScreen, false)
}
lockPwd.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') unlockBtn.click()
})
/**
 * 轻提示（toast）。
 *
 * 用 popover 而不是普通 div 是必须的：页面里有一大块**原生视图**盖在 DOM 之上，
 * 普通定位的提示会被它彻底遮住 —— 用户点了垃圾桶却什么都没看见，
 * 只会以为"点了没反应"，然后反复点。
 * popover 进 top-layer，天然盖在原生视图之上。
 */
function toast(text, tone) {
  let el = document.getElementById('pixToast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'pixToast'
    el.className = 'pix-toast'
    el.setAttribute('popover', 'manual')
    document.body.appendChild(el)
  }
  el.textContent = text
  el.classList.toggle('warn', tone === 'warn')
  try {
    if (!el.matches(':popover-open')) el.showPopover()
  } catch (e) {}
  clearTimeout(el._timer)
  el._timer = setTimeout(() => {
    try { if (el.matches(':popover-open')) el.hidePopover() } catch (e) {}
  }, 2200)
}

clearEnabled.onclick = async () => {
  // 只处理可见窗口：后台运行的窗口不在这里展示，绝不能被"清空"一起关掉 ——
  // 那等于用户毫不知情地丢了一个挂着收消息的号。
  const visible = lastTabs.filter(tab => !tab.hidden)
  const ids = visible.filter(tab => checkedIds[tab.id]).map(tab => tab.id)
  // ★ 没有勾选就什么都不做 ★
  //
  // 以前这里是 `selected.length ? selected : visible.map(...)` —— 没勾选时
  // 直接**全关**。那是个极危险的默认值：用户点一下垃圾桶，所有号当场关掉，
  // 而且没法撤销。现在的规则是：垃圾桶只删你明确勾了的，没勾就提示。
  if (!ids.length) {
    toast('请选择需要关闭的窗口应用', 'warn')
    return
  }
  // 批量关闭只确认一次（不是逐个弹），文案要说清数量。
  // 逐个确认会让"关 5 个"需要点 10 次，用户反而会去乱点。
  const label = ids.length > 1
    ? '将关闭 ' + ids.length + ' 个窗口'
    : '将关闭「' + enabledName(lastTabs.find(t => t.id === ids[0])) + '」'
  if (!(await confirmAction(label, '关闭后需要重新登录才能再次打开。'))) return
  const count = ids.length
  ids.forEach(id => window.pix.close(id))
  checkedIds = {}
  toast(count > 1 ? '已关闭 ' + count + ' 个窗口' : '已关闭 1 个窗口')
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeOperationMenus()
    hidePixContextMenu()
    showOverlay(profile, false)
    showOverlay(transPanel, false)
    showOverlay(addApp, false)
    showOverlay(updatePanel, false)
    showOverlay(standalonePanel, false)
    if (!lockScreen.classList.contains('hidden')) return
  }
})

// 全球语言列表（ISO 639-1 全量 + 各翻译引擎额外支持的小语种）。
// 说明：世界语言有 7000+ 种，但只有翻译引擎真正支持的才有意义 —— 列进来
// 选不到的语种必然报错。当前覆盖 Google/DeepL/DeepSeek 等主流引擎支持的全部语种。
// 通道不支持的语种会在翻译时返回厂商错误码（不扣费），不会静默产出错误译文。
// 国家/地区官方语言列表（只收有国家或地区官方地位的语言，不收方言）。
// 已剔除：汉语各方言（粤语/闽南语/吴语/客家话/湘语/赣语/晋语/徽语/平话/闽北语）、
// 人工语言与死语言（世界语/拉丁语/叙利亚语/阿拉米语）、
// 以及无官方地位的部落与地区语言。
// 能否真正翻译取决于所选通道是否支持该语种（不支持的会返回厂商错误码，不扣费）。
// 全球各国官方语言列表（含多官方语言国家的全部官方语言）。
// 收录标准：在某国或地区具有官方地位。不收汉语方言、人工语言、死语言、
// 以及无官方地位的部落语言。
// 能否真正翻译取决于所选通道是否支持该语种（不支持会返回厂商错误码，不扣费）。

function fillLangs() {
  langMine.innerHTML = langOptionHtml(LANGS.filter(l => l.id !== 'auto'))
  langOther.innerHTML = langOptionHtml()
}

function applyTransPrefs(data) {
  if (!data) return
  transRecv.checked = data.transRecv !== 0
  transSend.checked = data.transSend !== 0
  transGroup.checked = !!data.transGroup
  includeZh.checked = !!Number(data.includeZh)
  if (data.langMine) langMine.value = data.langMine
  if (data.langOther) langOther.value = data.langOther
  if (data.activeEngine) transEngine.value = engineToShow(data.activeEngine)
}

async function openTransPanel() {
  fillLangs()
  applyTransPrefs(current)
  transMsg.textContent = ''
  try {
    const resp = await window.pix.translateEngines()
    const rows = (resp && resp.rows) || []
    transEngine.innerHTML = rows.filter(e => e.allowed !== false).map(e => {
      return '<option value="' + esc(e.id) + '">' + esc(e.name) + (e.wired ? '' : '') + '</option>'
    }).join('') || '<option value="">无可用通道</option>'
      transEngine.disabled = !canSwitchEngine
      transEngine.title = canSwitchEngine ? '' : '当前套餐的翻译通道由系统指定'
    applyTransPrefs(current)
  } catch (e) {
    transEngine.innerHTML = '<option value="">通道加载失败</option>'
  }
  showOverlay(transPanel, true)
}

async function saveTransPrefs() {
  const payload = {
    transRecv: transRecv.checked ? 1 : 0,
    transSend: transSend.checked ? 1 : 0,
    transGroup: transGroup.checked ? 1 : 0,
    includeZh: includeZh.checked ? 1 : 0,
    langMine: langMine.value,
    langOther: langOther.value,
    engine: transEngine.value
  }
  if (current) {
    current.transRecv = payload.transRecv
    current.transSend = payload.transSend
    current.transGroup = payload.transGroup
    current.includeZh = payload.includeZh
    current.langMine = payload.langMine
    current.langOther = payload.langOther
    current.activeEngine = payload.engine
  }
  try {
    const resp = await window.pix.saveTranslatePrefs(payload)
    transMsg.textContent = (resp && resp.msg) || '已保存'
  } catch (e) {
    transMsg.textContent = friendlyError(e, '保存失败')
  }
}

;[appOpsWrap, systemOpsWrap].forEach(el => {
  if (el) el.addEventListener('click', event => event.stopPropagation())
})
if (appOpsTrigger) {
  appOpsTrigger.onclick = () => {
    const open = !appOpsWrap.classList.contains('open')
    closeOperationMenus(appOpsWrap)
    appOpsWrap.classList.toggle('open', open)
  }
}
if (systemOpsTrigger) {
  systemOpsTrigger.onclick = () => {
    const open = !systemOpsWrap.classList.contains('open')
    closeOperationMenus(systemOpsWrap)
    systemOpsWrap.classList.toggle('open', open)
  }
}
if (appReloadBtn) {
  appReloadBtn.onclick = () => runMenuAction(appReloadBtn, '正在刷新…', async () => {
    return window.pix.reloadActiveApp()
  })
}
if (appUpdateBtn) {
  appUpdateBtn.onclick = () => runMenuAction(appUpdateBtn, '正在检查…', async () => {
    const tab = activeTabState()
    if (!tab) return { success: false, msg: '当前没有应用' }
    const result = await window.pix.updatePlatform(tab.platform)
    return result && result.success
      ? { success: true, msg: '检查完成，已更新缓存' }
      : result
  })
}
let clearConfirmTimer = 0
if (appClearBtn) {
  appClearBtn.onclick = () => {
    if (!appClearBtn.classList.contains('danger-confirm')) {
      appClearBtn.classList.add('danger-confirm')
      flashMenuButton(appClearBtn, '再次点击确认清理', 3500)
      clearTimeout(clearConfirmTimer)
      clearConfirmTimer = setTimeout(() => appClearBtn.classList.remove('danger-confirm'), 3500)
      return
    }
    clearTimeout(clearConfirmTimer)
    appClearBtn.classList.remove('danger-confirm')
    runMenuAction(appClearBtn, '正在清理…', async () => window.pix.clearActiveAppCache())
  }
}
if (systemUpdateBtn) {
  systemUpdateBtn.onclick = () => runMenuAction(systemUpdateBtn, '正在检查…', async () => {
    const resp = await window.pix.checkUpdate()
    if (!resp || !resp.success) return { success: false, msg: (resp && resp.msg) || '检查失败' }
    if (resp.remote && cmpVer(resp.remote, resp.local) > 0) {
      showUpdateNotice(resp)
      return { success: true, msg: '发现新版本 ' + resp.remote }
    }
    return { success: true, msg: '当前已是最新版本' }
  })
}
let restartConfirmTimer = 0
if (systemRestartBtn) {
  systemRestartBtn.onclick = () => {
    if (!systemRestartBtn.classList.contains('danger-confirm')) {
      systemRestartBtn.classList.add('danger-confirm')
      flashMenuButton(systemRestartBtn, '再次点击确认重启', 3500)
      clearTimeout(restartConfirmTimer)
      restartConfirmTimer = setTimeout(() => systemRestartBtn.classList.remove('danger-confirm'), 3500)
      return
    }
    clearTimeout(restartConfirmTimer)
    systemRestartBtn.classList.remove('danger-confirm')
    flashMenuButton(systemRestartBtn, '正在重启…', 10000)
    window.pix.restartApp()
  }
}

// --- 后台运行开关（关闭窗口时隐藏到托盘，而不是退出）-------------------------
// 和托盘右键菜单里那一项是同一个设置，读写都走主进程 config.json。
// 之所以要在界面上再放一个：多数用户不会去翻托盘菜单，等他把窗口关掉了
// 才发现"程序好像没退"，这时再去找托盘已经晚了。
function paintBackgroundButton(enabled) {
  const on = enabled !== false
  if (systemBackgroundIco) systemBackgroundIco.textContent = on ? '◉' : '○'
  if (systemBackgroundBtn) {
    systemBackgroundBtn.setAttribute('aria-pressed', on ? 'true' : 'false')
    systemBackgroundBtn.title = on
      ? '当前：关闭窗口后仍在后台运行。点一下改为「关闭即退出」'
      : '当前：关闭窗口即退出。点一下改为「关闭窗口后仍后台运行」'
  }
}
if (systemBackgroundBtn) {
  ;(async () => {
    let enabled = true
    try {
      const cfg = await window.pix.getConfig()
      if (cfg && typeof cfg.backgroundRunning === 'boolean') enabled = cfg.backgroundRunning
    } catch (e) {}
    paintBackgroundButton(enabled)
  })()
  // 托盘菜单里改了同一个开关 → 主进程推过来，这里跟上，避免两处显示不一致
  if (window.pix.onBackgroundRunning) {
    window.pix.onBackgroundRunning(enabled => paintBackgroundButton(enabled))
  }
  systemBackgroundBtn.onclick = async () => {
    const current = systemBackgroundBtn.getAttribute('aria-pressed') !== 'false'
    const next = !current
    paintBackgroundButton(next)   // 先动界面，点击立刻有反馈
    try {
      const res = await window.pix.setBackgroundRunning(next)
      // 以主进程回执为准；失败就退回原状态，避免界面和真实设置不一致
      paintBackgroundButton(res && res.success ? res.backgroundRunning : current)
    } catch (e) {
      paintBackgroundButton(current)
    }
  }
}

if (transBtn) {
  transBtn.onclick = () => {
    closeOperationMenus()
    openTransPanel()
  }
}
transClose.onclick = () => showOverlay(transPanel, false)
if (window.pix.onTranslateOpen) window.pix.onTranslateOpen(openTransPanel)
;[transRecv, transSend, transGroup, includeZh, langMine, langOther, transEngine].forEach(el => {
  el.addEventListener('change', saveTransPrefs)
})
;[barSendOn, barRecvOn, barSendFrom, barSendTo, barRecvFrom, barRecvTo, barGroupMode, barFontSize, barServer, barFontColor, barIncludeZh, barEngine, barQuickReply].forEach(el => {
  if (el) el.addEventListener('change', () => saveTransBar())
})
if (transBarToggle) {
  transBarToggle.onclick = () => {
    saveTransBar(Object.assign(readTransBarSettings(), { showTransBar: !transBarIsOpen() }))
  }
}
function backToLogin(msg) {
  if (refreshTimer) clearInterval(refreshTimer)
  current = null
  authoritativeEngine = ''
  engineRows = []
  canSwitchEngine = true
  preferAuto = true
  selectedId = 'auto'
  fastest = null
  showOverlay(profile, false)
  showOverlay(transPanel, false)
  showOverlay(addApp, false)
  showOverlay(updatePanel, false)
  showOverlay(standalonePanel, false)
  showOverlay(lockScreen, false)
  show(shellScreen, false)
  show(loginScreen, true)
  if (loginBgVideo) loginBgVideo.play().catch(() => {})
  syncHomeVideo(false)
  transBarPainted = false
  if (transBar) transBar.classList.add('is-collapsed')
  lineDd.classList.remove('open')
  loginError.textContent = msg || ''
  renderLines()
  startSpeedWatch()
}

logoutBtn.onclick = async () => {
  await window.pix.logout()
  backToLogin('')
}

window.pix.onTabs(renderTabs)
// 滚轮横向滚动标签栏。只绑一次（函数内部有幂等保护），
// 不能放进 renderTabs —— 那里每次重渲染都会跑，会叠出多个监听器。
attachTabsWheel()
// 翻译桥坏掉（或恢复）时主进程会推一条：立刻刷新侧边栏标记。
// 不能只在打开窗口时检查一次 —— 装包重载后桥可能才坏。
if (window.pix.onBridgeDown) {
  window.pix.onBridgeDown(() => { window.pix.tabs().then(renderTabs).catch(() => {}) })
}
window.pix.onPlatforms((data) => {
  fillAppLists((data && data.rows) || [])
})
window.pix.onSession((data) => {
  if (data) setProfile(data)
})
window.pix.onKicked((msg) => {
  skipAutoLogin = true
  backToLogin(msg || '账号已在其他电脑登录')
})
if (window.pix.onContextCommand) {
  window.pix.onContextCommand(command => {
    if (command && typeof command === 'object') {
      if (command.action === 'rename') {
        // 必须带 id：右键的可能是**非激活**标签，用激活项会改错窗口。
        const row = findTabRow(command.id) || activeTabRow()
        if (row) runPixContextAction('rename', row)
        return
      }
      if (command.action === 'closeAsk') {
        // 右键「关闭应用」也要二次确认，与标签上的 × 一致。
        const row = findTabRow(command.id)
        if (!row) return
        confirmCloseTab(row).then(ok => { if (ok) window.pix.close(row.id) })
        return
      }
      return
    }
    if (command === 'account') userBox.click()
    if (command === 'softwareUpdate') systemUpdateBtn.click()
  })
}
// 右键菜单点了「代理设置」：主进程只回传线路 id，这里为这条已存在的线路开弹窗
if (window.pix.onProxySettings) {
  window.pix.onProxySettings(id => openProxySettings(id))
}

window.pix.getConfig().then(async cfg => {
  try {
    appVersion = (await window.pix.version()) || '-'
    footerVersion.textContent = appVersion
  } catch (e) {}
  try {
    const presets = await window.pix.proxyPresets()
    proxyPresetRows = (presets && presets.rows) || []
    syncProxyFields(false)
  } catch (e) {}
  lineRows = (cfg && cfg.lines) || []
  preferAuto = true
  selectedId = 'auto'
  renderLines()
  bindAuthToggles()
  const auth = await window.pix.getAuth()
  if (auth && auth.remember) {
    rememberPwd.checked = true
    autoLogin.checked = !!auth.autoLogin
    usernameEl.value = auth.username || ''
  }
  try {
    const remote = await window.pix.listLines()
    if (remote && remote.rows && remote.rows.length) lineRows = remote.rows
  } catch (e) {}
  renderLines()
  startSpeedWatch()
  loadSupport()
  if (loginBgVideo) loginBgVideo.play().catch(() => {})
  if (!skipAutoLogin && auth && auth.remember && auth.autoLogin && auth.username && auth.hasStoredPassword) {
    try {
      const resp = await window.pix.autoLogin()
      if (resp && resp.success) await enterShell(resp.obj)
      else skipAutoLogin = true
    } catch (e) {
      skipAutoLogin = true
    }
  }
})
if (!usernameEl.value) usernameEl.focus()


// --- 工具条真实高度上报 -------------------------------------------------------
// 原生嵌入视图的位置由主进程按高度计算；此前用的是硬编码常量，改样式就会错位。
// 这里用 ResizeObserver 把实测高度报上去。
//
// 同时维护两个 CSS 变量：
//   --bar-rows-h  折叠动画的像素高。折叠只过渡这一个数字，内容尺寸全程锁死，
//                 避免逐帧重排整个网格子树（那正是卡顿感的来源）。用显式像素
//                 而不是 fr/1fr 轨道 —— 自动高度容器里的 fr 解析不可靠，实测会
//                 出现"类名已切回展开、高度却还是 0"。
//   --chrome-end  嵌入原生视图的起始 y = 顶部 chrome 总高（标签栏 + 工具行 + 工具条），
//                 主进程按同一个值定位视图，工作区顶边也用它。
//                 注意它**含**工具条上方的部分，别再把工具条顶边偏移加一次；
//                 收起时工具条整项归零，它就等于"标签栏 + 工具行"。
;(function reportTransBarHeight() {
  const bar = document.getElementById('transBar')
  const end = document.getElementById('chromeEnd')
  // 两个上报通道都要在才跑：只 guard 一个、另一个直接调，缺哪个都会在每次
  // ResizeObserver 回调里抛错
  if (!bar || !window.pix) return
  if (typeof window.pix.reportBarHeight !== 'function' || typeof window.pix.reportChromeHeight !== 'function') return
  const rows = bar.querySelector('.trans-bar-rows')
  const grid = bar.querySelector('.trans-grid')
  const root = document.documentElement
  let lastBar = -1
  let lastChrome = -1
  let contentH = 0        // 内容自然高
  let topOffset = 0       // 工具条顶边 = 标签栏 + 工具行的合计高，只在展开态记录
  let chromeFallback = 0

  // 工具条自身占位（不含它上方的标签栏/工具行）= 内容高 + 上下 padding + 下边框。
  //
  // 这两个值从**自定义属性**读，不能读计算样式：padding 和 border 都在做过渡
  // （.trans-bar 过渡 padding .26s、is-collapsed 把 border 归零），冷加载时
  // 计算值是过渡中间值 —— 实测折叠态冷加载读到 padding=1px，于是把 113 当成
  // 展开态占位缓存了下来（应为 129），chrome 随之少 16px。
  // :root 里的变量是规范定义的终值，不参与过渡。
  const pxVar = (name, fallback) => {
    const v = parseFloat(getComputedStyle(root).getPropertyValue(name))
    return Number.isFinite(v) ? v : fallback
  }
  const barFrame = () => {
    const pad = 2 * pxVar('--bar-pad-y', 8)          // 上下各一份
    const border = pxVar('--bar-border-w', 1)
    return pad + border
  }

  // 内容自然高不能读 rows.offsetHeight：折叠时它是被裁剪值、过渡中是插值
  // （实测把过渡中的 1px 当成内容高写进 --bar-rows-h，工具条就此卡死收不回来）。
  //
  // 但也不需要克隆节点去量：grid.scrollHeight 本来就反映内容自然高，父级的
  // overflow:hidden + height:0 只裁剪可见区域，不影响 scrollHeight（实测折叠态
  // 仍稳定返回 112）。此前用克隆（817 个元素、单次 2.4ms）是白白开销 ——
  // push 在折叠动画期间会被 ResizeObserver 调 40 多次，等于每帧浪费 2.4ms。
  const measureContent = () => {
    if (!grid) return 0
    return Math.max(grid.scrollHeight, grid.offsetHeight)
  }

  const measure = () => {
    // 顶边只在展开态记录：折叠时它等于标签栏下沿，不是有效锚点
    if (!bar.classList.contains('is-collapsed')) {
      topOffset = Math.round(bar.getBoundingClientRect().top)
    }
    if (end) chromeFallback = Math.round(end.getBoundingClientRect().bottom)
  }

  const push = () => {
    measure()
    const natural = measureContent()
    if (natural > 0) contentH = natural
    if (contentH > 0) root.style.setProperty('--bar-rows-h', contentH + 'px')

    // chrome = 嵌入视图的起始 y = 顶部 chrome 的总高（标签栏 + 工具行 + 工具条）。
    // 收起时工具条整体消失（0 高、无 padding、无边框），这一项就只剩前面的标签栏
    // 和工具行 —— 也就是 topOffset 本身。
    // 注意别把 topOffset 和工具条高度相加两次：topOffset 已经含了它上方的部分。
    const collapsed = bar.classList.contains('is-collapsed')
    const frameVal = barFrame()
    const barOuter = collapsed ? 0 : contentH + frameVal
    const chrome = topOffset + barOuter
    // 调试用：把内部量到的值挂到 DOM 上，方便用 CDP 核对（不影响布局）
    bar.dataset.metrics = JSON.stringify({ contentH, topOffset, frame: frameVal, barOuter, chrome, collapsed })
    const nextChrome = chrome > 0 ? chrome : chromeFallback
    if (nextChrome > 0 && nextChrome !== lastChrome) {
      lastChrome = nextChrome
      // 工作区是绝对定位的，不跟着 chrome 走就会在工具条变高时被盖住
      root.style.setProperty('--chrome-end', nextChrome + 'px')
      window.pix.reportChromeHeight(nextChrome)
    }

    // 原生视图定位用的工具条高度（主进程在 chrome 值缺失时的回退）
    const value = barOuter > 0 ? barOuter : Math.round(Math.max(bar.offsetHeight, bar.scrollHeight))
    if (value > 0 && value !== lastBar) {
      lastBar = value
      window.pix.reportBarHeight(value)
    }
  }

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(push).observe(bar)
    if (rows) new ResizeObserver(push).observe(rows)
  }
  window.addEventListener('resize', push)
  document.addEventListener('DOMContentLoaded', push)
  // 过渡中途量到的是插值，落定后再补一次
  bar.addEventListener('transitionend', event => {
    if (event.propertyName === 'height') push()
  })
  // 折叠切换必须主动调一次：收起后工具条高度为 0 且内容全被裁掉，
  // 这种不可渲染状态下 ResizeObserver 不会报告尺寸变化（实测完全不触发），
  // 只靠它会让嵌入视图留在原地、空间让不出来。
  window.__syncPixChrome = push
  setTimeout(push, 0)
  setTimeout(push, 300)
})()
