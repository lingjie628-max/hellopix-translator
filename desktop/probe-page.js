'use strict'

/**
 * 从 webContents 读回页面纯文本 —— 探测节点/出口 IP 时用。
 *
 * ## 为什么单独成一个模块
 *
 * 产品（main.js 的节点探测）与真机验收脚本（scripts/proxy-mechanism-electron.js）
 * 必须走**同一份**"读页面文本"的实现，否则验收证明不了产品路径。
 * 本模块只要求传入的对象具备 `executeJavaScriptInIsolatedWorld`，
 * 因此不 require electron，可以在纯 Node 里被单元测试覆盖。
 *
 * ## 为什么必须用隔离世界，而不是 page world 的 executeJavaScript
 *
 * 被读取的是**远程页面**（ipify 之类的出口 IP 服务）。在页面自己的 world 里执行
 * 脚本，等于把主进程的代码放进页面脚本能窥探、能篡改的环境里 —— 这正是安全测试
 * 明令禁止的模式（见 test/desktop-security.test.js："remote pages have no
 * page-world IPC bridge or dynamic code injection"）。
 *
 * `executeJavaScriptInIsolatedWorld` 执行在**隔离世界**：与页面脚本的 world
 * 完全分离，页面读不到也改不了；而且这里执行的是一段**写死的常量表达式**，
 * 不接受任何来自页面/网络的数据。读回纯文本用于解析出口 IP，不构成 IPC 桥。
 */

const PROBE_WORLD_ID = 999
const READ_TEXT_SNIPPET = 'document.body ? document.body.innerText : ""'

/**
 * @param {object} webContents Electron webContents（或测试替身）
 * @returns {Promise<string>} 页面纯文本；失败/对象不可用时返回 ''（调用方据此判失败）
 */
function readPageText(webContents) {
  if (!webContents || typeof webContents.executeJavaScriptInIsolatedWorld !== 'function') {
    return Promise.resolve('')
  }
  if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) {
    return Promise.resolve('')
  }
  return Promise.resolve(
    webContents.executeJavaScriptInIsolatedWorld(PROBE_WORLD_ID, [{ code: READ_TEXT_SNIPPET }])
  )
    // 返回形态随 Electron 版本而变：老版本给「每个脚本一个结果的数组」，
    // 新版直接把最后一个脚本的结果给回来。两种都要认，否则会只取到首字符。
    .then(result => {
      const value = Array.isArray(result) ? result[0] : result
      return String(value === undefined || value === null ? '' : value)
    })
    .catch(() => '')
}

module.exports = { readPageText, PROBE_WORLD_ID }
