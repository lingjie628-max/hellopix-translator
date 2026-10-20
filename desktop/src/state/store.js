'use strict'

/**
 * 主进程的**运行时状态**。
 *
 * ## 这个文件解决什么问题
 *
 * 原先 main.js 里散着 32 个模块级 `let`（win / tabs / profile / theme …），
 * 160 个函数靠闭包直接读写它们。结果是：
 *
 * - 任何一个函数都可能改任意状态，没有边界，也说不清谁负责什么；
 * - 函数无法独立测试（要么连同整个 main.js 一起跑，要么在 VM 里手拼依赖）；
 * - 拆分时无处下手 —— 状态穿在整个文件里，搬任何东西都得搬一大片。
 *
 * 现在状态集中在 `state` 对象里，按域分组。业务模块通过参数拿到它，
 * 而不是靠闭包共享。这样每个模块的输入是显式的。
 *
 * ## 为什么用 Object.defineProperty 而不是普通字段
 *
 * `tabs` 里有 8 处原地变异（push / splice / sort），如果每次读都返回副本，
 * 那些地方会静默失效 —— 表现为"开窗口没反应"这种极难查的 bug。
 *
 * 所以这里只在**写入**时加钩子（用于持久化、通知），读到的仍是同一份引用。
 * 这是有意的取舍：用可观测的写入换取零拷贝的读取。
 */

/** 新建一份初始状态。每次启动/测试都从这里开始，避免跨用例污染。 */
function createState (seed) {
  const s = Object.assign({
    // ---- 窗口 ----
    win: null,
    tray: null,
    isQuitting: false,
    backgroundRunning: true,
    backgroundTipShown: false,

    // ---- 账号 / 线路 ----
    cookieJar: {},
    apiBase: '',
    profile: null,
    theme: 'light',
    lineId: 'overseas',
    lines: [],

    // ---- 实例（tab） ----
    tabs: [],
    activeId: '',
    showHome: true,
    overlayOpen: false,
    nextTab: 1,
    usedCount: {},

    // ---- 布局测量（渲染层实测值回传） ----
    measuredTransBarHeight: 0,
    hasMeasuredBarHeight: false,
    measuredChromeHeight: 0,
    hasMeasuredChrome: false,

    // ---- 网络 / API ----
    apiNetWarm: false,
    apiAgents: null,
    apiLib: null,
    apiLibTried: false,
    hasPingedOnce: false,

    // ---- 杂项 ----
    clientLog: null,
    instanceSlotHandle: null,
    lastGlobalUnread: -1,
    boundsSaveTimer: null,
    checkingWebApps: false,
    chromeAnim: null
  }, seed || {})

  // 写入钩子：`onChange(key, next, prev)`。持久化与广播挂在上面，
  // 避免每个调用点都得记得"改完要存盘"。
  const listeners = []
  const store = {
    /** 状态本体。业务代码直接读写字段，读到的永远是同一份引用。 */
    data: s,
    /** 注册写入钩子，返回取消函数。 */
    onChange (fn) {
      listeners.push(fn)
      return () => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    /** 是否处于"退出中"（preload/IPC 层大量判断依赖它）。 */
    get quitting () { return s.isQuitting },
    /**
     * 按 id 找实例。
     *
     * tab id 在 tabs 里唯一，且查找频率极高（每个 IPC 都过一遍），
     * 所以放在这里 —— 各业务模块不必各写一份 `tabs.find(...)`。
     */
    tab (id) {
      if (id === undefined || id === null || id === '') return null
      const key = String(id)
      return s.tabs.find(t => String(t.id) === key) || null
    },
    /** 当前活动实例。 */
    active () {
      return store.tab(s.activeId)
    },
    /** 按 webContents 找实例（IPC 校验 sender 时用）。 */
    tabByWc (wc) {
      if (!wc) return null
      return s.tabs.find(t => t.view && t.view.webContents === wc) || null
    }
  }

  for (const key of Object.keys(s)) {
    let value = s[key]
    Object.defineProperty(s, key, {
      enumerable: true,
      configurable: true,
      get () { return value },
      set (next) {
        const prev = value
        // `tabs.push(...)` 这类原地变异不会走 setter（读到的就是同一个数组）；
        // 这里只处理整体替换。相等判断避免无意义的钩子风暴。
        if (next === prev) return
        value = next
        for (const fn of listeners) {
          try { fn(key, next, prev) } catch (e) { /* 钩子不能拖垮业务 */ }
        }
      }
    })
  }

  return store
}

module.exports = { createState }
