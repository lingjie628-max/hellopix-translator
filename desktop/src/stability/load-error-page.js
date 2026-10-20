'use strict'

/**
 * 实例页面加载失败时的**错误页**。
 *
 * ## 为什么必须有它（0.1.31 真机取证）
 *
 * 真机日志（2026-10-16，用户装了 0.1.26、开着 54 个实例）里有持续性网络故障：
 *
 * ```
 *   19:27:48  /client/session  连不上服务器（UND_ERR_CONNECT_TIMEOUT）
 *             attempted addresses: 104.21.6.157:443, timeout: 4000ms
 *   20:26:13  同样超时（这次是 172.67.134.254:443）
 *   18:20 ~ 20:26 共 8 次 NETWORK_TIMEOUT / NETWORK_UNREACHABLE
 * ```
 *
 * 那两个 IP 都是 Cloudflare 的，也就是说**这台机器连我们自己的后端都连不上**。
 * 用户的表现是：「有的窗口直接就是黑的，有的可以打开扫码」——
 * **同一个软件、同一版本、同一时刻，差别只在"那一刻这个实例连没连上"。**
 *
 * ## 缺陷在哪
 *
 * `startTabLoad()` 里只有一句：
 *
 *     tab.view.webContents.loadURL(tab.url)
 *
 * **没有 `.catch()`，也没有 `did-fail-load` 处理。** Chromium 的 `WebContentsView`
 * 在加载失败时不会显示任何东西，用户看到的就是 `createWebView` 里设的那个
 * 背景色 `#081628` —— 一块**看起来像"软件坏了"的深色空白**。
 *
 * 于是「网络不通」被表现成「软件故障」：用户看到一个黑窗口，
 * 既不知道是网络问题、也没有任何办法重试，只能来问客服。
 *
 * ## 本模块的职责
 *
 * 生成一个**能自己重试**的错误页（`data:` URL，无需网络即可渲染）：
 *   · 说清是什么问题（连不上 / 被拒 / 超时 / 域名解析不了）
 *   · 说明**该做什么**（检查网络或代理）
 *   · 给一个「重新加载」按钮 —— 它通过 `location.href` 跳回目标网址，
 *     不依赖任何主进程 IPC（错误页自己就能救自己）
 *
 * 纯字符串拼接，不 require electron —— 见 test/desktop-load-error-page.test.js。
 */

/**
 * Chromium 网络错误码 → 用户能看懂的话。
 *
 * 只翻译**常见且可行动**的那些。其余落到通用文案并附上原始错误码 ——
 * 附码是为了排障：用户截图发来时我们能立刻知道是哪一层出的问题，
 * 而不是只听到"打不开"。
 *
 * 码表见 Chromium 的 `net/base/net_error_list.h`（此处为负值）。
 */
function describeLoadError(code, desc) {
  // 先说"是什么问题 + 该做什么"，两条都要有，缺一条用户就无从下手。
  switch (Number(code)) {
    case -106: // ERR_INTERNET_DISCONNECTED
      return { title: '电脑没有联网', hint: '请检查网络连接（网线 / Wi-Fi）后点下面的按钮重试。' }
    case -105: // ERR_NAME_NOT_RESOLVED
      return { title: '打不开该网站', hint: '域名解析失败，通常是网络或 DNS 问题。请检查网络后重试；如果开了代理，请确认代理可用。' }
    case -102: // ERR_CONNECTION_REFUSED
      return { title: '连不上该网站', hint: '对方拒绝了连接。如果这台应用配了代理，请检查代理设置是否正确。' }
    case -101: // ERR_CONNECTION_RESET
      return { title: '连接被中断', hint: '网络连接被中途切断，通常是网络不稳定或代理故障。请稍后重试。' }
    case -118: // ERR_CONNECTION_TIMED_OUT
    case -7:   // ERR_TIMED_OUT
      return { title: '连接超时', hint: '网络太慢或对方无响应。请检查网络，或换一个更快的代理线路后重试。' }
    case -109: // ERR_ADDRESS_UNREACHABLE
    case -113: // ERR_HOST_UNREACHABLE
      return { title: '网络不可达', hint: '当前网络到不了该地址。如果配了代理，请确认代理节点可用。' }
    case -138: // ERR_NETWORK_ACCESS_DENIED
      return { title: '网络访问被阻止', hint: '可能是防火墙或安全软件拦住了。请检查杀毒软件 / 防火墙设置后重试。' }
    case -130: // ERR_PROXY_CONNECTION_FAILED
      return { title: '代理连不上', hint: '这台应用配置的代理不可用。请到「代理设置」检查地址、端口和账号密码。' }
    case -120: // ERR_SOCKS_CONNECTION_FAILED
    case -121: // ERR_SOCKS_CONNECTION_HOST_UNREACHABLE
      return { title: 'SOCKS5 代理连不上', hint: '代理节点不可用。请到「代理设置」检查节点地址、端口和账号密码，或更换节点。' }
    case -501: // ERR_INSECURE_RESPONSE
    case -200: // ERR_CERT_COMMON_NAME_INVALID
    case -201: // ERR_CERT_DATE_INVALID
      return { title: '网站安全证书有问题', hint: '连接不安全，可能是网络被拦截。请检查网络环境后重试。' }
    case -20:  // ERR_BLOCKED_BY_CLIENT
      return { title: '请求被拦截', hint: '加载被本地策略阻止了。请把应用完全退出后重新打开。' }
    default: {
      const extra = desc ? '（' + String(desc) + '，错误码 ' + code + '）' : '（错误码 ' + code + '）'
      return { title: '页面打不开', hint: '请检查网络连接后重试；如果开了代理，请确认代理可用。' + extra }
    }
  }
}

/** HTML 转义 —— 目标 URL 可能带参数，不能直接塞进模板。 */
function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 生成错误页的 `data:` URL。
 *
 * ## 为什么用 data: URL
 *
 *   1. **不依赖网络** —— 网络正好是坏的，错误页自己再加载不出来就没意义了；
 *   2. **不依赖主进程** —— 用户点「重新加载」走 `location.href`，不需要 IPC。
 *      （主进程若正忙/卡住，走 IPC 的重试按钮会点不动 —— 而卡住恰恰是
 *      这个用户同时遇到的另一个问题。）
 *   3. 分区隔离不受影响：它渲染在同一个 WebContentsView 里。
 *
 * @param {{ code:number, desc?:string, url?:string, platformName?:string }} info
 * @returns {string} data: URL
 */
function buildLoadErrorPage(info) {
  const it = info || {}
  const { title, hint } = describeLoadError(it.code, it.desc)
  const name = String(it.platformName || '').trim()
  const url = String(it.url || '').trim()

  // 目标地址只用于「重新加载」。用 esc 转义后放进 data 属性，
  // 按钮的跳转在脚本里读 dataset —— 不做字符串插值拼 JS，避免引号型注入。
  const body = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + esc(title) + '</title>',
    '<style>',
    // 配色沿用 createWebView 的背景色 #081628，避免失败时闪一下白屏。
    'html,body{margin:0;height:100%;background:#081628;color:#dbe6f2;',
    'font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}',
    '.wrap{height:100%;display:flex;flex-direction:column;align-items:center;',
    'justify-content:center;text-align:center;padding:32px;box-sizing:border-box}',
    '.icon{width:52px;height:52px;border-radius:50%;border:2px solid #3b6ea5;',
    'display:flex;align-items:center;justify-content:center;font-size:24px;color:#7fb2e5;margin-bottom:18px}',
    'h1{font-size:17px;font-weight:600;margin:0 0 10px;color:#eaf2fb}',
    '.who{font-size:12px;color:#7d94ac;margin:0 0 6px}',
    '.hint{max-width:420px;margin:0 0 22px;color:#9db3c9;font-size:13px}',
    'button{min-width:132px;height:36px;border:0;border-radius:8px;cursor:pointer;',
    'background:#2f6fb0;color:#fff;font-size:13px;font-weight:600}',
    'button:hover{background:#3a80c6}',
    'button:disabled{opacity:.5;cursor:default}',
    '.code{margin-top:18px;font-size:11px;color:#5a7288}',
    '</style></head><body><div class="wrap">',
    '<div class="icon">!</div>',
    name ? '<p class="who">' + esc(name) + '</p>' : '',
    '<h1>' + esc(title) + '</h1>',
    '<p class="hint">' + esc(hint) + '</p>',
    url
      ? '<button id="retry" type="button" data-url="' + esc(url) + '">重新加载</button>'
      : '<button id="retry" type="button" disabled>没有可重试的地址</button>',
    '<p class="code">错误码 ' + esc(it.code) + (it.desc ? ' · ' + esc(it.desc) : '') + '</p>',
    '</div>',
    '<script>',
    // 点击 → 直接跳回目标地址。请求失败时 Chromium 会再次触发加载失败，
    // 主进程会把本错误页重新画一次，所以用户不会看到"点了没反应"。
    'var b=document.getElementById("retry");',
    'if(b&&b.dataset.url){b.onclick=function(){b.disabled=true;b.textContent="正在重新加载…";',
    'location.href=b.dataset.url;};}',
    '</script></body></html>'
  ].join('')

  return 'data:text/html;charset=utf-8,' + encodeURIComponent(body)
}

/**
 * 判断一次加载失败是否**值得**显示错误页。
 *
 * `-3`（ERR_ABORTED）必须排除：它是"被新导航取代"或用户主动停止，
 * 属于正常流程 —— 显示错误页会误报（例如页面自身重定向、或用户快速切线路）。
 * 这条规则与 main.js 里既有的 `if (code === -3) return` 保持一致。
 */
function shouldShowErrorPage(code) {
  return Number(code) !== -3
}

module.exports = { describeLoadError, buildLoadErrorPage, shouldShowErrorPage }
