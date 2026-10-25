'use strict'

/**
 * WebRTC 防泄漏 —— 多开代理场景下最容易被忽略的一条出口。
 *
 * ## 问题
 *
 * 用户给每个窗口挂一条代理，HTTP/WebSocket 流量确实走了代理。但 WebRTC
 * 的 **ICE 收集是另一条通道**：Chromium 直接向 STUN 服务器发 UDP 打洞，
 * 把本机所有网卡的地址写进 candidate：
 *
 *     candidate:... udp ... 192.168.2.1      typ host     ← 内网地址
 *     candidate:... udp ... 203.77.175.145   typ srflx    ← 真实公网出口 IP
 *
 * 网页里几行 JS 就能把 ICE candidate 全抠出来。平台侧只要做这一件事，
 * 十个窗口的代理全部形同虚设 —— 它们背后是同一个真实 IP。
 *
 * ## 已实测（2026-10-25，Electron 33）
 *
 * 不设策略时，一次 ICE 收集拿到 5 条 candidate，其中 2 条内网 + 1 条真实公网。
 * 设成 `disable_non_proxied_udp` 后，同一个页面只剩 mDNS 混淆主机名。
 *
 * ## 为什么不用命令行开关
 *
 * 试过 `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`，
 * **无效**。Electron 33 的二进制里根本没有这个开关（只有
 * `force-webrtc-ip-permission-check` 之类无关的），而 `disable_non_proxied_udp`
 * 只是那个策略的**取值**，不是开关名。用 `strings` 搜到值就以为开关能用，
 * 是个很容易踩的坑 —— 实测确认无效之后才改成下面的 API。
 *
 * ## 也不是 session 的方法
 *
 * 直觉上这是"会话级网络策略"，但 Electron 33 里它挂在 **WebContents** 上
 * （`webContents.setWebRTCIPHandlingPolicy`），`session` 对象上**没有**这个方法 ——
 * 调 `ses.setWebRTCIPHandlingPolicy` 会直接 TypeError（实测）。
 * 所以必须对每个 view 的 webContents 单独设。
 *
 * ## 为什么不干脆把 WebRTC 全关掉
 *
 * WhatsApp Web 的语音 / 视频通话依赖它。`disable_non_proxied_udp` 的语义是
 * **只允许经过代理的 UDP**：有代理时通话照常走隧道，没代理时不发裸 UDP。
 * 这是"功能可用"与"不泄漏"之间唯一正确的取舍点。
 */

/** Chromium 接受的四个取值里，只有这个既保住通话又不泄漏。 */
const POLICY = 'disable_non_proxied_udp'

/**
 * 给一个 webContents 上防泄漏策略。
 *
 * 必须**每个 view 都调**（我们每个窗口一个 WebContentsView），所以它被放进
 * createWebView —— 那是一条所有窗口的必经之路。
 *
 * 幂等、且不抛异常：老版本 Electron 没有这个方法时静默跳过，
 * 但会回一个 false，让调用方能记日志（而不是以为自己已经防住了）。
 *
 * @param {object} wc Electron webContents
 * @returns {boolean} 是否真的设置成功
 */
function applyWebRtcGuard (wc) {
  if (!wc || typeof wc.setWebRTCIPHandlingPolicy !== 'function') return false
  try {
    wc.setWebRTCIPHandlingPolicy(POLICY)
    return true
  } catch (e) {
    return false
  }
}

/**
 * 回读当前策略，仅用于自检 / 测试。
 * @param {object} wc Electron webContents
 * @returns {string} 取不到时返回 ''
 */
function readWebRtcGuard (wc) {
  if (!wc || typeof wc.getWebRTCIPHandlingPolicy !== 'function') return ''
  try {
    return String(wc.getWebRTCIPHandlingPolicy() || '')
  } catch (e) {
    return ''
  }
}

module.exports = { applyWebRtcGuard, readWebRtcGuard, POLICY }
