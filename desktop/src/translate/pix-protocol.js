'use strict'

/**
 * `pix://` 协议 —— 把本地脚本送进**页面世界**的唯一可行通道（Electron 33）。
 *
 * ## 为什么需要它（这不是设计洁癖，是硬约束）
 *
 * 客页要装「翻译图片」按钮，这个按钮必须跑在页面世界（理由见
 * src/translate/page-world-scripts.js）。而：
 *
 *   1. 客页是 sandbox:true，preload 读不到本地文件，只能靠主进程供码；
 *   2. 页面世界与 preload 世界是**两个 window**，变量传不过去；
 *   3. `<script>` 标签只认 URL，不认字符串；
 *   4. 2026-10-29 真机实测：**`<script src="file://…">` 被 Chromium 拒** ——
 *      `Not allowed to load local resource: file:///…`
 *      即使把 `webSecurity` 关掉也不行（file:// 对远程来源永久禁止）。
 *
 * 所以只能自定义一个协议来喂脚本。
 *
 * ## 为什么自定义协议可行、data:/blob: 不行
 *
 * 宿主（WhatsApp 等）的 CSP 会拦住 `data:` 和 `blob:` 脚本。自定义标准协议
 * 在 CSP 眼里是一个普通来源，Chrome 不会无条件拦。真机实测（2026-10-29）：
 * `pix://pix/…` 脚本在 `data:` 页面上正常执行。
 *
 * ## 安全边界（必读）
 *
 * 这个协议**只在主进程注册一次**，且只服务一个固定目录里的三个固定文件。
 * 校验顺序：协议 → host → 文件名白名单。任何不匹配一律 404，
 * 不做路径拼接、不读用户可控路径 —— 否则就是本地文件读取漏洞。
 */

const fsp = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const SCHEME = 'pix'
const HOST = 'pix'
/** 只有这三个名字能被取出。不在这里的一律 404。 */
const ALLOWED = new Set(['patch.js', 'main.js', 'guard.js'])

let registered = false
const attachedSessions = new WeakSet()
let attachedGlobally = false

/** 注册 scheme 特权 —— 必须在 app ready **之前**调用。 */
function registerPrivilegedScheme (electron) {
  try {
    electron.protocol.registerSchemesAsPrivileged([{
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        // 宿主 CSP 不该能挡我们的脚本；我们自己只供三个固定文件，
        // 内容完全由主进程控制，所以放开是安全的。
        bypassCSP: true
      }
    }])
    return true
  } catch (e) {
    return false
  }
}

/**
 * ★ 必须在 app.ready 时立刻调用，不能等第一个客页来要 ★
 *
 * 2026-10-29 实测（scripts/tmp 里的对照探针，结论已固化进
 * test/image-translate-page-world.test.js）：
 *
 *   handle 在 loadURL 之前 → 页面里 fetch('pix://…') 正常
 *   handle 在 loadURL 之后 → 页面里 fetch 直接 ERR_FAILED，
 *                            处理函数**完全不会被调用**
 *
 * 也就是说 Chromium 在导航时就把"这个 scheme 有没有处理者"记下来了，
 * 之后再挂也没用。原来的设计是"第一个客页启动时 sendSync 才落盘+挂协议"，
 * 而那一定发生在导航之后 —— 所以按钮永远不出现，且没有任何报错。
 *
 * 所以改成：app.ready 之后立刻调这个函数，把 handler 挂到 defaultSession。
 * 之后新建的 partition 由 attachHandler 按需补挂（那时导航还没开始，
 * 是安全的）。
 */
function prewarm (electron) {
  if (!electron || !electron.session) return false
  try {
    const { pageWorldDir } = require('./page-world-inject')
    return attachHandler(electron, electron.session.defaultSession, pageWorldDir())
  } catch (e) {
    return false
  }
}

/**
 * 把协议挂到指定的 session 上。
 *
 * @param {object} electron { protocol: { handle } }
 * @param {object} ses      electron.session（客页用的那个 partition）
 * @param {string} dir      脚本目录
 * @returns {boolean}
 */
function attachHandler (electron, ses, dir) {
  if (!electron || !electron.protocol || !ses || !dir) return false
  if (attachedSessions.has(ses)) return true
  try {
    const handler = async (request) => {
      let url
      try { url = new URL(request.url) } catch (e) { return new Response('bad url', { status: 400 }) }
      if (url.hostname !== HOST) return new Response('not found', { status: 404 })
      const name = url.pathname.replace(/^\/+/, '')
      if (!ALLOWED.has(name)) return new Response('not found', { status: 404 })
      try {
        const body = await fsp.readFile(path.join(dir, name), 'utf8')
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' }
        })
      } catch (e) {
        return new Response('read failed', { status: 500 })
      }
    }
    // 用 ses.protocol 而不是全局 protocol：客页跑在独立 partition 上，
    // 挂全局会让所有 session 都暴露这三个文件。
    if (ses.protocol && typeof ses.protocol.handle === 'function') {
      ses.protocol.handle(SCHEME, handler)
      attachedSessions.add(ses)
    } else {
      if (!attachedGlobally) electron.protocol.handle(SCHEME, handler)
      attachedGlobally = true
    }
    registered = true
    return true
  } catch (e) {
    return false
  }
}

/** 脚本名 → pix:// URL。 */
function scriptUrl (name) {
  return SCHEME + '://' + HOST + '/' + name
}

/**
 * 主进程内部读这几个文件时用的 file URL（不经过协议，避免自举问题）。
 * 目前没用上，留在这里是为了让"文件在哪"只有一处定义。
 */
function fileUrlOf (dir, name) {
  return pathToFileURL(path.join(dir, name)).href
}

module.exports = {
  SCHEME,
  HOST,
  ALLOWED,
  registerPrivilegedScheme,
  attachHandler,
  prewarm,
  scriptUrl,
  fileUrlOf,
  isRegistered: () => registered
}
