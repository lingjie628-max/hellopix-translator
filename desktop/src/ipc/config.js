'use strict'

/**
 * 配置 / 线路 / 站点信息 相关的 IPC。
 *
 * 这一组是纯粹的"读写配置"：不碰窗口、不碰 webContents。
 * 依赖通过 state 和函数注入，模块本身不认识 main.js。
 *
 * ## 为什么要 setter 而不是直接传值
 *
 * `apiBase`、`theme`、`lineId` 都是 main.js 的模块级 `let`。
 * 如果这里拿的是传入时的**快照**，切主题之后 main.js 里那份不会变，
 * 下次 `config:get` 又读回旧值 —— 界面闪回。所以 state 必须带 setter。
 */

/**
 * @param {object} deps
 * @param {object} deps.reg          createIpcRegistrar 的返回值
 * @param {object} deps.state        带 getter/setter 的配置状态
 * @param {object} deps.env          常量与纯函数
 * @param {object} deps.actions      有副作用的能力
 */
function registerConfigIpc (deps) {
  const { reg, state, env, actions } = deps

  reg.handle('config:get', () => ({
    apiBase: state.apiBase,
    theme: state.theme,
    // 后台运行开关：渲染层的「系统操作」菜单要显示当前状态，托盘菜单之外的
    // 第二个入口 —— 不能指望用户去右键托盘图标找设置。
    backgroundRunning: state.backgroundRunning,
    lineId: actions.currentLine().id,
    lines: state.lines
  }))

  // 主题切换：只接受两个合法值，落盘后回执，渲染层据此更新 data-theme
  reg.handle('config:setTheme', (event, value) => {
    const next = value === 'dark' ? 'dark' : 'light'
    state.theme = next
    actions.saveConfig()
    return { success: true, theme: state.theme }
  })

  // 后台运行开关（关闭窗口时隐藏到托盘，而不是退出）。
  // 只接受布尔值语义：任何非 false 的输入都按开启处理，与 loadConfig 的
  // `!== false` 默认值保持一致 —— 免得 renderer 传个 undefined 把开关关掉。
  reg.handle('config:setBackgroundRunning', (event, value) => {
    actions.setBackgroundRunning(value !== false)
    return { success: true, backgroundRunning: state.backgroundRunning }
  })

  reg.handle('config:setApiBase', (event, url) => {
    const nextBase = env.safeApiUrl(url || env.DEFAULT_API)
    if (!nextBase) return { success: false, msg: '线路地址不符合安全策略' }
    state.apiBase = nextBase
    const matched = state.lines.find(l => l.url === state.apiBase)
    if (matched) state.lineId = matched.id
    actions.saveConfig()
    return { apiBase: state.apiBase, lineId: state.lineId }
  })

  reg.handle('lines:list', async () => actions.refreshLines())

  reg.handle('lines:select', (_event, id) => {
    const line = actions.applyLine(id)
    return { success: true, lineId: line.id, apiBase: line.url, line: line }
  })

  reg.handle('lines:ping', async (_event, id) => actions.pingLine(id))
  reg.handle('lines:pingAll', async () => actions.pingAllLines())

  reg.handle('site:info', async () => {
    try {
      // 带上 process.arch，服务端才能给对应架构的安装包。
      // 不带的话 macOS 会固定下发 x64 —— Apple 芯片用户点「苹果电脑版」
      // 拿到的是 Intel 包。
      return await env.fetchFrom(
        state.apiBase,
        '/site/info?arch=' + encodeURIComponent(process.arch),
        2500
      )
    } catch (e) {
      return {}
    }
  })

  reg.handle('shell:open', async (event, url) => {
    const href = String(url || '')
    if (env.isAllowedExternalUrl(href, env.EXTERNAL_HOSTS)) {
      await actions.openExternal(href)
      return { success: true }
    }
    return { success: false, msg: '外部链接不在信任列表' }
  })

  reg.handle('app:proxyPresets', () => ({ success: true, rows: state.proxyPresets }))

  reg.handle('proxy:detect', (event, payload) => actions.detectProxyNode(payload || {}))
}

module.exports = { registerConfigIpc }
