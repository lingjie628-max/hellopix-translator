'use strict'

/**
 * stability-boot 的**纯逻辑**部分（不 require electron），因此可以用普通 Node 单测。
 *
 * 这里只放三件事：
 *   1. `wrapAttachProcessHandlers(logFile, guard)`
 *      —— 在不改 main.js 的前提下，把 log-file 的「异常就 exit」换成「异常就 relaunch」，
 *         并把致命判定换成更准的那一套。
 *   2. `shouldWatch(wc)` / `labelOf(wc)`
 *      —— 判断一个 webContents 该不该装恢复逻辑，以及日志里怎么称呼它。
 *   3. `buildGiveUpPage(reason)`
 *      —— 熔断之后画的错误页（data: URL，不依赖网络、不依赖仓库里别的模块）。
 */

/**
 * 包住 `log-file.attachProcessHandlers`。
 *
 * ## 为什么要从外面包，而不是改 main.js
 *
 * main.js 的调用是：
 *
 *     logFile.attachProcessHandlers(process, log, {
 *       flush: () => log.flush(),
 *       exit: code => app.exit(code)
 *     })
 *
 * 它写死了两件我们想改的事：致命判定（log-file 内部的白名单）和退出动作（裸 exit）。
 * 但从外面看，这只是一个**普通对象的方法** —— 在 main.js 被 require **之前**
 * 替换掉它，main.js 拿到的就是包装后的版本（CommonJS 模块缓存共享同一个对象）。
 *
 * 好处：**177KB 的 main.js 一个字都不用动**。没有合并冲突、没有误伤面，
 * 升级上游版本时也不会因为 patch 打不上而卡住。
 *
 * ## 幂等
 *
 * 重复调用只包一次（`__pixGuardWrapped` 标记），避免热重启后越包越深。
 *
 * @param {object} logFile  require('./log-file') 的返回值
 * @param {object} guard    createHealthGuard() 的返回值
 * @returns {boolean} 是否处于「已包装」状态
 */
function wrapAttachProcessHandlers(logFile, guard) {
  if (!logFile || typeof logFile.attachProcessHandlers !== 'function') return false
  if (logFile.__pixGuardWrapped) return true

  const original = logFile.attachProcessHandlers
  logFile.attachProcessHandlers = function patchedAttach(proc, logger, options) {
    const opts = Object.assign({}, options || {})
    // 1) 更准的致命判定。注意：只有当 log-file.js 是**打过补丁**的版本时
    //    这个字段才会被读取；旧版会忽略它，退化成原来的白名单（此时仍然
    //    能拿到第 2 点的 relaunch 行为，只是可恢复异常也会触发一次重启）。
    opts.isFatal = error => guard.isFatal(error)
    // 2) 真致命时不「消失」，而是「重启一次」。
    opts.exit = code => guard.hardExit(code)
    return original.call(logFile, proc, logger, opts)
  }
  logFile.__pixGuardWrapped = true
  return true
}

/**
 * 这个 webContents 要不要装恢复逻辑。
 *
 * 跳过三类：
 *   · `remote`     —— DevTools 前端，重载它等于把调试器打断；
 *   · `offscreen`  —— 离屏渲染，没有用户可见的界面；
 *   · 拿不到类型的 —— 保守跳过（宁可漏，不要误伤）。
 */
function shouldWatch(wc) {
  if (!wc || typeof wc.getType !== 'function') return false
  let type = ''
  try { type = String(wc.getType() || '') } catch (e) { return false }
  if (type === 'remote' || type === 'offscreen') return false
  return type === 'window' || type === 'browserView' || type === 'webview'
}

/**
 * 日志里怎么称呼一个 webContents。
 *
 * 用「主机名 + 内部 id」而不是 app 名：崩溃日志里需要一眼看出是
 * WhatsApp、Telegram 还是外壳界面，而内部 id 是唯一能对上 `app.getAppMetrics()` 的键。
 */
function labelOf(wc) {
  let host = ''
  let id = '?'
  try { id = wc.id } catch (e) {}
  try {
    const url = String(wc.getURL() || '')
    if (url && url.indexOf('://') > 0) host = new URL(url).host || ''
  } catch (e) {}
  if (!host) {
    try {
      const url = String(wc.getURL() || '')
      if (url) host = url.slice(0, 24)
    } catch (e) {}
  }
  return (host || 'view') + '#' + id
}

/** 熔断后画的错误页。不联网、不依赖仓库里任何模块，纯字符串。 */
function buildGiveUpPage(options) {
  const o = options || {}
  const title = escapeHtml(o.title || '这个窗口连续崩溃，已停止自动恢复')
  const hint = escapeHtml(o.hint || '请关闭这个窗口后重新打开。如果反复出现，请在「设置 → 打开日志目录」把日志发给客服。')
  const code = escapeHtml(String(o.code || ''))
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title><style>' +
    'html,body{height:100%;margin:0;background:#081628;color:#e5eefc;' +
    'font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}' +
    '.wrap{height:100%;display:flex;align-items:center;justify-content:center;padding:24px}' +
    '.card{max-width:520px;width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);' +
    'border-radius:14px;padding:22px 24px}' +
    'h1{font-size:16px;margin:0 0 10px;font-weight:600}' +
    'p{margin:0 0 8px;color:#9fb3d1}' +
    '.code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#6b7f9c;margin-top:12px;' +
    'word-break:break-all}' +
    'button{margin-top:16px;padding:8px 16px;border-radius:9px;border:0;cursor:pointer;' +
    'background:#22c55e;color:#08130b;font-weight:600;font-size:13px}' +
    'button:active{transform:translateY(1px)}' +
    '</style></head><body><div class="wrap"><div class="card">' +
    '<h1>' + title + '</h1><p>' + hint + '</p>' +
    (code ? '<div class="code">错误码：' + code + '</div>' : '') +
    '<button id="reload">重新加载</button></div></div>' +
    '<script>document.getElementById("reload").addEventListener("click",function(){location.reload()})</script>' +
    '</body></html>'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

module.exports = {
  wrapAttachProcessHandlers,
  shouldWatch,
  labelOf,
  buildGiveUpPage,
  escapeHtml
}
