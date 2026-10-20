'use strict'

/**
 * 应用级 IPC：平台列表、预设模板、版本与更新检查。
 *
 * ## 预设模板为什么单独强调
 *
 * `app:preset` / `app:savePreset` 读写的是「新增实例时的默认值」。
 * 代理是**实例级**敏感配置，绝不能进这个模板 —— 否则新建实例会
 * 静默继承上一个实例的代理，用户会在别人的出口上聊。这是泄露，
 * 不是显示问题。
 *
 * 读模板时先摘代理再解密：这一步同时**自愈**旧版本已经写进磁盘的
 * 带代理模板，用户不用清配置。
 */

function registerAppIpc (deps) {
  const { reg, actions, env } = deps

  reg.handle('app:platforms', async () => {
    try {
      const data = await actions.api('/client/platforms')
      if (data && data.kicked) actions.sendKicked(data.msg)
    } catch (e) {}
    const rows = actions.platformRows()
    // 延后一拍再检查更新：让这次 IPC 先把列表回给渲染层，
    // 不要因为网络请求把首次渲染拖住。
    setTimeout(() => actions.refreshPlatformUpdates(), 0)
    return { success: true, rows: rows }
  })

  reg.handle('app:updatePlatform', async (event, id) => actions.updatePlatformWeb(id))

  reg.handle('app:preset', (event, id) => {
    const all = actions.readPresets()
    const key = String(id || '')
    const row = all[key]
    if (!row) return { success: true, data: null }
    // 先摘代理字段再解密：模板里本来就不该有代理，摘在前面连 proxyPass
    // 都不会被解密。这一步同时自愈旧版本已经写进磁盘的带代理模板。
    const settings = env.unsealSettings(env.stripProxyFields(row.settings))
    return { success: true, data: Object.assign({}, row, { settings: settings }) }
  })

  reg.handle('app:savePreset', (event, payload) => {
    const id = String((payload && payload.platformId) || '')
    if (!id) return { success: false }
    const all = actions.readPresets()
    // 模板只存"可以跨实例继承的普通偏好"（字体、语言、通道…）。
    // 代理是实例级敏感配置，**不进模板** —— 否则新建实例会继承上一个实例的代理。
    all[id] = {
      name: (payload && payload.name) || '',
      settings: env.sealSettings(env.stripProxyFields((payload && payload.settings) || {}))
    }
    actions.writePresets(all)
    return { success: true }
  })

  reg.handle('app:version', () => env.APP_VERSION)

  reg.handle('app:checkUpdate', async () => {
    const local = env.APP_VERSION
    try {
      const data = await actions.api('/client/update?os=' + process.platform + '&arch=' + process.arch)
      const remote = String((data && (data.version || (data.obj && data.obj.version))) || '')
      const candidate = String((data && (data.url || (data.obj && data.obj.url))) || '')
      // 下载地址必须过信任名单：服务端被劫持时不能把用户引到任意域名
      const url = env.isAllowedExternalUrl(candidate, env.DOWNLOAD_HOSTS) ? candidate : ''
      return { success: true, local: local, remote: remote, url: url }
    } catch (e) {
      return { success: false, local: local, msg: e.message || '无法检查更新' }
    }
  })

  // ---- 客户线索（客页调用，务必放在 handleUnsafe）----
  //
  // platform 与 accountKey **由主进程填入，不接受渲染进程传值** ——
  // 渲染进程在网页上下文里，理论上可被页面脚本影响；由主进程按
  // webContents 反查到可信的 tab 再补上，才能保证"这条线索确实来自那个账号"。

  reg.handleUnsafe('customer:ingest', async (event, payload) => {
    const tab = actions.trustedTabSender(event.sender)
    if (!tab) return { success: false, msg: '标签页未授权' }
    const data = Object.assign({}, payload || {}, {
      platform: tab.platform,
      accountKey: actions.accountSlug()
    })
    // 出向消息的发送方是**本账号**，不是对方。
    // 服务端在缺失时拿 peerKey 兜底 —— 那是"接收"的语义，用在出向上会把
    // 发送方记成客户，于是"我方发了什么"在归档里看起来像"客户发了什么"。
    if (data.direction === 'out' && !data.senderKey) data.senderKey = data.accountKey
    try {
      return await actions.api('/customer/ingest', { method: 'POST', form: data })
    } catch (e) {
      // 采集失败不影响聊天，静默即可 —— 但不能吞掉到连排查线索都没有
      return { success: false, msg: String((e && e.message) || '上报失败') }
    }
  })

  // 撞单提醒查询。客户端每 8 秒的 session 轮询顺带拉一次，
  // 不另开定时器、也不上 WebSocket —— 撞单不是高频交易，
  // "8 秒内知道"和"立刻知道"对结果没有区别。
  reg.handleUnsafe('customer:reminders', async () => {
    try {
      const data = await actions.api('/customer/reminders')
      return data && data.items ? data.items : []
    } catch (e) {
      return []
    }
  })
}

module.exports = { registerAppIpc }
