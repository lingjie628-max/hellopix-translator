'use strict'

/**
 * 注入到客页的三段代码 —— 内容在这里，落盘/URL 在 page-world-inject.js。
 *
 * ## 为什么必须注入页面世界
 *
 * 客页是 `sandbox: true` + `contextIsolation: true`：
 *   · preload 读不到本地文件（只能向主进程要）；
 *   · 页面世界看不到 preload 变量；
 *   · 两个世界之间只有 window 属性和 DOM 互通。
 *
 * 而「翻译图片」的按钮必须在页面世界：隔离世界创建的 DOM 虽然能被看见、
 * `elementFromPoint` 也命中，但挂在上面的 click 回调收不到真实鼠标事件
 * （隔离世界的事件派发是独立的一套）。用户看到的现象就是"按钮在，点了没用"。
 *
 * ## 三段各干什么
 *
 *   patch.js  在宿主任何脚本之前跑：独占 JSON、挪走宿主 CSP。
 *   main.js   我们的宿主脚本（当前只有「翻译图片」按钮）。
 *   guard.js  宿主反注入（注入后立刻删掉所有 script）的自愈。
 *
 * ⚠️ 这些片段整体放在**单引号常量**里，再由 page-world-inject 用数组 join
 * 拼接。不要改成模板字符串 —— 片段内部有反引号和 `${}`，会互相打架。
 */

/**
 * 页面的隔离世界替身。
 *
 * 规则：**这个文件里的每一行都会在别人家的页面里、以页面身份执行**。
 * 所以任何一步出错都只能说"自己坏了"，绝不能把宿主搞崩 ——
 * 下面每个 hook 都包了 try/catch。
 */
const PATCH_BODY = `
(function () {
  'use strict'

  // ---- 1. JSON：独占，防止宿主 hook 它来偷看我们的翻译内容 ----
  //
  // 语义必须与原生完全一致，否则宿主解析消息会出错（那是线上事故级别）。
  // 原生 JSON.stringify 只有一个参数时对字符串返回带引号的字符串，
  // 这一点原样保留，不做那种"结果再 stringify 一次"的递归 ——
  // 那种写法会变成 "\\"abc\\""，宿主一看就不对劲。
  var nativeStringify = JSON.stringify
  var nativeParse = JSON.parse
  if (typeof nativeStringify === 'function' && typeof nativeParse === 'function') {
    var safeStringify = function () {
      try {
        return nativeStringify.apply(JSON, arguments)
      } catch (e) {
        throw e
      }
    }
    var safeParse = function () {
      try {
        return nativeParse.apply(JSON, arguments)
      } catch (e) {
        throw e
      }
    }
    safeStringify.toString = function () { return nativeStringify.toString() }
    safeParse.toString = function () { return nativeParse.toString() }
    JSON.stringify = safeStringify
    JSON.parse = safeParse
  }

  // ---- 2. 宿主 CSP：把后来插入的 meta CSP 删掉 ----
  //
  // 宿主若在运行时动态插 <meta http-equiv="Content-Security-Policy">，
  // 会禁掉我们的内联样式/脚本，翻译面板画不出来。
  // 注意：已经在响应头里下发的 CSP 无法在页面里撤销（那是规范），
  // 但我们自己不用 eval / 不加载外部资源，所以不影响功能。
  try {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes
        for (var j = 0; j < added.length; j++) {
          var node = added[j]
          if (!node || node.nodeType !== 1) continue
          if (node.tagName === 'META' && /content-security-policy/i.test(node.httpEquiv || '')) {
            try { node.parentNode.removeChild(node) } catch (e) {}
          }
        }
      }
    }).observe(document, { childList: true, subtree: true })
  } catch (e) {}
})();
`

/**
 * 守护脚本。宿主反注入最常见的一招是"注入后立刻把 documentElement 上的
 * script 全删掉"。这一段自己重挂主脚本，并把自己的重挂逻辑也保护起来。
 *
 * 关键是**跳过已知脚本**：如果不跳过，宿主删一次我们加两个，加完又被删，
 * 就会推出无穷多个 script 把页面打死（真机上表现为整页卡死）。
 *
 * @param {string} mainUrl 主脚本的 pix:// URL
 * @returns {string} 脚本源码
 */
const GUARD_BODY = (mainUrl) => `
(function (mainUrl) {
  'use strict'
  var KNOWN = 'script[data-pix]'

  function insertMain () {
    if (document.querySelector('script[data-pix="host"]')) return
    var el = document.createElement('script')
    el.src = mainUrl
    el.setAttribute('data-pix', 'host')
    ;(document.head || document.documentElement).appendChild(el)
  }

  // 补丁脚本已经把坑填好了，这里立刻插主脚本。
  insertMain()

  // 自愈：我们的脚本被删就重建。重建时只重建"被删的那一个"，
  // 且先确认它确实不在 DOM 里了 —— 否则会和自己刚插的重复。
  try {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var removed = records[i].removedNodes
        for (var j = 0; j < removed.length; j++) {
          var node = removed[j]
          if (!node || node.nodeType !== 1) continue
          if (!node.getAttribute || !node.getAttribute('data-pix')) continue
          var which = node.getAttribute('data-pix')
          var src = node.src
          if (which === 'guard') continue
          setTimeout(function () {
            if (document.querySelector('script[data-pix="' + which + '"]')) return
            var again = document.createElement('script')
            again.src = src
            again.setAttribute('data-pix', which)
            ;(document.head || document.documentElement).appendChild(again)
          }, 0)
        }
      }
    }).observe(document, { childList: true, subtree: true })
  } catch (e) {}

  // 给探针 / 排查用的可观测点：三段脚本是否都在
  window._pixScriptsPresent = function () {
    return {
      patch: !!document.querySelector('script[data-pix="patch"]'),
      host: !!document.querySelector('script[data-pix="host"]'),
      guard: !!document.querySelector('script[data-pix="guard"]')
    }
  }
})(HOST_MAIN_URL_PLACEHOLDER);
`

module.exports = { PATCH_BODY, GUARD_BODY }
