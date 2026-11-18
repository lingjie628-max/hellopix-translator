'use strict'

/**
 * 往页面世界注入代码的**唯一**通道。
 *
 * ## 背景（读之前先看这个，不然会想不通为什么要绕这么大一圈）
 *
 * 客页是 `sandbox: true` + `contextIsolation: true`：
 *
 *   · preload 在 sandbox 下只有 require('electron')，读不到本地文件；
 *   · 页面世界是网页自己的 JS 环境，看不到 preload 变量；
 *   · 两个世界之间只有 **window 上的属性** 能互通（DOM 也是共用的）。
 *
 * 我们想在页面世界跑代码（理由见 src/translate/page-world-scripts.js
 * 和 test/image-translate-page-world.test.js 里记录的隔离世界事件缺陷），
 * 而唯一能把代码送进页面世界的通道是 `<script>` 标签 —— 它只认 URL。
 *
 * 所以：**主进程把代码写进临时文件，把 file:// URL 交给 preload。**
 *
 * ## 为什么不用 <webview preload> 或 session.setPreloads
 *
 * 那些挂在 preload 世界，进的还是隔离世界，解决不了事件收不到的问题。
 *
 * ## 为什么不用 data: URL
 *
 * 很多宿主 CSP 里 `script-src` 不含 data:，插进去直接不执行。
 * file:// 不在 CSP 管辖范围内（CSP 只约束网络来源），不受宿主策略影响。
 *
 * ## 时序
 *
 * 文件必须在 preload `sendSync('translate:pageScripts')` **之前**写好。
 * 这个模块在 registerTranslateIpc 时被同步调用一次，而 preload 注册在
 * 窗口创建时 —— 一定晚于 IPC 注册。所以是安全的。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { buildImageTranslateScript } = require('./image-translate-ui')
const { buildVoiceNoteImportScript } = require('./voice-note-import')
const { buildWhatsAppDirectPttScript } = require('./whatsapp-direct-ptt')
const { buildWhatsAppCounterObserverScript } = require('./whatsapp-counter-observer')
const { PATCH_BODY, GUARD_BODY } = require('./page-world-scripts')
const { scriptUrl, attachHandler } = require('./pix-protocol')

/** 落盘目录名。带版本号是为了让"缓存了旧文件"和"代码没生效"能区分开。 */
const DIR_NAME = 'pix-page-world'

let cache = null

/**
 * 组装宿主脚本（页面世界里跑的那一份）。
 *
 * 目前有「翻译图片」「外部音频按原生录音发送」和「快速语音」。
 * 「快速语音」直接调用 WhatsApp Web 内部媒体模块，属于显式高风险入口；
 * 它和虚拟麦克风入口分开，失败时绝不自动回退，避免重复发送。
 * 以后要往页面世界加东西，一律往这里拼，不要再往隔离世界塞 —— 见文件头。
 */
function buildHostScript () {
  return [
    '(function () {',
    '  "use strict";',
    // 已经装过就直接退出：守护脚本可能重建我们，重复装会挂两套计时器。
    '  if (window.__pixPageHostInstalled) return;',
    '  window.__pixPageHostInstalled = true;',
    '  console.info("[pix-pageworld] host 开始");',
    buildImageTranslateScript({ buttonText: '翻译图片' }),
    '  console.info("[pix-pageworld] 图片翻译已安装");',
    buildVoiceNoteImportScript(),
    '  console.info("[pix-pageworld] 原生语音导入已安装");',
    buildWhatsAppDirectPttScript(),
    '  console.info("[pix-pageworld] 快速语音已安装");',
    buildWhatsAppCounterObserverScript(),
    '  console.info("[pix-pageworld] 进粉观察器已安装");',
    '})();'
  ].join('\n')
}

/**
 * 把三段代码写到临时目录，返回**页面世界可加载**的 URL。
 *
 * ## 为什么 URL 是 pix:// 而不是 file://
 *
 * 2026-10-29 真机实测：页面里插 `<script src="file:///…">` 会被 Chromium
 * 直接拒绝 —— `Not allowed to load local resource`。这是 file:// 对远程
 * 来源的永久限制，关掉 webSecurity 也没用。
 *
 * 所以走自定义协议 pix://（见 src/translate/pix-protocol.js）。
 *
 * @param {object} [deps] { dir, log, ses, electron } —— 便于单测
 * @returns {{patch: string, main: string, guard: string, dir: string}}
 */
function writePageWorldScripts (deps) {
  const opts = deps || {}
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const baseDir = opts.dir || path.join(os.tmpdir(), DIR_NAME)

  fs.mkdirSync(baseDir, { recursive: true })

  const urls = {
    patch: scriptUrl('patch.js'),
    main: scriptUrl('main.js'),
    guard: scriptUrl('guard.js'),
    dir: baseDir
  }

  const guardBody = GUARD_BODY(urls.main)
    .replace('HOST_MAIN_URL_PLACEHOLDER', JSON.stringify(urls.main))

  const files = [
    ['patch.js', PATCH_BODY],
    ['main.js', buildHostScript()],
    ['guard.js', guardBody]
  ]
  for (const [name, body] of files) {
    const target = path.join(baseDir, name)
    // 同样的内容不重复写：每次启动都写会白白触发磁盘 IO，
    // 也会让"文件被改坏了"这种排查失去意义（每次都重置）。
    let prev = ''
    try { prev = fs.readFileSync(target, 'utf8') } catch (e) {}
    if (prev !== body) fs.writeFileSync(target, body)
  }

  // 协议必须挂到客页所在的 session 上，否则页面里取不到。
  if (opts.electron && opts.ses) {
    if (!attachHandler(opts.electron, opts.ses, baseDir)) {
      log('pix:// 协议挂载失败 —— 页面世界脚本将无法加载')
    }
  }

  log('页面世界脚本已落盘：' + baseDir)
  return urls
}

/** 带缓存的入口（生产用）。 */
function pageWorldScriptUrls (deps) {
  if (cache) {
    const opts = deps || {}
    // 新 partition 仍要补挂协议。即使 web-view 已经在导航前挂过一次，这里
    // 再调一次最多返回 false，不会覆盖已有 handler；但可以兜住旧调用顺序。
    if (opts.electron && opts.ses) {
      try { attachHandler(opts.electron, opts.ses, cache.dir) } catch (e) {}
    }
    return cache
  }
  cache = writePageWorldScripts(deps)
  return cache
}

/** 脚本落盘目录（pix-protocol.prewarm 要用，不触发写入）。 */
function pageWorldDir (deps) {
  const opts = deps || {}
  return opts.dir || path.join(os.tmpdir(), DIR_NAME)
}

/** 单测用：清缓存 + 清目录。 */
function resetPageWorldScripts () {
  cache = null
}

module.exports = {
  writePageWorldScripts,
  pageWorldScriptUrls,
  pageWorldDir,
  resetPageWorldScripts,
  buildHostScript,
  DIR_NAME
}
