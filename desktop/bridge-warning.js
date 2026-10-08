'use strict'

/**
 * 在 guest 页面里画出「翻译组件未启动」的警告条。
 *
 * ## 为什么需要它
 *
 * 0.1.12 那次 P0 之所以能把客户坑到底，是因为 `guest-inject.js`（preload）在
 * **装载阶段**抛错之后一点痕迹都没有：keydown / click / 扫描监听器全都没挂上，
 * 界面照常可用。用户按回车，中文原文直通 WhatsApp。
 *
 * 问题是这时候 preload 已经死了 —— 不能再靠它注入任何 UI。而主界面的渲染层
 * 是被 `WebContentsView` **盖**在下方的原生视图，渲染层弹窗会被完全挡住。
 * 所以警告只能从主进程注入到 guest 页面本身，出现在**用户正在打字的那个位置**。
 *
 * ## 为什么用隔离世界
 *
 * 注入目标是**远程页面**。在页面自己的 world 里执行脚本，等于把主进程的代码
 * 放进页面脚本能窥探、能篡改的环境 —— 这正是安全测试明令禁止的模式
 * （见 test/desktop-security.test.js："remote pages have no page-world IPC
 * bridge or dynamic code injection"）。`executeJavaScriptInIsolatedWorld`
 * 执行在隔离世界：与页面脚本的 world 完全分离，页面读不到也改不了。
 * 与 probe-page.js 读页面文本走的是同一套机制。
 *
 * 这里执行的同样是一段**构造好的常量表达式**，不接受任何来自页面/网络的数据：
 * 文案里的 name / reason 都由主进程生成并经过 JSON.stringify 转义，不构成注入。
 *
 * ## 一个额外的好处
 *
 * 这段代码不依赖 `MessageParser`、不依赖任何 preload 状态，所以即使
 * preload 崩在最前面也照样能画出来。警告条本身带 `data-pix-ui`，
 * 万一 preload 后来又活了，采集/解析/拦截都会绕开它。
 */

/** 与 probe-page 的 999 分开，避免两段脚本互相影响。 */
const WARN_WORLD_ID = 998
const WARN_ELEMENT_ID = 'pix-bridge-down'

/**
 * @param {object} webContents Electron webContents（或测试替身）
 * @param {{ name?: string, reason?: string }} info
 * @returns {Promise<boolean>} 是否成功注入
 */
function showBridgeWarning(webContents, info) {
  if (!webContents || typeof webContents.executeJavaScriptInIsolatedWorld !== 'function') {
    return Promise.resolve(false)
  }
  if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) {
    return Promise.resolve(false)
  }
  return Promise.resolve(
    webContents.executeJavaScriptInIsolatedWorld(WARN_WORLD_ID, [{ code: buildScript(info) }])
  )
    .then(() => true)
    .catch(() => false)
}

/**
 * 生成注入脚本。导出出来是为了单测能直接检查生成的文案与幂等开关，
 * 而不必去 mock 整个 Electron。
 */
function buildScript(info) {
  const name = JSON.stringify(String((info && info.name) || '此窗口'))
  const why = JSON.stringify(String((info && info.reason) || ''))
  const id = JSON.stringify(WARN_ELEMENT_ID)
  return `(function () {
    try {
      if (window.__pixBridgeWarnShown) return;
      var doc = document;
      if (!doc || !doc.body) return;
      window.__pixBridgeWarnShown = true;
      var old = doc.getElementById(${id});
      if (old && old.parentNode) old.remove();
      var box = doc.createElement('div');
      box.id = ${id};
      // 标记成"我们自己的界面"：任何采集 / 解析 / 发送拦截都必须跳过它。
      box.setAttribute('data-pix-ui', 'bridge-down');
      box.textContent = 'Hello Pix 翻译组件未启动（' + ${name} + '）。'
        + '本次会话中，发送翻译与接收翻译都不会生效 —— '
        + '你按回车后消息可能未经翻译直接发出。请重启 Hello Pix 后重试。'
        + '原因：' + ${why};
      box.style.cssText = [
        'position:fixed','z-index:2147483647','left:50%','top:0',
        'transform:translateX(-50%)','max-width:min(96vw,760px)',
        'padding:10px 16px','box-sizing:border-box','background:#7f1d1d',
        'color:#fff','font-size:13px','line-height:1.55','font-family:inherit',
        'text-align:center','border-radius:0 0 10px 10px',
        'box-shadow:0 8px 24px rgba(0,0,0,.35)'
      ].join(';');
      doc.body.appendChild(box);
    } catch (e) {}
  })()`
}

module.exports = { showBridgeWarning, buildScript, WARN_WORLD_ID, WARN_ELEMENT_ID }
