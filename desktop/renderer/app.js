const loginScreen = document.getElementById('login')
const shellScreen = document.getElementById('shell')
const loginError = document.getElementById('loginError')
const usernameEl = document.getElementById('username')
const passwordEl = document.getElementById('password')
const lineDd = document.getElementById('lineDd')
const lineTrigger = document.getElementById('lineTrigger')
const lineTriggerName = document.getElementById('lineTriggerName')
const lineTriggerMs = document.getElementById('lineTriggerMs')
const lineMenu = document.getElementById('lineMenu')
const loginBtn = document.getElementById('loginBtn')
const rememberPwd = document.getElementById('rememberPwd')
const autoLogin = document.getElementById('autoLogin')
const supportBtn = document.getElementById('supportBtn')
const loginBgVideo = document.getElementById('loginBgVideo')
const homeBgVideo = document.getElementById('homeBgVideo')
const stageEl = document.querySelector('.stage')
const pixFooter = document.getElementById('pixFooter')
const footerVersion = document.getElementById('footerVersion')
const standalonePanel = document.getElementById('standalonePanel')
const standaloneTitle = document.getElementById('standaloneTitle')
const standaloneMsg = document.getElementById('standaloneMsg')
const standaloneList = document.getElementById('standaloneList')
const standaloneClose = document.getElementById('standaloneClose')
const logoutBtn = document.getElementById('logoutBtn')
const tabsEl = document.getElementById('tabs')
const emptyEl = document.getElementById('empty')
const platformGrid = document.getElementById('platformGrid')
const userBox = document.getElementById('userBox')
const appOpsWrap = document.getElementById('appOpsWrap')
const appOpsTrigger = document.getElementById('appOpsTrigger')
const appReloadBtn = document.getElementById('appReloadBtn')
const appUpdateBtn = document.getElementById('appUpdateBtn')
const appClearBtn = document.getElementById('appClearBtn')
const systemOpsWrap = document.getElementById('systemOpsWrap')
const systemOpsTrigger = document.getElementById('systemOpsTrigger')
const systemUpdateBtn = document.getElementById('systemUpdateBtn')
const systemRestartBtn = document.getElementById('systemRestartBtn')
const updatePanel = document.getElementById('updatePanel')
const updateVersionText = document.getElementById('updateVersionText')
const updateDesc = document.getElementById('updateDesc')
const updateLaterBtn = document.getElementById('updateLaterBtn')
const updateDownloadBtn = document.getElementById('updateDownloadBtn')
const profile = document.getElementById('profile')
const profileBody = document.getElementById('profileBody')
const profileClose = document.getElementById('profileClose')
const transBtn = document.getElementById('transBtn')
const transBar = document.getElementById('transBar')
const transBarToggle = document.getElementById('transBarToggle')
const barSendOn = document.getElementById('barSendOn')
const barRecvOn = document.getElementById('barRecvOn')
const barSendFrom = document.getElementById('barSendFrom')
const barSendTo = document.getElementById('barSendTo')
const barRecvFrom = document.getElementById('barRecvFrom')
const barRecvTo = document.getElementById('barRecvTo')
const barGroupMode = document.getElementById('barGroupMode')
const barFontSize = document.getElementById('barFontSize')
const barServer = document.getElementById('barServer')
const barFontColor = document.getElementById('barFontColor')
const barIncludeZh = document.getElementById('barIncludeZh')
const barEngine = document.getElementById('barEngine')
const barQuickReply = document.getElementById('barQuickReply')
const appStatus = document.getElementById('appStatus')
const appStatusText = document.getElementById('appStatusText')
const transPanel = document.getElementById('transPanel')
const transClose = document.getElementById('transClose')
const transRecv = document.getElementById('transRecv')
const transSend = document.getElementById('transSend')
const transGroup = document.getElementById('transGroup')
const includeZh = document.getElementById('includeZh')
const langMine = document.getElementById('langMine')
const langOther = document.getElementById('langOther')
const transEngine = document.getElementById('transEngine')
const transMsg = document.getElementById('transMsg')
const pixContextMenu = document.getElementById('pixContextMenu')
const addApp = document.getElementById('addApp')
const addAppTitle = document.getElementById('addAppTitle')
const addAppX = document.getElementById('addAppX')
const addName = document.getElementById('addName')
const addCustomUrlRow = document.getElementById('addCustomUrlRow')
const addCustomUrl = document.getElementById('addCustomUrl')
const addUpdateBtn = document.getElementById('addUpdateBtn')
const addVer = document.getElementById('addVer')
const addTransOn = document.getElementById('addTransOn')
const addQuickReply = document.getElementById('addQuickReply')
const addCounter = document.getElementById('addCounter')
const addAntiRevoke = document.getElementById('addAntiRevoke')
const addAntiRevokeCell = document.getElementById('addAntiRevokeCell')
const addSendFrom = document.getElementById('addSendFrom')
const addSendTo = document.getElementById('addSendTo')
const addRecvFrom = document.getElementById('addRecvFrom')
const addRecvTo = document.getElementById('addRecvTo')
const addServer = document.getElementById('addServer')
const addEngine = document.getElementById('addEngine')
const addGroupMode = document.getElementById('addGroupMode')
const addIncludeZh = document.getElementById('addIncludeZh')
const addFontSize = document.getElementById('addFontSize')
const addFontColor = document.getElementById('addFontColor')
const addAlignRight = document.getElementById('addAlignRight')
const addMuteAll = document.getElementById('addMuteAll')
const addShowTabName = document.getElementById('addShowTabName')
const addShowNotify = document.getElementById('addShowNotify')
const addStatusBar = document.getElementById('addStatusBar')
const addNoAutoLoad = document.getElementById('addNoAutoLoad')
const addTabUnread = document.getElementById('addTabUnread')
const addGlobalUnread = document.getElementById('addGlobalUnread')
const addProxyType = document.getElementById('addProxyType')
const addProxyHostSel = document.getElementById('addProxyHostSel')
const addProxyHost = document.getElementById('addProxyHost')
const addProxyPort = document.getElementById('addProxyPort')
const addProxyScheme = document.getElementById('addProxyScheme')
const addProxyUser = document.getElementById('addProxyUser')
const addProxyPass = document.getElementById('addProxyPass')
const addProxyTip = document.getElementById('addProxyTip')
const addProxyHostCell = document.getElementById('addProxyHostCell')
const addProxyPortCell = document.getElementById('addProxyPortCell')
const addProxySchemeCell = document.getElementById('addProxySchemeCell')
const addProxyUserCell = document.getElementById('addProxyUserCell')
const addProxyPassCell = document.getElementById('addProxyPassCell')
const addProxyChannel = document.getElementById('addProxyChannel')
const addProxyChannelCell = document.getElementById('addProxyChannelCell')
const addProxyIpVer = document.getElementById('addProxyIpVer')
const addProxyIpVerCell = document.getElementById('addProxyIpVerCell')
const addProxyRefresh = document.getElementById('addProxyRefresh')
const addProxyRefreshCell = document.getElementById('addProxyRefreshCell')
const addProxyUdp = document.getElementById('addProxyUdp')
const addProxyUdpCell = document.getElementById('addProxyUdpCell')
const proxySplit = document.getElementById('proxySplit')
const proxyDetect = document.getElementById('proxyDetect')
const addProxyDetectBtn = document.getElementById('addProxyDetectBtn')
const addProxyCopyBtn = document.getElementById('addProxyCopyBtn')
const addProxyDetectMsg = document.getElementById('addProxyDetectMsg')
const geoIp = document.getElementById('geoIp')
const geoCountry = document.getElementById('geoCountry')
const geoRegion = document.getElementById('geoRegion')
const geoCity = document.getElementById('geoCity')
const geoLoc = document.getElementById('geoLoc')
const geoTz = document.getElementById('geoTz')
const geoZip = document.getElementById('geoZip')
const geoQuality = document.getElementById('geoQuality')
const geoHistory = document.getElementById('geoHistory')
const addCard = document.querySelector('#addApp .add-card')

/**
 * 把异常转成能直接给用户看的一句话。
 *
 * 为什么需要：ipcRenderer.invoke 抛出的错误会被 Electron 包一层，
 * 原样显示出来是
 *   Error invoking remote method 'auth:login': Error: API 线路不符合安全策略
 * 既泄漏内部实现（方法名、错误分层），又不是用户能处理的措辞。
 * 这里剥掉包装，并把几个已知原因换成可执行的提示。
 */
function friendlyError(err, fallback) {
  // 取消息：优先 err.message；字符串直接用。
  // 注意 new Error('') 的 toString 是 "Error"，别把它当成有效消息。
  let msg = ''
  if (err && typeof err.message === 'string') msg = err.message
  else if (typeof err === 'string') msg = err
  else if (err) msg = String(err)
  // 包装可能套多层，循环剥干净
  for (let i = 0; i < 4; i++) {
    const next = msg.replace(/^\s*Error invoking remote method '[^']*':\s*/i, '').replace(/^\s*Error:\s*/i, '')
    if (next === msg) break
    msg = next
  }
  msg = msg.trim()
  if (!msg || /^error$/i.test(msg)) return fallback
  const known = [
    [/不符合安全策略/, '当前线路不可用，请检查网络后重试'],
    [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, '无法解析服务器地址，请检查网络'],
    [/ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|超时/i, '连接服务器超时，请稍后重试'],
    [/fetch failed|NetworkError|network/i, '网络连接失败，请检查网络']
  ]
  for (const [re, text] of known) if (re.test(msg)) return text
  return msg
}

let proxyPresetRows = []
let proxyDetectTimer = 0
let geoManual = false
const addCancel = document.getElementById('addCancel')
const addConfirm = document.getElementById('addConfirm')
const enabledList = document.getElementById('enabledList')
const enabledMeta = document.getElementById('enabledMeta')
const clearEnabled = document.getElementById('clearEnabled')
const dndBtn = document.getElementById('dndBtn')
const dndText = document.getElementById('dndText')
const lockBtn = document.getElementById('lockBtn')
const lockScreen = document.getElementById('lockScreen')
const lockPwd = document.getElementById('lockPwd')
const lockError = document.getElementById('lockError')
const unlockBtn = document.getElementById('unlockBtn')

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

function speedText(line) {
  if (line.pending) return '测速中'
  if (line.ok === false) return '超时'
  if (line.ms == null) return '--'
  return line.ms + 'ms'
}

function speedClass(line) {
  if (line.ok === false) return 'ms bad'
  if (line.ms == null || line.pending) return 'ms'
  if (line.ms > 300) return 'ms bad'
  if (line.ms > 120) return 'ms slow'
  return 'ms'
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
  return !profile.classList.contains('hidden') || !transPanel.classList.contains('hidden') || !lockScreen.classList.contains('hidden') || !addApp.classList.contains('hidden') || !updatePanel.classList.contains('hidden') || !standalonePanel.classList.contains('hidden')
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

function cmpVer(a, b) {
  const pa = String(a || '0').split(/[^\d]+/).map(n => parseInt(n, 10) || 0)
  const pb = String(b || '0').split(/[^\d]+/).map(n => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
  }
  return 0
}

let pendingUpdateUrl = ''

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

function esc(text) {
  return String(text || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]))
}

let platformCache = []

function appIcon(id, icon) {
  return 'icons/' + encodeURIComponent(icon || id) + '.svg'
}

function iconTag(id, cls, icon) {
  return '<img class="' + (cls || '') + '" src="' + appIcon(id, icon) + '" alt="" draggable="false">'
}

async function openApp(id) {
  await window.pix.open({ platformId: id, multi: true })
}

// 语言选项：常用语种置顶，其余按代码字母序跟在后面。
// LANGS 本身是按语言代码排的（aa 阿法尔语、ace 亚齐语…），直接用会让最常用的
// 中文落到第 186 位、俄语第 136 位 —— 用户每选一次都要滚过上百个冷门语种。
// 这里只改**展示顺序**，不动 LANGS 数据本身。
const LANG_PRIORITY = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt', 'it', 'ar', 'th', 'vi', 'id', 'hi']
function langDisplayName(l) {
  if (l.id === 'auto') return '自动识别'
  if (l.id === 'zh') return '简体中文'
  return l.name
}
function orderedLangs(rows) {
  const rank = new Map(LANG_PRIORITY.map((id, i) => [id, i]))
  return rows.slice().sort((a, b) => {
    // 'auto'（自动识别）永远置顶：它是发/收翻译的默认值，排到中间会让
    // 用户以为默认值变了
    if (a.id === 'auto' || b.id === 'auto') return a.id === 'auto' ? -1 : 1
    const ra = rank.has(a.id) ? rank.get(a.id) : Infinity
    const rb = rank.has(b.id) ? rank.get(b.id) : Infinity
    return ra - rb
  })
}
function langOptionHtml(rows) {
  const list = orderedLangs(rows || LANGS)
  // 常用语种与其余部分之间插一条分隔线：让"下面还有一长串"这件事可见。
  // 用空值 + disabled，避免它被当成可选项选中。
  const topCount = list.filter(l => l.id === 'auto' || LANG_PRIORITY.includes(l.id)).length
  return list
    .map((l, i) => '<option value="' + l.id + '">' + langDisplayName(l) + '</option>' +
      (i === topCount - 1 ? '<option value="" disabled>──────────</option>' : ''))
    .join('')
}

function defaultAppSettings() {
  return {
    enableTranslate: true,
    enableSendTranslate: true,
    enableRecvTranslate: true,
    showTransBar: true,
    enableQuickReply: false,
    enableCounter: false,
    sendFrom: 'auto',
    sendTo: 'en',
    recvFrom: 'auto',
    recvTo: 'zh',
    server: selectedId === 'auto' ? (fastest && fastest.id) || '' : selectedId,
    engine: (current && current.activeEngine) || (engineRows[0] && engineRows[0].id) || '',
    groupMode: 'manual',
    includeZh: false,
    fontSize: 15,
    fontColor: '#22c55e',
    alignRight: false,
    muteAll: false,
    showTabName: true,
    showNotify: true,
    alwaysStatusBar: false,
    disableAutoLoad: false,
    tabUnread: true,
    globalUnread: true,
    antiRevoke: false,
    proxyType: 'none',
    proxyHost: '',
    proxyPort: '',
    proxyScheme: '',
    proxyUser: '',
    proxyPass: '',
    proxyNode: '',
    proxyChannel: 'dbip',
    proxyIpVer: 'ipv4',
    proxyRefresh: '',
    proxyUdp: false,
    proxyGeo: null
  }
}

function paintAddVersion(item) {
  if (!item || item.badge === false) {
    addVer.classList.add('hidden')
    addUpdateBtn.style.display = 'none'
    return
  }
  addUpdateBtn.style.display = ''
  addUpdateBtn.disabled = false
  addUpdateBtn.textContent = '点击更新'
  const localVer = item.localVer || ''
  const remoteVer = item.remoteVer || ''
  if (!localVer && !remoteVer) {
    addVer.classList.add('hidden')
    return
  }
  addVer.classList.remove('hidden')
  if (item.hasUpdate && remoteVer) {
    addVer.textContent = '版本号:[' + localVer + '] 有新版本可更新,版本号:[' + remoteVer + ']'
  } else {
    addVer.textContent = '版本号:[' + (localVer || remoteVer) + ']'
  }
}

function fillAddForm(item, preset) {
  const settings = Object.assign(defaultAppSettings(), (preset && preset.settings) || {})
  addAppTitle.textContent = '新增 ' + item.name
  addConfirm.textContent = '新增 ' + item.name
  addName.value = (preset && preset.name) || item.name
  addCustomUrlRow.classList.toggle('hidden', !item.customUrl)
  addCustomUrl.value = settings.customUrl || item.url || ''
  addTransOn.checked = settings.enableTranslate !== false
  addQuickReply.checked = !!settings.enableQuickReply
  addCounter.checked = !!settings.enableCounter
  const isWaPro = item.id === 'whatsapp-pro'
  addAntiRevokeCell.classList.toggle('hidden', !isWaPro)
  addAntiRevoke.checked = isWaPro && settings.antiRevoke !== false
  addSendFrom.innerHTML = langOptionHtml()
  addSendTo.innerHTML = langOptionHtml()
  addRecvFrom.innerHTML = langOptionHtml()
  addRecvTo.innerHTML = langOptionHtml()
  addSendFrom.value = settings.sendFrom || 'auto'
  addSendTo.value = settings.sendTo || 'en'
  addRecvFrom.value = settings.recvFrom || 'auto'
  addRecvTo.value = settings.recvTo || 'zh'
  addServer.innerHTML = (lineRows.length ? lineRows : [{ id: 'cn', name: '默认线路' }]).map(l => {
    return '<option value="' + esc(l.id) + '">' + esc(l.name) + '</option>'
  }).join('')
  if (settings.server) addServer.value = settings.server
  addGroupMode.value = settings.groupMode === 'auto' ? 'auto' : 'manual'
  addIncludeZh.value = (settings.includeZh === true || settings.includeZh === 1 || settings.includeZh === 'true') ? 'true' : 'false'
  addFontSize.innerHTML = [
    [11, '小号字体'],
    [12, '12号字体'],
    [14, '中号字体'],
    [15, '15号字体'],
    [16, '16号字体'],
    [18, '大号字体'],
    [20, '20号字体'],
    [22, '特大字体'],
    [30, '极大字体']
  ].map(item => {
    return '<option value="' + item[0] + '">' + item[1] + '</option>'
  }).join('')
  addFontSize.value = String(settings.fontSize || 15)
  addFontColor.value = settings.fontColor || '#22c55e'
  addAlignRight.checked = !!settings.alignRight
  addMuteAll.checked = !!settings.muteAll
  addShowTabName.checked = settings.showTabName !== false
  addShowNotify.checked = settings.showNotify !== false
  addStatusBar.checked = settings.alwaysStatusBar !== false
  addNoAutoLoad.checked = !!settings.disableAutoLoad
  addTabUnread.checked = settings.tabUnread !== false
  addGlobalUnread.checked = settings.globalUnread !== false
  addProxyType.value = settings.proxyType || 'none'
  addProxyHost.value = settings.proxyHost || settings.proxyNode || ''
  addProxyPort.value = settings.proxyPort || ''
  addProxyScheme.value = settings.proxyScheme || 'socks5'
  addProxyUser.value = settings.proxyUser || ''
  addProxyPass.value = settings.proxyPass || ''
  addProxyChannel.value = settings.proxyChannel || 'dbip'
  addProxyIpVer.value = settings.proxyIpVer || 'ipv4'
  addProxyRefresh.value = settings.proxyRefresh || ''
  addProxyUdp.checked = !!settings.proxyUdp
  geoManual = !!(settings.proxyGeo && settings.proxyGeo.manual)
  fillGeoForm(settings.proxyGeo || null)
  if (settings.proxyNode && !settings.proxyHost) applyProxyPaste(settings.proxyNode)
  syncProxyFields(true)
  paintAddVersion(item)
}

function readAddSettings() {
  return {
    enableTranslate: addTransOn.checked,
    enableSendTranslate: addTransOn.checked,
    enableRecvTranslate: addTransOn.checked,
    showTransBar: true,
    enableQuickReply: addQuickReply.checked,
    enableCounter: addCounter.checked,
    customUrl: addCustomUrl.value.trim(),
    antiRevoke: !addAntiRevokeCell.classList.contains('hidden') && addAntiRevoke.checked,
    sendFrom: addSendFrom.value,
    sendTo: addSendTo.value,
    recvFrom: addRecvFrom.value,
    recvTo: addRecvTo.value,
    server: addServer.value,
    engine: addEngine.value,
    groupMode: addGroupMode.value,
    includeZh: addIncludeZh.value === 'true',
    fontSize: Number(addFontSize.value) || 15,
    fontColor: addFontColor.value,
    alignRight: addAlignRight.checked,
    muteAll: addMuteAll.checked,
    showTabName: addShowTabName.checked,
    showNotify: addShowNotify.checked,
    alwaysStatusBar: addStatusBar.checked,
    disableAutoLoad: addNoAutoLoad.checked,
    tabUnread: addTabUnread.checked,
    globalUnread: addGlobalUnread.checked,
    proxyType: addProxyType.value || 'none',
    proxyHost: addProxyHost.value.trim(),
    proxyPort: addProxyPort.value.trim(),
    proxyScheme: addProxyScheme.value,
    proxyUser: addProxyUser.value.trim(),
    proxyPass: addProxyPass.value,
    proxyChannel: addProxyChannel.value || 'dbip',
    proxyIpVer: addProxyIpVer.value || 'ipv4',
    proxyRefresh: addProxyRefresh.value.trim(),
    proxyUdp: addProxyUdp.checked,
    proxyGeo: readGeoForm()
  }
}

function currentProxyPreset() {
  return proxyPresetRows.find(item => item.id === addProxyType.value) || proxyPresetRows[0]
}

function showProxyCell(el, on) {
  if (el) el.style.display = on ? '' : 'none'
}

function fillGeoForm(geo) {
  const row = geo || {}
  geoIp.value = row.ip || ''
  geoCountry.value = row.country || ''
  geoRegion.value = row.region || ''
  geoCity.value = row.city || ''
  geoLoc.value = row.loc || ''
  geoTz.value = row.timezone || ''
  geoZip.value = row.zip || ''
  const ip = geoIp.value.trim()
  if (ip) {
    geoQuality.classList.remove('hidden')
    geoQuality.href = 'https://scamalytics.com/ip/' + encodeURIComponent(ip)
  } else {
    geoQuality.classList.add('hidden')
  }
  geoHistory.classList.add('hidden')
  geoHistory.textContent = ''
}

function readGeoForm() {
  const ip = geoIp.value.trim()
  if (!ip && !geoCountry.value.trim()) return null
  return {
    ip: ip,
    country: geoCountry.value.trim(),
    region: geoRegion.value.trim(),
    city: geoCity.value.trim(),
    loc: geoLoc.value.trim(),
    timezone: geoTz.value.trim(),
    zip: geoZip.value.trim(),
    manual: geoManual
  }
}

function setDetectMsg(text, kind) {
  addProxyDetectMsg.textContent = text || ''
  addProxyDetectMsg.className = 'proxy-detect-msg' + (kind ? ' ' + kind : '')
}

function formatProxyTime(at) {
  const d = new Date(Number(at) || 0)
  if (!d.getTime()) return ''
  const pad = n => (n < 10 ? '0' : '') + n
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}

async function runProxyDetect() {
  const preset = currentProxyPreset()
  if (!preset || preset.kind === 'direct') return
  if (!addProxyHost.value.trim()) {
    setDetectMsg('请先填写代理主机', 'err')
    return
  }
  addProxyDetectBtn.disabled = true
  setDetectMsg('正在检测节点…')
  try {
    const resp = await window.pix.detectProxy(readAddSettings())
    if (!resp || !resp.success) {
      setDetectMsg((resp && resp.msg) || '检测失败', 'err')
      return
    }
    geoManual = false
    fillGeoForm(resp.geo)
    setDetectMsg('检测成功，国家不对可直接改右边的字段。', 'ok')
    if (resp.history && resp.history.at) {
      geoHistory.classList.remove('hidden')
      geoHistory.textContent = '检测到该 IP 最近在本软件使用过：' + formatProxyTime(resp.history.at)
    }
  } catch (e) {
    setDetectMsg('检测失败，请检查节点是否可用', 'err')
  } finally {
    addProxyDetectBtn.disabled = false
  }
}

function scheduleProxyDetect() {
  clearTimeout(proxyDetectTimer)
  const preset = currentProxyPreset()
  if (!preset || preset.kind === 'direct' || !addProxyHost.value.trim()) return
  proxyDetectTimer = setTimeout(() => { runProxyDetect() }, 700)
}

function applyHostChoice(preset, keepValues) {
  const hosts = preset && preset.hosts ? preset.hosts : []
  const selected = hosts.find(item => item.id === addProxyHostSel.value) || hosts[0]
  if (!selected) return
  if (!keepValues || !addProxyHost.value.trim()) addProxyHost.value = selected.host
  if (!keepValues || !addProxyPort.value.trim()) addProxyPort.value = String(selected.port || preset.defaultPort || '')
  if (selected.scheme) addProxyScheme.value = selected.scheme
}

function applyProxyPaste(raw) {
  const text = String(raw || '').trim().replace(/^(socks5h?|https?):\/\//i, '')
  if (!text) return
  const at = text.lastIndexOf('@')
  if (at > 0) {
    const auth = text.slice(0, at)
    const hostPort = text.slice(at + 1)
    const colon = auth.indexOf(':')
    const hp = hostPort.split(':')
    addProxyUser.value = colon >= 0 ? auth.slice(0, colon) : auth
    addProxyPass.value = colon >= 0 ? auth.slice(colon + 1) : ''
    addProxyHost.value = hp[0] || ''
    if (hp[1]) addProxyPort.value = hp[1]
    return
  }
  const parts = text.split(':')
  if (parts.length >= 4) {
    addProxyHost.value = parts[0]
    addProxyPort.value = parts[1]
    addProxyUser.value = parts[2]
    addProxyPass.value = parts.slice(3).join(':')
    return
  }
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    addProxyHost.value = parts[0]
    addProxyPort.value = parts[1]
    return
  }
  addProxyHost.value = text
}

function syncProxyFields(keepValues) {
  if (!addProxyType.options.length && proxyPresetRows.length) {
    addProxyType.innerHTML = proxyPresetRows.map(item => {
      return '<option value="' + esc(item.id) + '">' + esc(item.name) + '</option>'
    }).join('')
  }
  const preset = currentProxyPreset()
  const kind = (preset && preset.kind) || 'direct'
  const on = kind !== 'direct'
  showProxyCell(addProxyHostCell, on)
  showProxyCell(addProxyPortCell, on)
  showProxyCell(addProxySchemeCell, on && kind !== 'ssh')
  showProxyCell(addProxyUserCell, on)
  showProxyCell(addProxyPassCell, on && kind !== 'ssh')
  showProxyCell(addProxyChannelCell, on)
  showProxyCell(addProxyIpVerCell, on)
  showProxyCell(addProxyRefreshCell, on)
  showProxyCell(addProxyUdpCell, on)
  if (proxySplit) proxySplit.classList.toggle('with-detect', on)
  if (proxyDetect) proxyDetect.style.display = on ? '' : 'none'
  if (addCard) addCard.classList.toggle('wide', on)
  addProxyTip.textContent = on ? (preset.tip || '每个应用单独生效，不和其他窗口共用。') : '直连，不走代理。'
  if (!on) return
  const hosts = preset.hosts || []
  addProxyHostSel.style.display = hosts.length ? '' : 'none'
  if (hosts.length) {
    addProxyHostSel.innerHTML = hosts.map(item => {
      return '<option value="' + esc(item.id) + '">' + esc(item.label || item.host) + '</option>'
    }).join('') + (preset.hostEditable ? '<option value="custom">自定义主机</option>' : '')
    if (!keepValues) {
      addProxyHostSel.value = hosts[0].id
      applyHostChoice(preset, false)
    } else {
      const match = hosts.find(item => item.host === addProxyHost.value)
      addProxyHostSel.value = match ? match.id : (preset.hostEditable ? 'custom' : hosts[0].id)
    }
  }
  addProxyHost.readOnly = !!(hosts.length && addProxyHostSel.value !== 'custom' && !preset.hostEditable && kind !== 'custom')
  if (kind === 'custom' || kind === 'ssh') {
    addProxyHost.readOnly = false
    addProxyHost.placeholder = kind === 'ssh' ? 'ssh.example.com' : '127.0.0.1 或 主机:端口:账号:密码'
    if (!keepValues && !addProxyPort.value) addProxyPort.value = String(preset.defaultPort || '')
  }
  if (preset.schemes && preset.schemes.length) {
    addProxyScheme.innerHTML = preset.schemes.map(item => {
      const label = item === 'socks5' ? 'Socks5' : item.toUpperCase()
      return '<option value="' + item + '">' + label + '</option>'
    }).join('')
    if (!keepValues) addProxyScheme.value = preset.scheme || preset.schemes[0]
  }
}

let addAppItem = null

async function openAddApp(item) {
  if (!item) return
  addAppItem = item
  fillAddForm(item, null)
  try {
    const preset = await window.pix.preset(item.id)
    if (preset && preset.data) fillAddForm(item, preset.data)
  } catch (e) {}
  // 兜底取当前可用通道的第一项，不写死通道名
  addEngine.innerHTML = engineRows.length
    ? '<option value="' + esc(engineRows[0].id) + '">' + esc(engineRows[0].name) + '</option>'
    : '<option value="">无可用通道</option>'
  try {
    const resp = await window.pix.translateEngines()
    const rows = ((resp && resp.rows) || []).filter(e => e.allowed !== false)
    if (rows.length) {
      addEngine.innerHTML = rows.map(e => '<option value="' + esc(e.id) + '">' + esc(e.name) + '</option>').join('')
    }
    const engine = (current && current.activeEngine) || ''
    if (engine) addEngine.value = engine
  } catch (e) {}
  const latest = platformCache.find(row => row.id === item.id)
  if (latest) paintAddVersion(latest)
  showOverlay(addApp, true)
  addName.focus()
  addName.select()
}

function fillAppLists(rows) {
  platformCache = rows || []
  platformGrid.innerHTML = ''
  platformCache.forEach(item => {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'app-card'
    const showBadge = item.badge !== false && item.hasUpdate
    const badge = showBadge ? '<i class="app-badge" title="该软件网页版有更新">可更新</i>' : ''
    card.innerHTML =
      '<span class="dot">' + iconTag(item.id, '', item.icon) + badge + '</span>' +
      '<span class="name">' + esc(item.name) + '</span>'
    card.onclick = () => openAddApp(item)
    platformGrid.appendChild(card)
  })
  if (addAppItem) {
    const latest = platformCache.find(row => row.id === addAppItem.id)
    if (latest && !addApp.classList.contains('hidden')) paintAddVersion(latest)
  }
}

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
  const list = lastTabs
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

let transBarInited = false
let transBarSilent = false
let transBarTabId = ''
let engineRows = []
// 套餐是否允许商户自己换通道（基础版为 false）。服务端另有强制，这里只负责不误导用户
let canSwitchEngine = true

function barLangOptions() {
  return langOptionHtml()
}

function ensureTransBarOptions() {
  if (!transBarInited) {
    barSendFrom.innerHTML = barLangOptions()
    barSendTo.innerHTML = barLangOptions()
    barRecvFrom.innerHTML = barLangOptions()
    barRecvTo.innerHTML = barLangOptions()
    barFontSize.innerHTML = [
      [11, '小号字体'],
      [12, '12号字体'],
      [14, '中号字体'],
      [15, '15号字体'],
      [16, '16号字体'],
      [18, '大号字体'],
      [20, '20号字体'],
      [22, '特大字体'],
      [30, '极大字体']
    ].map(item => '<option value="' + item[0] + '">' + item[1] + '</option>').join('')
    transBarInited = true
  }
  barServer.innerHTML = (lineRows.length ? lineRows : [{ id: 'cn', name: '默认线路' }]).map(l => {
    return '<option value="' + esc(l.id) + '">' + esc(l.name) + '</option>'
  }).join('')
  // 没有可用通道就给空选项，不假装有个默认通道
  const engines = engineRows.length ? engineRows : [{ id: '', name: '无可用通道' }]
  barEngine.innerHTML = engines.map(e => '<option value="' + esc(e.id) + '">' + esc(e.name) + '</option>').join('')
    // 套餐固定通道时禁用下拉：能点却点了没效果，比直接禁用更让人困惑
    barEngine.disabled = !canSwitchEngine
    barEngine.title = canSwitchEngine ? '' : '当前套餐的翻译通道由系统指定'
}

let transBarPainted = false

function transBarIsOpen() {
  return !!(transBar && !transBar.classList.contains('is-collapsed'))
}

function setTransBarOpen(open, instant) {
  if (!transBar) return
  transBar.classList.remove('hidden')
  const already = transBarIsOpen()
  if (already === !!open && transBarPainted) return
  if (instant || !transBarPainted) {
    transBar.classList.add('no-anim')
    transBar.classList.toggle('is-collapsed', !open)
    void transBar.offsetHeight
    transBar.classList.remove('no-anim')
    transBarPainted = true
    // 立即上报新的占位高度，嵌入式原生视图才能跟着一起让出/收回空间
    if (typeof window.__syncPixChrome === 'function') window.__syncPixChrome()
    return
  }
  if (open) {
    transBar.classList.add('is-collapsed')
    void transBar.offsetHeight
    transBar.classList.remove('is-collapsed')
  } else {
    transBar.classList.add('is-collapsed')
  }
  transBarPainted = true
  // 报的是目标态（收起=归零），主进程自己会做缓动动画
  if (typeof window.__syncPixChrome === 'function') window.__syncPixChrome()
}

function paintTransBar(state, home, rows) {
  const tab = (rows || []).find(item => item.id === state.activeId)
  const trans = (tab && tab.trans) || {}
  const open = !home && !!tab && trans.show !== false
  setTransBarOpen(open, !transBarPainted)
  if (transBarToggle) {
    transBarToggle.classList.toggle('hidden', home || !tab)
    transBarToggle.classList.toggle('on', open)
    transBarToggle.textContent = open ? '收起翻译设置' : '打开翻译设置'
  }
  if (!tab) {
    transBarTabId = ''
    return
  }
  ensureTransBarOptions()
  transBarSilent = true
  transBarTabId = tab.id
  barSendOn.checked = trans.enableSend !== false
  barRecvOn.checked = trans.enableRecv !== false
  barSendFrom.value = trans.sendFrom || 'auto'
  barSendTo.value = trans.sendTo || 'en'
  barRecvFrom.value = trans.recvFrom || 'auto'
  barRecvTo.value = trans.recvTo || 'zh'
  barGroupMode.value = trans.groupMode === 'auto' ? 'auto' : 'manual'
  barFontSize.value = String(trans.fontSize || 15)
  if (trans.server) barServer.value = trans.server
  barFontColor.value = trans.fontColor || '#22c55e'
  barIncludeZh.checked = !!trans.includeZh
  if (trans.engine) barEngine.value = trans.engine
  barQuickReply.checked = !!trans.quickReply
  transBarSilent = false
}

function readTransBarSettings() {
  return {
    enableSendTranslate: barSendOn.checked,
    enableRecvTranslate: barRecvOn.checked,
    enableTranslate: barSendOn.checked || barRecvOn.checked,
    sendFrom: barSendFrom.value,
    sendTo: barSendTo.value,
    recvFrom: barRecvFrom.value,
    recvTo: barRecvTo.value,
    groupMode: barGroupMode.value,
    fontSize: Number(barFontSize.value) || 15,
    server: barServer.value,
    fontColor: barFontColor.value,
    includeZh: barIncludeZh.checked,
    engine: barEngine.value,
    enableQuickReply: barQuickReply.checked
  }
}

async function saveTransBar(patch) {
  if (transBarSilent || !transBarTabId) return
  try {
    await window.pix.updateTabSettings(transBarTabId, patch || readTransBarSettings())
  } catch (e) {}
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
  const span = el.querySelector('.tab-name')
  if (!span || editingTabId) return
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

function makeTabEl(tab, active) {
  const el = document.createElement('div')
  el.className = 'tab' + (active ? ' active' : '')
  const name = tabLabel(tab)
  el.innerHTML = iconTag(tab.platform, 'tab-icon', tab.icon) +
    (name ? '<span class="tab-name" title="' + esc(name) + '">' + esc(name) + '</span>' : '') +
    '<span class="x" title="关闭">×</span>'
  el.onclick = () => window.pix.switchTab(tab.id)
  el.oncontextmenu = event => showPixContextMenu(event, tab)
  const nameEl = el.querySelector('.tab-name')
  if (nameEl) {
    nameEl.ondblclick = event => {
      event.preventDefault()
      event.stopPropagation()
      startTabRename(tab, el)
    }
  }
  el.querySelector('.x').onclick = (event) => {
    event.stopPropagation()
    window.pix.close(tab.id)
  }
  return el
}

function renderTabs(state) {
  window.__lastTabState = state
  const rows = (state && state.rows) || []
  const home = !rows.length || !!(state && state.home)
  if (editingTabId && tabsEl.querySelector('.tab-name-input')) {
    show(emptyEl, home)
    paintStatus(state, home, rows)
    paintTransBar(state, home, rows)
    paintOperationMenus(home, rows)
    fillEnabled(rows)
    syncHomeVideo(home)
    return
  }
  tabsEl.innerHTML = ''
  const homeTab = document.createElement('div')
  homeTab.className = 'tab tab-home' + (home ? ' active' : '')
  homeTab.innerHTML = '<img class="tab-home-logo" src="icon.png" alt=""><span class="tab-name">主页</span>'
  homeTab.onclick = () => window.pix.home()
  homeTab.oncontextmenu = event => showPixContextMenu(event, null)
  tabsEl.appendChild(homeTab)
  const left = rows.filter(tab => !tab.alignRight)
  const right = rows.filter(tab => tab.alignRight)
  left.forEach(tab => tabsEl.appendChild(makeTabEl(tab, !home && tab.id === state.activeId)))
  if (right.length) {
    const spacer = document.createElement('div')
    spacer.className = 'tab-spacer'
    tabsEl.appendChild(spacer)
    right.forEach(tab => tabsEl.appendChild(makeTabEl(tab, !home && tab.id === state.activeId)))
  }
  show(emptyEl, home)
  paintStatus(state, home, rows)
  paintTransBar(state, home, rows)
  paintOperationMenus(home, rows)
  fillEnabled(rows)
  Object.keys(checkedIds).forEach(id => {
    if (!rows.find(tab => tab.id === id)) delete checkedIds[id]
  })
  syncHomeVideo(home)
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
  } catch (e) {
    engineRows = []
  }
  renderTabs(await window.pix.tabs())
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(async () => {
    const resp = await window.pix.session()
    if (resp && resp.kicked) return
    if (resp && resp.obj) setProfile(resp.obj)
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
const toolbarLogo = document.querySelector('.toolbar-logo')
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
const themeBtn = document.getElementById('themeBtn')
const themeIco = document.getElementById('themeIco')
const themeText = document.getElementById('themeText')

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
clearEnabled.onclick = () => {
  const selected = lastTabs.filter(tab => checkedIds[tab.id]).map(tab => tab.id)
  const ids = selected.length ? selected : lastTabs.map(tab => tab.id)
  ids.forEach(id => window.pix.close(id))
  checkedIds = {}
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
const LANGS = [
  { id: 'auto', name: '自动检测' },
  { id: 'aa', name: '阿法尔语' }, { id: 'ace', name: '亚齐语' }, { id: 'af', name: '南非荷兰语' }, { id: 'ak', name: '阿肯语' }, { id: 'am', name: '阿姆哈拉语' }, { id: 'ar', name: '阿拉伯语' },
  { id: 'as', name: '阿萨姆语' }, { id: 'ay', name: '艾马拉语' }, { id: 'az', name: '阿塞拜疆语' }, { id: 'bal', name: '俾路支语' }, { id: 'ban', name: '巴厘语' }, { id: 'bcl', name: '比科尔语' },
  { id: 'be', name: '白俄罗斯语' }, { id: 'ber', name: '柏柏尔语' }, { id: 'bg', name: '保加利亚语' }, { id: 'bi', name: '比斯拉马语' }, { id: 'bjn', name: '班贾尔语' }, { id: 'bm', name: '班巴拉语' },
  { id: 'bn', name: '孟加拉语' }, { id: 'bo', name: '藏语' }, { id: 'brx', name: '博多语' }, { id: 'bs', name: '波斯尼亚语' }, { id: 'bug', name: '布吉语' }, { id: 'ca', name: '加泰罗尼亚语' },
  { id: 'ce', name: '车臣语' }, { id: 'ceb', name: '宿务语' }, { id: 'ch', name: '查莫罗语' }, { id: 'ckb', name: '中库尔德语' }, { id: 'crs', name: '塞舌尔克里奥尔语' }, { id: 'cs', name: '捷克语' },
  { id: 'cy', name: '威尔士语' }, { id: 'da', name: '丹麦语' }, { id: 'de', name: '德语' }, { id: 'doi', name: '多格拉语' }, { id: 'dv', name: '迪维希语' }, { id: 'dz', name: '宗喀语' },
  { id: 'ee', name: '埃维语' }, { id: 'el', name: '希腊语' }, { id: 'en', name: '英语' }, { id: 'es', name: '西班牙语' }, { id: 'et', name: '爱沙尼亚语' }, { id: 'eu', name: '巴斯克语' },
  { id: 'fa', name: '波斯语' }, { id: 'ff', name: '富拉语' }, { id: 'fi', name: '芬兰语' }, { id: 'fil', name: '菲律宾语' }, { id: 'fj', name: '斐济语' }, { id: 'fo', name: '法罗语' },
  { id: 'fr', name: '法语' }, { id: 'fy', name: '西弗里西语' }, { id: 'ga', name: '爱尔兰语' }, { id: 'gd', name: '苏格兰盖尔语' }, { id: 'gil', name: '基里巴斯语' }, { id: 'gl', name: '加利西亚语' },
  { id: 'gn', name: '瓜拉尼语' }, { id: 'gu', name: '古吉拉特语' }, { id: 'ha', name: '豪萨语' }, { id: 'haw', name: '夏威夷语' }, { id: 'he', name: '希伯来语' }, { id: 'hi', name: '印地语' },
  { id: 'hil', name: '希利盖农语' }, { id: 'hr', name: '克罗地亚语' }, { id: 'ht', name: '海地克里奥尔语' }, { id: 'hu', name: '匈牙利语' }, { id: 'hy', name: '亚美尼亚语' }, { id: 'id', name: '印尼语' },
  { id: 'ig', name: '伊博语' }, { id: 'ilo', name: '伊洛卡诺语' }, { id: 'is', name: '冰岛语' }, { id: 'it', name: '意大利语' }, { id: 'iu', name: '因纽特语' }, { id: 'ja', name: '日语' },
  { id: 'jam', name: '牙买加克里奥尔语' }, { id: 'jv', name: '爪哇语' }, { id: 'ka', name: '格鲁吉亚语' }, { id: 'kab', name: '卡拜尔语' }, { id: 'kg', name: '刚果语' }, { id: 'khq', name: '科伊拉奇尼语' },
  { id: 'kk', name: '哈萨克语' }, { id: 'kl', name: '格陵兰语' }, { id: 'km', name: '高棉语' }, { id: 'kn', name: '卡纳达语' }, { id: 'ko', name: '韩语' }, { id: 'kok', name: '孔卡尼语' },
  { id: 'ks', name: '克什米尔语' }, { id: 'ku', name: '库尔德语' }, { id: 'ky', name: '吉尔吉斯语' }, { id: 'lb', name: '卢森堡语' }, { id: 'lg', name: '卢干达语' }, { id: 'ln', name: '林加拉语' },
  { id: 'lo', name: '老挝语' }, { id: 'lt', name: '立陶宛语' }, { id: 'lu', name: '卢巴语' }, { id: 'lv', name: '拉脱维亚语' }, { id: 'mad', name: '马都拉语' }, { id: 'mai', name: '迈蒂利语' },
  { id: 'mfe', name: '毛里求斯克里奥尔语' }, { id: 'mg', name: '马尔加什语' }, { id: 'mh', name: '马绍尔语' }, { id: 'mi', name: '毛利语' }, { id: 'min', name: '米南加保语' }, { id: 'mk', name: '马其顿语' },
  { id: 'ml', name: '马拉雅拉姆语' }, { id: 'mn', name: '蒙古语' }, { id: 'mni', name: '曼尼普尔语' }, { id: 'mr', name: '马拉地语' }, { id: 'mrj', name: '西马里语' }, { id: 'ms', name: '马来语' },
  { id: 'mt', name: '马耳他语' }, { id: 'my', name: '缅甸语' }, { id: 'mzn', name: '马赞德兰语' }, { id: 'na', name: '瑙鲁语' }, { id: 'ne', name: '尼泊尔语' }, { id: 'nl', name: '荷兰语' },
  { id: 'no', name: '挪威语' }, { id: 'nqo', name: '恩科语' }, { id: 'nr', name: '南恩德贝莱语' }, { id: 'nso', name: '北索托语' }, { id: 'ny', name: '齐切瓦语' }, { id: 'om', name: '奥罗莫语' },
  { id: 'or', name: '奥里亚语' }, { id: 'os', name: '奥塞梯语' }, { id: 'pa', name: '旁遮普语' }, { id: 'pag', name: '邦阿西楠语' }, { id: 'pap', name: '帕皮阿门托语' }, { id: 'pau', name: '帕劳语' },
  { id: 'pl', name: '波兰语' }, { id: 'prs', name: '达里语' }, { id: 'ps', name: '普什图语' }, { id: 'pt', name: '葡萄牙语' }, { id: 'qu', name: '克丘亚语' }, { id: 'rm', name: '罗曼什语' },
  { id: 'rn', name: '基隆迪语' }, { id: 'ro', name: '罗马尼亚语' }, { id: 'ru', name: '俄语' }, { id: 'rw', name: '卢旺达语' }, { id: 'sa', name: '梵语' }, { id: 'sat', name: '桑塔利语' },
  { id: 'sd', name: '信德语' }, { id: 'ses', name: '科伊拉博罗语' }, { id: 'sg', name: '桑戈语' }, { id: 'shi', name: '希尔哈语' }, { id: 'si', name: '僧伽罗语' }, { id: 'sk', name: '斯洛伐克语' },
  { id: 'sl', name: '斯洛文尼亚语' }, { id: 'sm', name: '萨摩亚语' }, { id: 'sn', name: '绍纳语' }, { id: 'so', name: '索马里语' }, { id: 'sq', name: '阿尔巴尼亚语' }, { id: 'sr', name: '塞尔维亚语' },
  { id: 'srn', name: '苏里南语' }, { id: 'ss', name: '斯瓦蒂语' }, { id: 'st', name: '塞索托语' }, { id: 'su', name: '巽他语' }, { id: 'sun', name: '巽他语' }, { id: 'sv', name: '瑞典语' },
  { id: 'sw', name: '斯瓦希里语' }, { id: 'ta', name: '泰米尔语' }, { id: 'te', name: '泰卢固语' }, { id: 'tet', name: '德顿语' }, { id: 'tg', name: '塔吉克语' }, { id: 'th', name: '泰语' },
  { id: 'ti', name: '提格里尼亚语' }, { id: 'tk', name: '土库曼语' }, { id: 'tn', name: '茨瓦纳语' }, { id: 'to', name: '汤加语' }, { id: 'tr', name: '土耳其语' }, { id: 'ts', name: '聪加语' },
  { id: 'tvl', name: '图瓦卢语' }, { id: 'tw', name: '契维语' }, { id: 'ty', name: '塔希提语' }, { id: 'tzm', name: '中阿特拉斯柏柏尔语' }, { id: 'ug', name: '维吾尔语' }, { id: 'uk', name: '乌克兰语' },
  { id: 'ur', name: '乌尔都语' }, { id: 'uz', name: '乌兹别克语' }, { id: 've', name: '文达语' }, { id: 'vi', name: '越南语' }, { id: 'wa', name: '瓦隆语' }, { id: 'war', name: '瓦瑞语' },
  { id: 'wo', name: '沃洛夫语' }, { id: 'xh', name: '科萨语' }, { id: 'yi', name: '意第绪语' }, { id: 'yo', name: '约鲁巴语' }, { id: 'zh', name: '中文' }, { id: 'zh-TW', name: '繁体中文' },
  { id: 'zu', name: '祖鲁语' }
]

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
  if (data.activeEngine) transEngine.value = data.activeEngine
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
    if (command === 'account') userBox.click()
    if (command === 'softwareUpdate') systemUpdateBtn.click()
  })
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
