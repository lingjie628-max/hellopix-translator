/**
 * 「代理设置」面板：编辑**已存在线路**的代理。
 *
 * ## 这一块为什么能单独成文件
 *
 * 它的语义非常明确：只改**这一条线路自己**的代理 —— 不新建线路、
 * 不新建 partition、不动 usedCount、不换 tab id，所以登录态不受影响。
 * 保存后由主进程 updateTabSettings 立刻把代理写进该线路的 session。
 *
 * ## 与「新增应用」共用同一套解析
 *
 * parseProxyLine（在 pure.js）与 syncProxyFields 的语义等价，只是换了元素。
 * 两个弹窗各写一套解析，迟早会有一边漏掉某种格式。
 *
 * ★ 必须在 app.js 之前加载 ★
 */

function currentProxyPreset() {
  return proxyPresetRows.find(item => item.id === addProxyType.value) || proxyPresetRows[0]
}

function showProxyCell(el, on) {
  if (el) el.style.display = on ? '' : 'none'
}

// ───────────────────────────────────────────────────────────────
// 已存在线路的「代理设置」
//
// 只编辑**这一条线路自己**的代理：不新建线路、不新建 partition、
// 不动 usedCount、不换 tab id —— 因此登录态不受影响。
// 保存后由主进程 updateTabSettings 立刻把代理写进该线路的 session。
// ───────────────────────────────────────────────────────────────

let proxySettingsTabId = ''

function psPresetOf() {
  return proxyPresetRows.find(item => item.id === psProxyType.value) || proxyPresetRows[0] || { id: 'none', kind: 'direct' }
}

/**
 * 类型下拉列出全部预设。
 * 这样线路里已存的任何 proxyType（含各家厂商预设）都能原样回填，
 * 不会因为弹窗不认识它而被悄悄改成直连。
 */
function psFillTypeOptions() {
  if (psProxyType.options.length || !proxyPresetRows.length) return
  psProxyType.innerHTML = proxyPresetRows.map(item => {
    return '<option value="' + esc(item.id) + '">' + esc(item.name) + '</option>'
  }).join('')
}

function psSchemeOptions(preset) {
  const list = (preset && preset.schemes && preset.schemes.length) ? preset.schemes : ['socks5', 'http', 'https']
  psProxyScheme.innerHTML = list.map(item => {
    const label = item === 'socks5' ? 'Socks5' : String(item).toUpperCase()
    // 一律走 esc()：这行原来直接拼 item。现在数据源是主进程内置预设，
    // 不会有恶意值，但"渲染时拼接"这条路上不该有例外 —— 哪天预设改成
    // 服务端可配置，这里就是现成的注入点，而且改动方式看起来会"完全无害"。
    return '<option value="' + esc(item) + '">' + esc(label) + '</option>'
  }).join('')
}

function psApplyHostChoice(preset) {
  const hosts = (preset && preset.hosts) || []
  if (!hosts.length) return
  const selected = hosts.find(item => item.id === psProxyHostSel.value) || hosts[0]
  psProxyHost.value = selected.host
  psProxyPort.value = String(selected.port || preset.defaultPort || '')
  if (selected.scheme && Array.prototype.some.call(psProxyScheme.options, o => o.value === selected.scheme)) {
    psProxyScheme.value = selected.scheme
  }
}

/**
 * 按选中的代理类型显示/隐藏字段，并尽量保留 keep 里的已有配置。
 * 与「新增应用」的 syncProxyFields 是同一套语义，只是换了元素。
 */
function psSyncFields(keep) {
  psFillTypeOptions()
  const preset = psPresetOf()
  const kind = preset.kind || 'direct'
  const on = kind !== 'direct'
  showProxyCell(psProxyHostCell, on)
  showProxyCell(psProxyPortCell, on)
  showProxyCell(psProxySchemeCell, on && kind !== 'ssh')
  showProxyCell(psProxyUserCell, on)
  showProxyCell(psProxyPassCell, on && kind !== 'ssh')
  if (proxySettingsCard) proxySettingsCard.classList.toggle('wide', on)
  psProxyTip.textContent = on ? (preset.tip || '只对这条线路生效，不影响其他线路。') : '直连，不走代理。'
  if (!on) return
  const hosts = preset.hosts || []
  psProxyHostSel.style.display = hosts.length ? '' : 'none'
  if (hosts.length) {
    psProxyHostSel.innerHTML = hosts.map(item => {
      return '<option value="' + esc(item.id) + '">' + esc(item.label || item.host) + '</option>'
    }).join('') + (preset.hostEditable ? '<option value="custom">自定义主机</option>' : '')
    const match = hosts.find(item => item.host === psProxyHost.value.trim())
    psProxyHostSel.value = match ? match.id : (preset.hostEditable ? 'custom' : hosts[0].id)
  }
  psProxyHost.readOnly = !!(hosts.length && psProxyHostSel.value !== 'custom' && !preset.hostEditable && kind !== 'custom')
  if (kind === 'custom' || kind === 'ssh') {
    psProxyHost.readOnly = false
    psProxyHost.placeholder = kind === 'ssh' ? 'ssh.example.com' : '127.0.0.1 或 主机:端口:账号:密码'
  }
  psSchemeOptions(preset)
  const wanted = keep && keep.proxyScheme ? String(keep.proxyScheme) : String(preset.scheme || '')
  if (wanted && Array.prototype.some.call(psProxyScheme.options, o => o.value === wanted)) {
    psProxyScheme.value = wanted
  }
}

/** 打开弹窗并回填这条线路**当前**的代理配置。 */
async function openProxySettings(id) {
  const tabId = String(id || '')
  if (!tabId) return
  proxySettingsTabId = tabId
  psProxyMsg.textContent = ''
  let data = {}
  try {
    const resp = await window.pix.proxySettings(tabId)
    if (resp && resp.success && resp.data) data = resp.data
  } catch (e) {}
  const rows = (window.__lastTabState && window.__lastTabState.rows) || []
  const tab = rows.find(item => item.id === tabId)
  proxySettingsFor.textContent = tab
    ? ('线路：' + (tab.title || tab.name || tabId))
    : ('线路：' + tabId)
  psFillTypeOptions()
  if (psProxyType.options.length) {
    psProxyType.value = data.proxyType || 'none'
    if (!Array.prototype.some.call(psProxyType.options, o => o.value === psProxyType.value)) {
      psProxyType.value = 'none'
    }
  }
  psProxyHost.value = data.proxyHost || ''
  psProxyPort.value = data.proxyPort ? String(data.proxyPort) : ''
  psProxyUser.value = data.proxyUser || ''
  psProxyPass.value = data.proxyPass || ''
  psSyncFields(data)
  const preset = psPresetOf()
  if ((preset.hosts || []).length && !psProxyHost.value.trim() && psProxyHostSel.value !== 'custom') {
    psApplyHostChoice(preset)
  }
  psProxySave.disabled = false
  psProxySave.textContent = '保存'
  showOverlay(proxySettings, true)
}

/** 只读取代理相关字段，绝不顺带写回其他设置。 */
function readProxySettingsForm() {
  const preset = psPresetOf()
  const kind = preset.kind || 'direct'
  if (kind === 'direct') {
    return { proxyType: 'none', proxyScheme: '', proxyHost: '', proxyPort: '', proxyUser: '', proxyPass: '' }
  }
  return {
    proxyType: psProxyType.value || 'none',
    proxyScheme: psProxyScheme.value || preset.scheme || 'socks5',
    proxyHost: psProxyHost.value.trim(),
    proxyPort: psProxyPort.value.trim(),
    proxyUser: psProxyUser.value.trim(),
    proxyPass: psProxyPass.value
  }
}

async function saveProxySettings(patch) {
  if (!proxySettingsTabId) return
  psProxySave.disabled = true
  psProxySave.textContent = '保存中'
  try {
    const resp = await window.pix.updateTabSettings(proxySettingsTabId, patch)
    if (!resp || resp.success === false) throw new Error((resp && resp.msg) || '保存失败')
    showOverlay(proxySettings, false)
  } catch (e) {
    psProxyMsg.textContent = (e && e.message) || '保存失败'
    psProxySave.disabled = false
    psProxySave.textContent = '保存'
  }
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

/**
 * 把「主机:端口:账号:密码」/「账号:密码@主机:端口」整行拆成字段。
 * 「新增应用」和「代理设置」两个弹窗共用同一份解析 —— 不写第二套。
 */

function applyProxyPaste(raw) {
  const parsed = parseProxyLine(raw)
  if (!parsed) return
  if (parsed.host) addProxyHost.value = parsed.host
  if (parsed.port) addProxyPort.value = parsed.port
  if (parsed.user) addProxyUser.value = parsed.user
  if (parsed.pass !== undefined) addProxyPass.value = parsed.pass
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
      const label = item === 'socks5' ? 'Socks5' : String(item).toUpperCase()
      // 同上：拼接一律转义，不留"反正数据可信"的例外。
      return '<option value="' + esc(item) + '">' + esc(label) + '</option>'
    }).join('')
    if (!keepValues) addProxyScheme.value = preset.scheme || preset.schemes[0]
  }
}
