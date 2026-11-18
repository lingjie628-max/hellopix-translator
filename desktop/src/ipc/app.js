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

const { resolveRelease } = require('../update/verify-release')
const { configured: SIGNING_CONFIGURED } = require('../update/trusted-keys')
const { createUpdater } = require('../update/auto-updater')

function registerAppIpc (deps) {
  const { reg, actions, env } = deps

  // 签名公钥没注入时，只有显式关闭才允许降级到白名单模式。
  // 默认严格：没公钥 = 拿不到更新，而不是「谁都能推更新」。
  const allowLegacy = process.env.PIX_ALLOW_UNSIGNED_UPDATE === '1'
  const state = { warnedMissingKey: false }

  /**
   * 应用内更新器。
   *
   * 只在**验签通过**之后才会被喂数据（见下面 app:updateStart 的注释）。
   * 状态通过 `app:update-progress` 推给渲染层。
   */
  const updater = (env.app && env.app.getPath !== undefined)
    ? createUpdater({
      app: env.app,
      emit: payload => { try { actions.sendToMain('app:update-progress', payload) } catch (e) {} },
      log: actions.log || (() => {})
    })
    : null

  // 让 before-quit 能找到清理钩子。
  // 用 global 而不是 import：main.js 已经 require 了这个模块，再导出回去
  // 会形成循环依赖；而清理只是「顺手删两个临时文件」，失败也不影响退出。
  if (updater) {
    global.__pixUpdateCleanup = () => { try { updater.cleanup() } catch (e) {} }
  }

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

  /**
   * 翻译当前可用性。
   *
   * ## 为什么需要这条（2026-11-02 线上事故）
   *
   * 崩溃循环保护会摘掉翻译桥，但界面毫无变化 —— 用户点「译」没反应，
   * 以为软件坏了。实际只要等 5 分钟重启一次。
   *
   * 渲染层挂载时和每次开新实例前都问一次，`limited:true` 就挂横幅。
   * 返回形状由 main.js 的 translateAvailability() 决定，这里只透传。
   */
  reg.handle('app:translateStatus', () => {
    if (typeof actions.translateAvailability === 'function') {
      return actions.translateAvailability()
    }
    // 老版本主进程没有这个能力：直接报正常，别让新渲染层误挂横幅
    return { limited: false }
  })

  /**
   * 用户点「重新开启翻译」。
   *
   * 真正的动作在主进程（清安全模式 + 重建视图让 preload 重新注入），
   * 见 main.js 的 translateRestore。这里只做转发并保证返回形状稳定：
   * 渲染层靠 `ok` 决定按钮是变"已恢复"还是"重试"。
   */
  reg.handle('app:translateRestore', () => {
    if (typeof actions.translateRestore === 'function') {
      return actions.translateRestore()
    }
    return { ok: false, reason: 'unsupported' }
  })

  /**
   * 检查更新。
   *
   * ## 两道防线，顺序不能反
   *
   *   1. **验签**（src/update/verify-release.js）：服务端下发的清单必须带
   *      Ed25519 签名，证明这份清单和里面那个安装包的哈希确实出自我们。
   *      这道防线不依赖服务端健康 —— 服务器被攻破也签不出来。
   *   2. **域名白名单**：签过名也不代表地址可以随便放。签名只管「内容没被改」，
   *      万一哪天发布流程出错把外部域名的包签进去，白名单兜底。
   *
   * 两道都过才把 url 交给渲染层。任何一道不过一律返回空 url ——
   * 空 url 在渲染层显示为「已检测到新版本但不可下载」，不会静默引导用户。
   *
   * ## 返回结构保持不变
   *
   * `{success, local, remote, url, msg}` —— 渲染层（collision-update.js）
   * 依赖这个形状，加字段可以，改形状要同步改前端。这里只加 `signed` 供排查。
   */
  reg.handle('app:checkUpdate', async () => {
    const local = env.APP_VERSION
    try {
      const data = await actions.api('/client/update?os=' + process.platform + '&arch=' + process.arch)

      // 没内置公钥时，严格模式下所有更新都会被拒 —— 这通常是构建时忘了注入，
      // 不是用户的问题。说一次就够了，别每次点「检查更新」都刷同一条日志。
      if (!SIGNING_CONFIGURED && !allowLegacy && !state.warnedMissingKey) {
        state.warnedMissingKey = true
        if (actions.log) actions.log('error', 'update', '客户端未内置更新公钥，所有更新将被拒绝（构建时忘记注入？）')
      }

      const resolved = resolveRelease(data, {
        appId: 'com.hellopix.desktop',
        currentVersion: local,
        channel: 'stable',
        allowLegacy,
        logger: actions.log || (() => {})
      })

      if (resolved.status === 'rejected') {
        // remote 传下去，别清零 —— 见下面白名单那段的长注释，
        // 理由一模一样：有新版但不可下载 ≠ 已是最新。
        return { success: true, local: local, remote: resolved.remote || '', url: '', signed: false, msg: resolved.reason }
      }

      // 下载地址必须过信任名单：服务端被劫持时不能把用户引到任意域名。
      //
      // 只清 url、**保留 remote**：渲染层用 remote > local 判断「有新版本」，
      // 再把 url 缺省当作「已检测到新版本，但安装包尚未发布」。把 remote 也
      // 清掉会让界面显示「当前已是最新版本」，用户以为不用管了 —— 这是误导，
      // 因为他手上确实不是最新版。
      const url = env.isAllowedExternalUrl(resolved.url, env.DOWNLOAD_HOSTS) ? resolved.url : ''

      return {
        success: true,
        local: local,
        remote: resolved.remote,
        url: url,
        sha256: resolved.sha256 || '',
        signed: resolved.status === 'hardened'
      }
    } catch (e) {
      return { success: false, local: local, msg: e.message || '无法检查更新' }
    }
  })

  /**
   * ---- 应用内自动更新 ----
   *
   * ## ★ 为什么这里要重新跑一遍 checkUpdate，而不是接收渲染层传来的 URL ★
   *
   * 渲染层运行在网页上下文里（`sandbox: true` 的 preload + 可能被页面脚本
   * 影响），它传来的任何地址都不能信。如果这里直接拿参数里的 url 去下载，
   * 就等于给网页开了一条「让主进程下载任意文件并执行」的通路 —— 比不做
   * 自动更新危险得多。
   *
   * 所以：**参数一律不用**。这里自己再取一次服务端清单、自己再验一次签名、
   * 自己再过一次域名白名单，和 checkUpdate 走完全相同的判断。多一次网络往返
   * 换一条不可绕过的信任链，非常值。
   *
   * ## 返回
   *
   * 立刻返回 `{ok:true}` 或拒绝原因；进度与结果通过 `app:update-progress`
   * 事件推送（下载可能要几分钟，同步等会卡死界面）。
   */
  reg.handle('app:updateStart', async () => {
    if (!updater) return { ok: false, reason: '当前环境不支持自动更新' }

    const local = env.APP_VERSION
    try {
      const data = await actions.api('/client/update?os=' + process.platform + '&arch=' + process.arch)
      const resolved = resolveRelease(data, {
        appId: 'com.hellopix.desktop',
        currentVersion: local,
        channel: 'stable',
        allowLegacy,
        logger: actions.log || (() => {})
      })
      // 只接受验签通过的清单。legacy / rejected 一律不给自动安装 ----
      // legacy 没有哈希，装上去等于装了一个我们没法校验的包。
      if (resolved.status !== 'hardened') {
        return { ok: false, reason: resolved.reason || '更新清单未通过签名校验，请改用浏览器下载' }
      }
      if (!env.isAllowedExternalUrl(resolved.url, env.DOWNLOAD_HOSTS)) {
        return { ok: false, reason: '更新地址不在信任名单内，请改用浏览器下载' }
      }
      if (resolved.version && env.APP_VERSION &&
          require('../update/signature').compareVersions(resolved.version, local) <= 0) {
        return { ok: false, reason: '当前已是最新版本' }
      }
      const r = await updater.start({
        version: resolved.version,
        url: resolved.url,
        sha256: resolved.sha256
      })
      return { ok: true, version: resolved.version, status: r && r.status }
    } catch (e) {
      return { ok: false, reason: e.message || '无法开始更新' }
    }
  })

  /** 用户点了「重启并安装」。文件必须是本轮下载且校验过的那一个。 */
  reg.handle('app:updateApply', async () => {
    if (!updater) return { ok: false, reason: '当前环境不支持自动更新' }
    return updater.apply()
  })

  /** 取消下载。 */
  reg.handle('app:updateCancel', async () => {
    if (!updater) return { ok: false }
    return { ok: true, status: updater.cancel().status }
  })

  /** 渲染层挂载时拉一次当前状态：可能上次的下载已经完成了。 */
  reg.handle('app:updateState', async () => {
    if (!updater) return { status: 'idle' }
    return updater.state()
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

  // ---- 联系人设备来源（2026-11-11）----
  //
  // 客页（preload）从 DOM 的 data-id 解出「对方最近用什么设备发消息」，
  // 这里只做**校验 + 记日志**，不落库、不上报服务端。
  //
  // 为什么不落库：
  //   · 这是从私有格式推断出来的，WhatsApp 一改版就全错，存下来等于存垃圾；
  //   · 设备类型本身没什么业务价值，不值得为它引入一张表和一个隐私面。
  // 留一条日志是为了真机排障 —— 用户反馈"显示错了"时能看到当时判成什么。
  reg.handleUnsafe('device:peer', async (event, payload) => {
    const tab = actions.trustedTabSender(event.sender)
    if (!tab) return { ok: false, reason: 'untrusted_tab' }
    const device = String((payload && payload.device) || 'unknown')
    // 白名单：不接受任意字符串，避免页面脚本往日志里灌东西。
    // ★ 必须与 device-platform.js 的 DEVICES 完全一致 ★ 漏一个类型会让
    // 这种设备的上报全部被静默拒绝（desktop 曾经就漏在这里）。
    const allowed = { android: 1, iphone: 1, desktop: 1, web: 1, unknown: 1 }
    if (!allowed[device]) return { ok: false, reason: 'bad_device' }
    try {
      if (actions.log) {
        actions.log('info', 'peer-device', 'tab=' + (tab.id || '-') +
          ' platform=' + (tab.platform || '-') + ' device=' + device +
          (Array.isArray(payload && payload.seen) ? ' seen=' + payload.seen.join(',') : ''))
      }
    } catch (e) {}
    return { ok: true }
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
