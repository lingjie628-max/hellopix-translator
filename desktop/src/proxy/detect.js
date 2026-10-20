'use strict'

/**
 * 代理节点检测。
 *
 * ## 这段代码为什么值得单独成文件
 *
 * 它是全仓踩坑最多的一段，每一行注释背后都是一次真机事故。搬出来的时候
 * 一个字没改逻辑，只是把依赖显式化了 —— 因为它现在能单独测了。
 *
 * ## 两个必须保留的核心教训
 *
 * ### 1. 绝对不能在创建窗口之前就赌节点可用
 *
 * 0.1.29 的老实现直接创建隐藏窗口去探测：节点连得上但不回话时，Chromium
 * 一直卡在 SOCKS5 握手，任何 webContents 事件都不触发；15 秒后超时清理会
 * 把渲染进程基础设施弄坏（`MachPortRendezvousServer ... No rendezvous
 * client, terminating process`），之后**整个应用再也起不了窗口** —— 用户看到
 * 的就是"节点检测永远正在检测"。
 *
 * 所以要先用纯 Node 预检，把"根本不回话"的节点挡在 Chromium 之外。
 *
 * ### 2. 但预检**没有否决权**，只有"提前拦截"的权力
 *
 * 0.1.29~0.1.33 把预检做成强制门：CONNECT 拿不到 0x00 就判死、连窗口都不建。
 * 而 0.1.28 的判定是「Chromium 经代理真的打开 api.ipify.org，拿到 IP 才算过」。
 * 同一个节点，后者能过、前者判死 —— 用户看到的就是"以前能检测、修完就再也
 * 检测不过"。
 *
 * 更糟的是 0.1.32 把 0x08 的文案改成了"流量用尽/套餐到期"。RFC1928 原文是
 *   X'08' Address type not supported
 * 意思是**节点处理不了那个地址**，不是"节点坏了"。于是"节点连不上目标网站"
 * 被伪装成"你的节点已失效"，把排查方向整个带偏。
 *
 * ## 现在的规矩
 *
 *   预检**只拦一种情况**：节点根本没回话（TIMEOUT）。
 *   其余一切（CONNECT 被拒、应答码不认识、认证方式奇怪），预检都只是**线索**，
 *   最终结论一律交给"能不能真的经这个节点打开网页"。
 */

/**
 * @param {object} deps
 * @param {object} deps.electron          { BrowserWindow, session }
 * @param {object} deps.maps              { probeWindows, proxyAuthByWebContents }
 * @param {object} deps.libs              预检 / 中继 / 代理规则 / 纯函数
 * @param {object} deps.io                日志与 IP 记录
 * @param {object} deps.env               常量
 */
function createProxyDetect (deps) {
  const { electron, maps, libs, io, env } = deps

  /**
   * 写一条代理日志。
   *
   * ## 这里曾经是个哑炮
   *
   * 原实现直接引用 `log.info(...)`，但 `log` 只存在于 initClientLog()
   * 与 whenReady() 回调的**局部作用域**里 —— 模块作用域根本看不到它。
   * 外面裹着 try/catch + catch(ignore){}，所以不会崩，但**一行日志都没写进去过**。
   *
   * 讽刺的是那段注释正是为了"真机出问题时手上只有一张截图"才加的。
   * 现在改成通过 io.log() 拿模块级的 clientLog。
   */
  function logProxy (msg) {
    try {
      const logger = io.log()
      if (logger) logger.info('proxy', msg)
    } catch (ignore) {}
  }

  /**
   * 用一个**隐藏窗口**经指定 session 打开 url，把页面文本读回来。
   *
   * 这个窗口的存在本身就是风险（见文件头教训 1），所以：
   *   · 只登记到这一个 webContents 上，探测结束即删，不污染任何线路的凭据查找
   *   · 清理必须"先优雅中止、再延迟销毁" —— 卡在握手的渲染进程需要一拍
   *     才能收口，立刻 destroy 正是把应用弄坏的那一下
   */
  function probeTextWithProxy (ses, url, creds) {
    return new Promise((resolve, reject) => {
      let settled = false
      let timer = null
      const win = new electron.BrowserWindow({
        show: false,
        width: 380,
        height: 260,
        webPreferences: {
          session: ses,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false
        }
      })
      maps.probeWindows.add(win)
      const wc = win.webContents
      // 只登记到这一个 webContents 上，探测结束即删 —— 不会污染任何线路的凭据查找。
      if (creds && creds.user) maps.proxyAuthByWebContents.set(wc.id, creds)

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        timer = null
        try { maps.proxyAuthByWebContents.delete(wc.id) } catch (e) {}
        maps.probeWindows.delete(win)
        // 第一步：优雅中止加载，并摘掉监听（此后不再依赖它触发任何事件）。
        try {
          if (!wc.isDestroyed()) {
            wc.removeAllListeners('did-finish-load')
            wc.removeAllListeners('did-fail-load')
            wc.stop()
          }
        } catch (e) {}
        // 第二步：延迟销毁。卡在握手的渲染进程需要一拍才能收口，
        // 立刻 destroy 正是把应用弄坏的那一下。
        const target = win
        const contents = wc
        setTimeout(() => {
          try { if (!contents.isDestroyed()) contents.destroy() } catch (e) {}
          try { if (!target.isDestroyed()) target.destroy() } catch (e) {}
        }, 250)
      }
      const done = (fn, arg) => {
        if (settled) return
        settled = true
        cleanup()
        fn(arg)
      }

      timer = setTimeout(() => done(reject, new Error('连接超时')), env.PROBE_TIMEOUT_MS)
      wc.on('did-finish-load', () => {
        // 隔离世界读取，绝不在远程页面的 page world 里执行脚本（安全测试的硬要求）
        libs.readPageText(wc)
          .then(text => done(resolve, String(text || '')))
          .catch(err => done(reject, err))
      })
      wc.on('did-fail-load', (_e, code, desc) => {
        if (code === -3) return // ERR_ABORTED：重定向/被新导航取代，不是失败
        done(reject, new Error(desc || ('load error ' + code)))
      })
      try { wc.loadURL(url) } catch (e) { done(reject, e) }
    })
  }

  async function detectProxyNode (payload) {
    const settings = payload || {}
    const target = libs.proxyTargetOf(settings)
    if (target.direct || !target.host) return { success: false, msg: '请先填写代理主机和端口' }
    const creds = libs.proxyAuthOf(settings)

    // ★ 第一步：先用**纯 Node** 把节点验一遍，不碰 Chromium ★
    // 目的只有一个 —— 把"根本不回话"的节点挡在创建窗口之前。
    let pre = null
    if (target.scheme === 'socks5') {
      pre = await libs.precheckSocks5({
        host: target.host,
        port: target.port,
        user: target.user,
        pass: target.pass
      })
      // ★ 预检必须落日志 ★
      // 节点检测全程只把结果回给 UI，日志里一个字都没有。于是真机出问题时
      // 我们手上只有一张截图（"节点拒绝"），既不知道死在哪一步、也不知道
      // 每个目标的应答码 —— 只能在本地反复猜，而本地环境与用户环境不同，
      // 猜出来的结论根本对不上。
      // 这里记下每个目标的 code 与耗时，下次用户带上日志就能直接定位。
      // 不记账号密码（logFile 本身就会脱敏，这里也不传）。
      try {
        logProxy('precheck ' + target.host + ':' + target.port +
          ' ok=' + pre.ok + ' code=' + pre.code + ' ms=' + pre.ms)
        for (const t of (pre.tried || [])) {
          logProxy('  target ' + t.host + ':' + t.port + ' -> ' + t.code + ' (' + t.ms + 'ms)')
        }
      } catch (ignore) {}

      // ★ 预检**没有否决权**，只有"提前拦截"的权力 ★（详见文件头教训 2）
      const hardBlock = pre && pre.code === 'TIMEOUT'
      if (hardBlock) {
        return {
          success: false,
          msg: '节点连不上：' + pre.reason,
          code: pre.code,
          tried: pre.tried
        }
      }
      // 预检已经通过（或只是可疑）→ 继续走真实网页探测，由它来定论。
    }

    const ses = electron.session.fromPartition('temp:pix-proxy-detect')
    let relay = null
    try {
      // 带认证的 SOCKS5：临时起一个只服务本次探测的中继，规则里填回环地址。
      let relayEndpoint = ''
      if (target.scheme === 'socks5' && target.hasAuth) {
        relay = libs.createSocksRelay({
          host: target.host,
          port: target.port,
          user: target.user,
          pass: target.pass,
          onError: () => {}
        })
        const info = await relay.start()
        relayEndpoint = '127.0.0.1:' + info.port
      }
      const rules = libs.proxyRulesOf(settings, { relayEndpoint: relayEndpoint })
      if (!rules) return { success: false, msg: '请先填写代理主机和端口' }
      try {
        await ses.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' })
      } catch (e) {
        return { success: false, msg: '代理规则无效' }
      }
      const v4 = settings.proxyIpVer !== 'ipv6'
      const urls = v4
        ? ['https://api.ipify.org?format=json', 'https://ipv4.icanhazip.com']
        : ['https://api64.ipify.org?format=json', 'https://api6.ipify.org?format=json']
      let ip = ''
      let lastErr = ''
      for (let i = 0; i < urls.length; i++) {
        try {
          const text = (await probeTextWithProxy(ses, urls[i], creds)).trim()
          const json = libs.parseJsonSafe(text)
          // 白名单字符：IP 里只可能有 \w . :，防止上游往响应里塞东西
          ip = String((json && json.ip) || text).replace(/[^\w.:]/g, '')
          if (ip) break
        } catch (e) {
          lastErr = e && e.message ? e.message : '连接失败'
        }
      }
      if (!ip) {
        // 结论以"真实加载"为准：走到这里说明 Chromium 经这个节点打不开网页。
        // 预检的应答码只作为**补充线索**附在后面，不冒充原因 ——
        // 否则又会变成"节点连不上目标网站"被说成"你的节点已失效"。
        const hint = pre && !pre.ok ? '（预检线索：' + pre.reason + '）' : ''
        return {
          success: false,
          msg: (lastErr ? ('节点连不上：' + lastErr) : '节点连不上，请检查主机、端口和账密') + hint,
          code: lastErr || '',
          tried: (pre && pre.tried) || []
        }
      }
      const geo = await libs.lookupIpGeo(ip, settings.proxyChannel || 'dbip')
      geo.ip = geo.ip || ip
      const usedAt = io.noteProxyIp(ip)
      return {
        success: true,
        ip: ip,
        geo: geo,
        history: usedAt ? { at: usedAt } : null
      }
    } finally {
      // 探测用的 session 必须清干净：它是共享 partition，
      // 残留的代理规则会影响下一次探测。
      try { await ses.clearStorageData() } catch (ignore) {}
      try { await ses.setProxy({ mode: 'direct' }) } catch (ignore) {}
      if (relay) { try { await relay.close() } catch (ignore) {} }
    }
  }

  return { probeTextWithProxy, detectProxyNode }
}

module.exports = { createProxyDetect }
