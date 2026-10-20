'use strict'

/**
 * 渲染层的实例列表载荷。
 *
 * ## 为什么单独成模块
 *
 * 这里的每个字段都对应渲染层的一处展示，少一个或算错一个不会抛错，
 * 只会让界面**静默失准**：
 *
 *   · `hidden` 漏了 → 隐藏的窗口重新出现在标签栏，用户以为设置丢了；
 *   · `bridgeDown` 漏了 → 翻译桥断了但图标看起来一切正常（0.1.12 就那么坑过）；
 *   · `unread` 没看 `tabUnread` 开关 → 用户关掉角标却还在弹数字。
 *
 * 所以把它参数化，直接喂一份假 tabs 就能验。
 */

const { settingOn, groupModeOf } = require('./instance-prefs')

/**
 * @param {object} deps
 * @param {object} deps.state          { tabs, activeId, showHome }
 * @param {() => object} deps.profile  当前账号（可能有 activeEngine）
 * @param {{get: (id:string) => object}} deps.bridgeHealth
 */
function createTabPayload (deps) {
  const state = deps.state
  const profileOf = deps.profileOf || (() => null)
  const bridgeHealth = deps.bridgeHealth

  function tabTransPayload (tab) {
    const s = (tab && tab.settings) || {}
    const profile = profileOf() || {}
    return {
      show: s.showTransBar !== false,
      enableSend: settingOn(s, 'enableSendTranslate'),
      enableRecv: settingOn(s, 'enableRecvTranslate'),
      sendFrom: s.sendFrom || 'auto',
      sendTo: s.sendTo || 'en',
      recvFrom: s.recvFrom || 'auto',
      recvTo: s.recvTo || 'zh',
      server: s.server || '',
      // 不再写死通道名：留空时由渲染进程从后台下发的通道列表里选
      engine: s.engine || profile.activeEngine || '',
      groupMode: groupModeOf(s),
      includeZh: !!(s.includeZh && s.includeZh !== '0'),
      fontSize: Number(s.fontSize) || 15,
      fontColor: s.fontColor || '#22c55e',
      quickReply: !!s.enableQuickReply
    }
  }

  function payload () {
    const tabs = state.tabs || []
    return {
      home: state.showHome || tabs.length === 0,
      activeId: state.activeId,
      rows: tabs.map(t => {
        const bridge = bridgeHealth.get(t.id)
        return {
          id: t.id,
          platform: t.platform,
          name: t.name,
          title: t.title,
          index: t.index,
          icon: t.icon,
          url: t.url || '',
          loading: !!t.loading,
          showTabName: !t.settings || t.settings.showTabName !== false,
          alignRight: !!(t.settings && t.settings.alignRight),
          alwaysStatusBar: !!(t.settings && t.settings.alwaysStatusBar),
          // 翻译桥没起来 = 这个窗口的翻译整体失效。侧边栏必须打标记，
          // 不能让它看起来和正常窗口一样（0.1.12 就是这样静默坑人的）。
          bridgeDown: bridge ? bridge.ok === false : false,
          unread: (t.settings && t.settings.tabUnread === false) ? 0 : (t.unread || 0),
          // 隐藏的窗口仍在 tabs 里（进程活着），但不能出现在标签栏。
          // 渲染层据此分两处展示：可见的进标签栏，隐藏的进"后台运行中"。
          hidden: !!t.hidden,
          trans: tabTransPayload(t)
        }
      })
    }
  }

  return { tabTransPayload, payload }
}

module.exports = { createTabPayload }
