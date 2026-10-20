'use strict'

/**
 * 隐藏窗口（后台保活）的完整操作。
 *
 * ## 语义
 *
 * 窗口从标签栏消失、不再提醒新消息，但网页版会话**完全保留**：
 * 随时点一下就能回来。用户原话是"不掉号、不丢设置、挂着但不占资源"。
 *
 * 实现上最关键的一条：**绝不 destroy webContents**。
 * 网页版的登录态有一部分活在内核内存里，销毁进程 = 必然重新扫码，
 * 那就直接违背了"不掉号"。所以只是从视图树上摘下来 + 静音 + 停未读。
 *
 * ## 资源占用（实测，见 desktop/scripts/bench-hidden-memory.js）
 *
 *   - 内存：每个窗口约 60-70MB，隐藏只省 15MB 左右。
 *     剩下的全是渲染进程本身的开销 —— 这是"不掉号"的代价，省不掉。
 *   - CPU：帧率 60 → 1，且配合 backgroundThrottling 后定时器降 90%。
 *     这部分才是用户能感知到的"不卡了"。
 *
 * 所以不能对用户承诺"隐藏后几乎不占内存"。真实的承诺是：
 * **隐藏后不再抢 CPU/GPU，内存占用不变。**
 *
 * ## 为什么是工厂函数
 *
 * 原先这两个函数直接读 main.js 的模块级 `tabs / activeId / showHome`，
 * 无法独立测试。现在依赖（state + 副作用回调）全部参数化：
 *
 * - 输入是显式的，测试可以直接喂一份 state 跑真身；
 * - main.js 只负责把真实依赖接上，不再持有这段逻辑。
 *
 * 注意 hidden 标记必须落盘（saveOpenApps 会带上），否则重启软件后
 * 隐藏窗口会全部"复活"到标签栏 —— 用户会以为设置丢了。
 */

const hiddenTabs = require('./hidden-tabs')

/**
 * @param {object} deps
 * @param {object} deps.state        形如 { tabs, activeId, showHome }，直接读写
 * @param {(view) => void} deps.detachView
 * @param {() => void} deps.layoutViews
 * @param {() => void} deps.sendTabs
 * @param {() => void} deps.saveOpenApps
 * @param {(y:number) => void} deps.animateChromeTo
 * @param {() => number} deps.chromeOffset
 * @param {(id:string) => object} deps.switchTab
 * @param {(title:string) => number} deps.unreadFromTitle
 */
function createHiddenTabOps (deps) {
  const state = deps.state
  const detachView = deps.detachView
  const layoutViews = deps.layoutViews
  const sendTabs = deps.sendTabs
  const saveOpenApps = deps.saveOpenApps
  const animateChromeTo = deps.animateChromeTo
  const chromeOffset = deps.chromeOffset
  const switchTab = deps.switchTab
  const unreadFromTitle = deps.unreadFromTitle

  /** 从标签栏隐藏。 */
  function hideTab (id) {
    const tab = state.tabs.find(t => t.id === id)
    const verdict = hiddenTabs.canHide(tab, state.tabs.filter(t => !t.hidden).length)
    if (!verdict.ok) return { success: false, msg: verdict.msg }

    const plan = hiddenTabs.hidePlan(tab)
    tab.hidden = true
    // 隐藏前先把未读清零，避免角标停在旧数字上不再更新（看起来像卡死）。
    tab.unread = 0
    plan.forEach(step => {
      try {
        // 节流由创建时的 backgroundThrottling:true 保证，摘掉视图即生效。
        // 这里再兜一次：老版本创建的 view 可能带着 false，能改就改。
        if (step === 'throttle' && typeof tab.view.webContents.setBackgroundThrottling === 'function') {
          tab.view.webContents.setBackgroundThrottling(true)
        }
        if (step === 'detach') detachView(tab.view)
        if (step === 'mute') tab.view.webContents.setAudioMuted(true)
        if (step === 'stopLoading') tab.view.webContents.stop()
      } catch (e) {}
    })

    // 藏掉的正好是当前窗口 → 必须切走，否则界面会停在空视图上。
    if (state.activeId === id) {
      const next = hiddenTabs.nextActiveAfterHide(state.tabs, id)
      if (next) {
        state.activeId = next
        state.showHome = false
      } else {
        state.activeId = ''
        state.showHome = true
      }
    }
    layoutViews()
    sendTabs()
    saveOpenApps()
    return { success: true, msg: '已隐藏，后台继续运行' }
  }

  /**
   * 把隐藏的窗口重新展示出来。
   *
   * 不需要重新加载页面 —— 进程一直活着，直接挂回视图树即可，
   * 用户重新看到的是他离开时那一帧、那些登录状态。
   */
  function showHiddenTab (id) {
    const tab = state.tabs.find(t => t.id === id)
    if (!tab) return { success: false, msg: '窗口不存在' }
    if (!tab.hidden) {
      // 点的是已经在标签栏里的窗口：等价于切换，不能再走一遍 attach。
      return switchTab(id)
    }

    hiddenTabs.showPlan(tab).forEach(step => {
      try {
        if (step === 'clearHidden') tab.hidden = false
        // unmute 必须在清掉 hidden 之后 —— 否则若此时有一条迟到的标题事件，
        // 会被当成"隐藏中"吞掉，导致恢复后首条未读丢失。
        if (step === 'unmute') tab.view.webContents.setAudioMuted(false)
      } catch (e) {}
    })
    // 恢复后刷新一次真实未读：隐藏期间标题数一直在变，我们只是没上报。
    try {
      tab.unread = unreadFromTitle(tab.view.webContents.getTitle())
    } catch (e) {}

    state.activeId = id
    state.showHome = false
    animateChromeTo(chromeOffset())
    sendTabs()
    saveOpenApps()
    return { success: true }
  }

  return { hideTab, showHiddenTab }
}

module.exports = { createHiddenTabOps }
