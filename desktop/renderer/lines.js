/**
 * 登录页的线路选择与测速。
 *
 * ## 状态所有权
 *
 * `lineRows` / `preferAuto` / `selectedId` / `fastest` / `speedTimer` 全部由本
 * 模块**独占**。别的模块（add-app.js 建实例时要填线路、app.js 退出登录时要
 * 清状态）只能读、或者调 `resetLines()`，不许自己再声明一份。
 *
 * 之所以强调这点：这几个变量一旦被复制，界面会进入一种很难查的状态 ——
 * 下拉框显示"自动选择"、实际建出来的实例却写死了某条旧线路。两份值各走各的，
 * 编译和单测都不会报错。
 *
 * ## 单线路为什么直接禁用选择器
 *
 * `renderLines()` 里 `lineRows.length === 1` 时会把 `preferAuto` 置 false 并直接
 * 锁定那条线路。这样做是为了跳过一切测速逻辑 —— 只有一个选项时，"自动选择"
 * 既无意义，还会让 `pickLine()` 走 ping 流程，多等一轮网络。
 *
 * ## 暂停规则
 *
 * 测速是个 8s 的 setInterval，只在**登录页可见**时才真正打接口
 * （`startSpeedWatch` 的回调里判断 `loginScreen`）。进到主界面后必须调
 * `stopSpeedWatch()`，否则后台一直每 8 秒 ping 一次，纯浪费流量与电量。
 *
 * ★ 依赖 dom.js / pure.js / ui-kit.js，需排在 app.js 与 add-app.js 之前 ★
 */

let lineRows = []
let preferAuto = true
let selectedId = 'auto'
let fastest = null
let speedTimer = null

/**
 * 某条线路（含特殊的 `'auto'`）是不是当前选中项。
 *
 * 注意 `preferAuto && id === 'auto'`：选"自动"时，具体的 `selectedId` 仍然
 * 可能是上一条手工线路，但界面高亮必须落在"自动选择"上。
 */
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

/** 把当前选择同步到触发器上（下拉收起时显示的那一行）。 */
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

/**
 * 测一遍所有线路。
 *
 * @param {boolean} silent true = 不显示"测速中"，用于 8s 轮询（否则界面每
 *                        8 秒闪一次 pending，反而看不清结果）
 * @returns {Promise<object|null>} 最快的那条
 */
async function pingAll(silent) {
  if (!silent) {
    lineRows.forEach(line => { line.pending = true })
    renderLines()
  }
  const result = await window.pix.pingAll()
  if (result && result.rows) {
    lineRows = result.rows.map(row => Object.assign({}, row, { pending: false }))
  } else {
    // 主进程没给数据（后端挂了 / 桥断）：把 pending 清掉，别让界面永远转圈
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

/**
 * 登录前把选定的线路交给主进程。
 *
 * 选"自动"时用测速结果；还没测过就补测一次。一条都不通就抛错 ——
 * 让调用方（doLogin）显示"线路连不上"，而不是带着空线路去登录，
 * 那会得到一个看起来毫无关联的鉴权失败。
 */
async function pickLine() {
  if (!preferAuto) {
    await window.pix.selectLine(selectedId)
    return
  }
  const best = fastest || await pingAll(true)
  if (!best) throw new Error('线路暂时连不上，请确认后台已启动')
  await window.pix.selectLine(best.id)
}

/**
 * 线路状态归零。退出登录、被踢下线、登录页重新初始化时都必须调。
 *
 * 不做这件事的后果：上一个账号停在"手工指定 A 线路"，换账号后下拉框
 * 还显示 A，新账号也就默默用了 A —— 看起来像"线路选不了"。
 */
function resetLines() {
  preferAuto = true
  selectedId = 'auto'
  fastest = null
}

/** 用服务端下发的线路表替换本地缓存并重绘。传空数组即清空。 */
function setLineRows(rows) {
  lineRows = Array.isArray(rows) ? rows : []
  renderLines()
}

/**
 * 按当前状态重绘（不重新拉数据）。
 *
 * 给外部在"已经调过 resetLines()"之后用 —— resetLines 只改值不重绘，
 * 因为重绘会落到"单线路自动锁定"的分支，把 preferAuto 又推回去。
 */
function refreshLinesView() {
  renderLines()
}
