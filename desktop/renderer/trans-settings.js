/**
 * 翻译设置面板：语种列表、开关回填、保存。
 *
 * ## 这个面板的坑在"两份状态"
 *
 * `current`（账号对象，归 app.js）和面板上的控件是两份数据。`saveTransPrefs`
 * 保存成功后必须把结果**同步写回 `current`** —— 否则 add-app.js 新建实例时
 * 读到的还是登录那一刻的旧值：用户在设置里把"收翻译"关掉了，新建的窗口却
 * 仍然开着收翻译。所以这里坚持"先写 current 再落盘"，而不是等下次拉账号。
 *
 * 反过来，`applyTransPrefs(data)` 必须是纯粹的"用数据填控件"，不能写回
 * `current`。它在 `openTransPanel()` 里被调用两次（打开时、通道列表加载完后），
 * 每次回写都会把用户在两次调用之间动的开关覆盖掉。
 *
 * ## 通道可选性归 trans-bar.js
 *
 * `canSwitchEngine` / `engineRows` / `authoritativeEngine` 由 trans-bar.js 持有
 * （套餐不允自选时服务端会忽略账号里的通道）。本文件只读。
 *
 * ## 加载顺序
 *
 * 用了 add-app.js 的 `engineToShow`，所以必须排在它**之后**。
 * add-app.js 只有声明、没有顶层副作用，这个顺序是安全的。
 *
 * ★ 排在 add-app.js 之后、app.js 之前 ★
 */

function fillLangs() {
  langMine.innerHTML = langOptionHtml(LANGS.filter(l => l.id !== 'auto'))
  langOther.innerHTML = langOptionHtml()
}

/** 用账号数据回填控件。**只读 data，不写 current**（见文件头）。 */
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

/**
 * 打开翻译设置面板。
 *
 * 顺序讲究：先填语种和已存偏好再显示，避免面板"先空一下再填满"的闪动；
 * 通道列表是异步拉的，回来之后要**再 applyTransPrefs 一次**，否则刚拉到的
 * 通道会被 transEngine 的初始值顶掉。
 */
async function openTransPanel() {
  fillLangs()
  applyTransPrefs(current)
  transMsg.textContent = ''
  try {
    const resp = await window.pix.translateEngines()
    const rows = (resp && resp.rows) || []
    transEngine.innerHTML = rows.filter(e => e.allowed !== false).map(e => {
      return '<option value="' + esc(e.id) + '">' + esc(e.name) + '</option>'
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
  // 先本地生效再落盘：存档失败时界面也不该回退成"没改"
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
