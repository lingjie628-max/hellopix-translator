'use strict'

/**
 * 视图几何与状态判定。
 *
 * ## 抽什么、不抽什么
 *
 * `applyViewBounds` 整段和 Electron 的 `win.contentView` 绑死，硬拆只会把
 * 难度挪个位置。但里面**真正会算错的部分**是纯数据：
 *
 *   · 视图的 y 从哪来（哨兵实测 vs 常量估算）；
 *   · 高度为什么要减 FOOTER_HEIGHT；
 *   · 什么时候所有视图都该摘掉（首页 / 遮罩 / 没有可见实例）。
 *
 * 这些算错了不会抛错，只会表现为"页面被挡住一条""底部被截掉""切换标签后
 * 上一个是空白"—— 真机上极难定位。所以把它们提成纯函数，单独钉住。
 *
 * Electron 那一层（attach / detach / setBounds）仍留在 main.js。
 */

/**
 * 可见实例的视图区域。
 *
 * @param {object} p
 * @param {number} p.y           视图顶边（通常是 chromeOffset()）
 * @param {number} p.x           视图左边（侧面布局时为标签栏宽度，否则 0）
 * @param {number} p.width       窗口内容区宽
 * @param {number} p.height      窗口内容区高
 * @param {number} p.footerHeight 底部状态栏高度（必须从视图高度里扣掉）
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function viewBounds (p) {
  const top = Math.max(0, Math.round(Number(p.y) || 0))
  // 侧面布局：原生视图是盖在渲染层之上的实心方块，左边缘必须让开竖排标签栏，
  // 否则标签栏会被整块盖住 —— 用户点不到，看起来像"标签栏消失了"。
  const left = Math.max(0, Math.round(Number(p.x) || 0))
  const width = Math.max(0, Number(p.width) || 0)
  const height = Math.max(0, Number(p.height) || 0)
  const footer = Math.max(0, Number(p.footerHeight) || 0)
  return {
    x: left,
    y: top,
    width: Math.max(0, width - left),
    // 底部状态栏是窗口 chrome，不属于实例视图；不扣掉就会被实例页面盖住。
    height: Math.max(0, height - top - footer)
  }
}

/**
 * 每个实例应该拿到的处理方式。
 *
 * @param {object} p
 * @param {Array} p.tabs       实例列表
 * @param {string} p.activeId  当前激活实例 id
 * @param {boolean} p.overlayOpen 遮罩是否打开
 * @param {boolean} p.showHome    是否停在首页
 * @returns {{detachAll: boolean, active: object|null, detach: object[]}}
 */
function planLayout (p) {
  const opts = p || {}
  const tabs = opts.tabs || []
  // destroyTab 会先把 tab.view 置空（断开引用让 GC 能收）。关闭标签与重排
  // 是同一个事件循环里的连续动作，中间就会看到已被置空的 tab —— 必须容忍。
  const live = tabs.filter(tab => tab && tab.view)

  if (opts.overlayOpen || opts.showHome || !live.length) {
    return { detachAll: true, active: null, detach: live }
  }

  // 隐藏的窗口绝不能重新挂回视图树：它已经不在标签栏上了，挂回去就会
  // 盖住激活窗口，用户看到的是一块莫名其妙的画面。
  const visible = live.filter(tab => !tab.hidden)
  const active = visible.find(tab => tab.id === opts.activeId) || null
  const detach = live.filter(tab => tab !== active)
  return { detachAll: false, active, detach }
}

/**
 * 视图顶部偏移。
 *
 * 首选渲染层哨兵实测的 chrome 高度：标签栏/工具条/状态栏无论怎么改样式
 * 都自动生效。哨兵还没上报（首帧）才按常量估算。
 *
 * @param {object} p
 * @param {boolean} p.hasMeasuredChrome
 * @param {number} p.measuredChromeHeight
 * @param {boolean} p.wantsTransBar
 * @param {boolean} p.hasMeasuredBarHeight
 * @param {number} p.measuredTransBarHeight
 * @param {number} p.wantsStatus
 * @param {object} p.sizes  { tabs, utility, transBar, status }
 */
function chromeOffset (p) {
  if (p.hasMeasuredChrome) return p.measuredChromeHeight
  const s = p.sizes || {}
  const bar = p.wantsTransBar
    ? (p.hasMeasuredBarHeight ? p.measuredTransBarHeight : (s.transBar || 0))
    : 0
  const status = p.wantsStatus ? (s.status || 0) : 0
  return (s.tabs || 0) + (s.utility || 0) + bar + status
}

/** 缓出曲线：chrome 高度变化时的补间。 */
function easeOutCubic (t) {
  return 1 - Math.pow(1 - t, 3)
}

module.exports = { viewBounds, planLayout, chromeOffset, easeOutCubic }
