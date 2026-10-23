'use strict'

/**
 * 页面缩放。
 *
 * ## 为什么单独拆出来
 *
 * 原来这段逻辑内联在 `tab-context-menu.js` 的闭包里，只有右键菜单那一处
 * 能用。但"放大页面"是典型的**双入口**功能：右键菜单里点、以及按
 * Ctrl/Cmd + `=`。两处各写一遍，迟早一边改成 0.2、一边还是 0.1，
 * 用户会发现"右键放大和快捷键放大跳的步长不一样"。
 *
 * ## 钳位
 *
 * 0.5 ~ 2.0 是经验值：0.5 以下 WhatsApp 的侧栏会挤成一坨；
 * 2.0 以上图片消息基本失读（一行只放得下两三个字）。
 *
 * ## 保留两位小数
 *
 * 浮点累加会长出 `1.3000000000000003` 这种东西。setZoomFactor 吃这个值
 * 本身没问题，但界面上显示出来（"当前 130.0000000000002%"）就难看了。
 */

const MIN = 0.5
const MAX = 2.0
const STEP = 0.1

function clamp (value) {
  return Number(Math.min(MAX, Math.max(MIN, value)).toFixed(2))
}

/**
 * 相对缩放。
 * @param {object} webContents 目标 webContents
 * @param {number} delta        增量（0.1 / -0.1），默认一个步长
 */
function changeZoom (webContents, delta) {
  if (!webContents || typeof webContents.getZoomFactor !== 'function') return null
  if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) return null
  const current = Number(webContents.getZoomFactor()) || 1
  const next = clamp(current + (typeof delta === 'number' ? delta : STEP))
  try { webContents.setZoomFactor(next) } catch (e) { return null }
  return next
}

/** 回到 100%。 */
function resetZoom (webContents) {
  if (!webContents || typeof webContents.setZoomFactor !== 'function') return null
  if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) return null
  try { webContents.setZoomFactor(1) } catch (e) { return null }
  return 1
}

module.exports = { changeZoom, resetZoom, clamp, MIN, MAX, STEP }
