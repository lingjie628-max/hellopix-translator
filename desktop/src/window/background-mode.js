'use strict'

/**
 * 后台运行（关闭窗口不退出）的决策逻辑。
 *
 * ## 为什么要单独抽出来
 *
 * 「关窗是隐藏还是退出」看着简单，但错一次的代价很大：
 *
 *   - 该隐藏却退出了：用户以为关掉界面翻译就停了，其实他想要的是继续跑
 *   - **该退出却隐藏了：窗口没了、又没有任何入口能把它叫回来，进程变僵尸**
 *
 * 第二种是真事故 —— 用户只能在任务管理器里杀进程，而且他多半不知道
 * 进程还在跑。所以下面每一条判断都偏向"宁可退出，也不要藏得找不回来"。
 */

/**
 * 关闭窗口时是否应当隐藏到托盘（而不是退出）。
 *
 * @param {object} state
 * @param {boolean} state.isQuitting      是否正在真正退出（走的是托盘菜单/系统退出）
 * @param {boolean} state.backgroundEnabled 用户是否开启了后台运行
 * @param {boolean} state.hasTray         托盘是否真的创建成功
 * @returns {boolean} true = 拦截关闭并隐藏；false = 放行，正常退出
 */
function shouldHideOnClose(state) {
  const s = state || {}
  // 已经在退出流程里：必须放行，否则 app.quit() 会被自己拦下来，永远退不掉
  if (s.isQuitting) return false
  if (!s.backgroundEnabled) return false
  // **托盘没建出来就不能藏**。
  // 没有托盘图标 = 用户没有任何入口能把窗口叫回来，
  // 藏起来等于让进程变成杀不掉的僵尸（他在界面上找不到任何痕迹）。
  // 这种情况下宁可老老实实退出。
  if (!s.hasTray) return false
  return true
}

/**
 * 是否要因为"窗口全关了"而退出应用。
 *
 * 先厘清一个容易混的点：**后台运行时窗口只是 hide，并没有 close**，
 * 所以这个钩子正常情况下根本不会触发。它真触发只有两种情形：
 *
 *   1. 用户关掉了后台运行 —— 这时的 close 不再被拦截，窗口真的销毁
 *   2. 窗口被异常销毁（渲染进程崩溃等）
 *
 * 两种情形的正确答案**不一样**：
 *
 *   情形 1 必须退出。用户明确关掉了后台运行，就等于说了"关窗即退出"；
 *          此时若因为"托盘还在"而赖着不走，是**直接违背用户设置**。
 *   情形 2 不该退出。托盘还在，点一下就能把窗口重建出来（见 main.js 的
 *          showMainWindow），退出反而会让翻译静默中断 —— 那更糟。
 */
function shouldQuitOnAllClosed(state) {
  const s = state || {}
  if (s.isQuitting) return true
  // 用户没开后台运行 → 关窗就是退出，不能拿托盘当借口留着
  if (!s.backgroundEnabled) return true
  // 没有托盘就没有"把窗口叫回来"的入口，留着只会变成看不见的僵尸进程
  if (!s.hasTray) return true
  // 后台运行中 + 托盘可用：窗口是被异常带走的，留在托盘里等用户点回来
  return false
}

/** 托盘图标尺寸：Windows 16、macOS 18（Retina 下 Electron 会自动取 2x） */
function trayIconSize(platform) {
  return platform === 'darwin' ? 18 : 16
}

/** 托盘提示文案。带上版本号，用户截图反馈时能直接看出装的哪版。 */
function trayTooltip(version) {
  const v = String(version || '').trim()
  return v ? `Hello Pix ${v}` : 'Hello Pix'
}

module.exports = { shouldHideOnClose, shouldQuitOnAllClosed, trayIconSize, trayTooltip }
