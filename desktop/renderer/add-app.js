/**
 * 「新增应用」弹窗：读取平台列表、回填 / 读取表单、版本提示。
 *
 * ## 两个会导致真实损失的历史坑（原样保留在注释里）
 *
 * 1. engineToShow —— 套餐不允许自选通道时，服务端会忽略账号里存的通道，
 *    界面若照样显示旧值，用户就会看到 GPT 却按 DeepSeek 扣费。
 *
 * 2. groupModeUiValue 的缺省值 —— `inherit` 必须显式存过才认。
 *    历史实例的 settings 里没有 groupMode 键，若缺省回落到 inherit，
 *    用户开一次设置面板再保存，就会把实例从"手动"悄悄变成"跟随账号自动"，
 *    账号级开着自动的话就是**预期外的自动扣费**。所以缺省只认 'manual'。
 *
 * ## 依赖
 *
 * addAppItem 被 app.js 里的更新 / 保存按钮处理器引用（都在函数体内），
 * 所以两个文件共享这一个全局变量。其余状态（platformCache 等）是 app.js 维护的。
 *
 * ★ 必须在 app.js 之前加载 ★
 */

function engineToShow(stored) {
  return authoritativeEngine || String(stored || '')
}

/**
 * 三态群组翻译映射到下拉框取值：'inherit' | 'auto' | 'manual'。
 *
 * 注意 `inherit` **必须显式存过**才认。历史实例的 settings 里压根没有
 * `groupMode` 这个键（老版本写死 manual 语义），如果这里回落到 `inherit`，
 * 用户一打开设置面板、一保存，就会把这个实例从"手动"悄悄变成"跟随账号自动"，
 * 账号级开着自动的话就是**预期外的自动扣费**。所以缺省值只认 'manual'。
 */

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
    engine: engineToShow((current && current.activeEngine) || (engineRows[0] && engineRows[0].id)),
    // 新建实例默认「跟随账号」：实例级不表态，交给账号级的 transGroup 决定。
    // 老实现写死 'manual'，导致账号级开了自动、新实例一建出来就静默压成手动。
    groupMode: 'inherit',
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
  addGroupMode.value = groupModeUiValue(settings.groupMode)
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
  // ── 代理：新建实例一律从**直连**开始 ────────────────────────────────
  // 代理是实例级敏感配置，绝不能从任何继承来源带进来。以前这里读的是
  // `settings.proxyType` / `settings.proxyHost` …，而 `settings` 是
  // `Object.assign(defaultAppSettings(), preset.settings)` —— 预设来自
  // `app-presets.json`，于是"上一次给某个实例配过的代理"会被填进这个表单，
  // 新建的实例就带着上一个实例的代理出生了。
  // 现在代理字段只认 `defaultAppSettings()` 里的直连初值：用户真要用代理，
  // 在这个表单里自己填 —— 那才是一次明确的意图表达。
  const direct = defaultAppSettings()
  addProxyType.value = direct.proxyType
  addProxyHost.value = direct.proxyHost
  addProxyPort.value = direct.proxyPort
  addProxyScheme.value = direct.proxyScheme
  addProxyUser.value = direct.proxyUser
  addProxyPass.value = direct.proxyPass
  addProxyChannel.value = direct.proxyChannel
  addProxyIpVer.value = direct.proxyIpVer
  addProxyRefresh.value = direct.proxyRefresh
  addProxyUdp.checked = !!direct.proxyUdp
  geoManual = false
  fillGeoForm(null)
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
    // 套餐锁定时，服务端会用「套餐内第一个已接通通道」；这里若显示账号里存的旧值，
    // 就会建出一个"界面写 GPT、实际走 DeepSeek"的实例（与侧边栏/设置面板同一口径）。
    const engine = engineToShow((current && current.activeEngine) || '')
    if (engine) addEngine.value = engine
    addEngine.disabled = !canSwitchEngine
    addEngine.title = canSwitchEngine ? '' : '当前套餐的翻译通道由系统指定'
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
