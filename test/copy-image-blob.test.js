'use strict'

/**
 * 右键「复制图片」真的能进剪贴板 —— 2026-10-29 回归测试。
 *
 * ## 事故
 *
 * 用户在 Mac 上右键 WhatsApp 的图片，「复制图片」菜单项在，
 * 点了之后**什么都没发生**：菜单关了、剪贴板里还是原来的内容。
 *
 * ## 根因（实测，不是猜）
 *
 * WhatsApp 网页版的聊天图片全是 `blob:` URL。而复制走的是：
 *
 *     copyImageToClipboard → downloadAsBuffer → electron.net.request
 *
 * `electron.net.request` **只支持 http: 和 https:**。实测输出：
 *
 *     blob:  ❌ ClientRequest only supports http: and https: protocols
 *     data:  ❌ ClientRequest only supports http: and https: protocols
 *     https: ✅ HTTP 200 · 3831 字节 · image/png
 *
 * https 那条路一直是好的，只有 blob 挂了。
 *
 * ## 更隐蔽的第二处
 *
 * `net.request()` 在遇到不支持的协议时是**同步 throw**。原来这行直接
 * 写在 Promise executor 里：
 *
 *     return new Promise((resolve, reject) => {
 *       const request = electron.net.request({ url, ... })   // ← 这里 throw
 *
 * throw 之后 Promise 既没 resolve 也没 reject —— `await` 永久挂起。
 * 于是连 catch 都进不去，日志里什么都没有。用户看到的就是纯粹的"没反应"。
 *
 * ## 这组测试守什么
 *
 * 1. blob/data 必须走页面内读取，不能再直接喂给 net.request
 * 2. net.request 同步 throw 时必须变成 reject，不能吞掉
 * 3. 失败必须有用户可见的提示（静默失败是这次最伤的地方）
 * 4. 预览 blob 图片不能直接 loadURL（换窗口必然白板）
 */

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(ROOT, 'desktop/main.js'), 'utf8')
const preloadSrc = fs.readFileSync(path.join(ROOT, 'desktop/preload.js'), 'utf8')
const appSrc = fs.readFileSync(path.join(ROOT, 'desktop/renderer/app.js'), 'utf8')

/** 取出一个函数的源码体（按花括号配平），用于检查实现细节 */
function functionBody (src, name) {
  const start = src.indexOf(`function ${name} `)
  assert.ok(start >= 0, `main.js 里找不到 ${name}`)
  const braceStart = src.indexOf('{', start)
  let depth = 0
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`${name} 函数体没有配平的右花括号`)
}

test('blob:/data: 必须走页面内读取，不能直接喂给 net.request', () => {
  const body = functionBody(mainSrc, 'downloadAsBuffer')

  // 必须有 blob/data 的分支
  assert.match(body, /\/\^\(blob\|data\):/i, 'downloadAsBuffer 缺少 blob/data 的协议判断')
  assert.match(body, /readUrlInPage/, 'blob/data 分支必须改走页面内读取')

  // 分支必须在 net.request 之前 —— 顺序错了等于没改
  const branchAt = body.search(/\/\^\(blob\|data\):/i)
  const netAt = body.search(/electron\.net\.request/)
  assert.ok(branchAt > 0 && netAt > branchAt,
    'blob/data 的判断必须出现在 net.request 之前，否则照样会撞上只支持 http(s) 的限制')
})

test('net.request 同步抛异常必须变成 reject —— 否则 await 永久挂起', () => {
  const body = functionBody(mainSrc, 'downloadAsBuffer')

  // 必须用 try/catch 包住 net.request
  const hasTryAround = /try\s*{[\s\S]{0,200}?electron\.net\.request[\s\S]{0,400}?catch/.test(body)
  assert.ok(hasTryAround,
    'net.request 没有 try/catch —— 它遇到不支持的协议是同步 throw，' +
    '在 Promise executor 里 throw 会让 Promise 永久 pending，await 永远等不到结果')

  // catch 里必须 reject
  const catchBlock = body.slice(body.search(/catch\s*\(e\)\s*{/))
  assert.match(catchBlock, /reject\(/, 'net.request 的 catch 里必须 reject，不能什么都不做')
})

test('readUrlInPage 必须在隔离世界里读 blob（安全约束，不能用 page world）', () => {
  const body = functionBody(mainSrc, 'readUrlInPage')

  // ★ 这条是硬约束 ★
  // 产品有安全测试明令禁止 main.js 出现 page world 的 executeJavaScript：
  // 往远程页面自己的 world 里塞代码，等于把主进程执行环境暴露给页面脚本。
  assert.ok(!body.includes('executeJavaScript('),
    'readUrlInPage 出现了 page world 的 executeJavaScript —— 违反安全约束，' +
    '必须改用 executeJavaScriptInIsolatedWorld')
  assert.match(body, /executeJavaScriptInIsolatedWorld/,
    'readUrlInPage 必须用隔离世界读取')

  assert.match(body, /fetch\(/, 'blob: 只有页面自己能 fetch')
  assert.match(body, /Buffer\.from\(b64,\s*'base64'\)/, '主进程侧要把 base64 还原成 Buffer')

  // ★ 必须用 canvas 重编码成 PNG，不能原样回传字节 ★
  //
  // nativeImage 解不了 WebP（实测：614 字节合法 WebP → isEmpty=true），
  // 而聊天贴纸/表情大量是 WebP。原样回传 = 这类图复制必失败。
  assert.match(body, /createImageBitmap/, '必须解码成位图再重编码')
  assert.match(body, /toDataURL\('image\/png'\)/, '必须重编码成 PNG —— nativeImage 不支持 WebP 解码')

  // 安全：URL 必须经 JSON.stringify 注入，不能裸拼进表达式
  assert.match(body, /JSON\.stringify\(url\)/,
    'URL 必须用 JSON.stringify 转义后注入 —— 直接拼字符串等于让页面内容能执行任意代码')
})

test('复制失败必须有用户可见的提示，不能静默 return false', () => {
  const body = functionBody(mainSrc, 'copyImageToClipboard')

  assert.match(body, /notifyImageCopyFailed/, '复制失败必须通知用户')
  // 原来的写法：三个 if 各自 return false，一声不响
  assert.match(body, /catch/, '必须有 catch')
})

test('提示通道真的接通了：main 发 → preload 转 → renderer 显示', () => {
  // 主进程发
  assert.match(mainSrc, /webContents\.send\('app:toast'/, '主进程没有发 app:toast')

  // preload 暴露
  assert.match(preloadSrc, /onToast/, 'preload 没有暴露 onToast，渲染层收不到')
  assert.match(preloadSrc, /ipcRenderer\.on\('app:toast'/, 'preload 没有监听 app:toast')

  // 渲染层消费
  assert.match(appSrc, /onToast/, 'renderer/app.js 没有订阅 onToast')
  assert.match(appSrc, /toast\(/, 'renderer 收到提示后没有调用 toast 显示')
})

test('预览 blob 图片不能直接 loadURL —— 换窗口必然白板', () => {
  const body = functionBody(mainSrc, 'openImagePreview')

  assert.match(body, /\/\^blob:/i, '预览必须先判断是不是 blob:')
  assert.match(body, /readUrlInPage/, 'blob 要先读成 data URL')
  assert.match(body, /data:\$\{|data:\s*\$\{/, 'blob 读完要转成 data URL 再交给预览窗口')

  // 调用点必须用 openImagePreview，不能退回裸 openImageInNewWindow
  assert.match(mainSrc, /openImage:\s*\(\)\s*=>\s*openImagePreview\(/,
    '右键菜单的 openImage 回调还指着老的 openImageInNewWindow，blob 图片照样打不开')
})

test('https 图片的既有能力不能被改坏（回归保护）', () => {
  const body = functionBody(mainSrc, 'downloadAsBuffer')
  // https 仍然走 net.request，且带 session cookie
  assert.match(body, /useSessionCookies:\s*true/, 'https 图片仍需要带 session 凭据')
  assert.match(body, /statusCode\s*>=\s*400/, 'HTTP 错误码仍要 reject')
})

// ---------------------------------------------------------------------------
// 图片形态覆盖：WebP 贴纸 / 灯箱背景图
// ---------------------------------------------------------------------------

test('WebP 贴纸必须能复制 —— nativeImage 解不了 WebP，得先转 PNG', () => {
  // 实测：614 字节的合法 WebP 喂给 nativeImage.createFromBuffer 返回 isEmpty=true。
  // WhatsApp 的贴纸、表情大量是 WebP，不做转换这条路就是断的。
  const body = functionBody(mainSrc, 'readUrlInPage')
  assert.match(body, /createImageBitmap/, '必须先把 WebP 解码成位图')
  assert.match(body, /toDataURL\('image\/png'\)/, '必须重编码为 PNG —— nativeImage 只认 PNG/JPEG')
})

test('灯箱拿不到 srcURL 时，兜底菜单必须给「复制图片」而不只是保存', () => {
  const tmpl = fs.readFileSync(path.join(ROOT, 'desktop/src/window/context-menu-template.js'), 'utf8')

  // 兜底分支里要有 copyFromPage
  assert.match(tmpl, /copyFromPage/, '兜底菜单缺少「复制图片」—— 灯箱里只能存不能复制，很别扭')
  assert.match(tmpl, /saveFromPage/, '兜底菜单缺「保存图片」')

  // 主进程必须真的接上这个回调
  assert.match(mainSrc, /copyFromPage:\s*\(\)\s*=>\s*copyImageFromPage\(/,
    'main.js 没接 copyFromPage 回调，菜单项点了会没反应')
})

test('页面嗅探逻辑被保存/复制共用，不能各写一份', () => {
  // 两份嗅探代码迟早会分叉，改一处漏一处
  assert.match(mainSrc, /async function sniffPageImageUrl/, '缺少共用的嗅探函数')
  const copyBody = functionBody(mainSrc, 'copyImageFromPage')
  const saveBody = functionBody(mainSrc, 'saveImageFromPage')
  assert.match(copyBody, /sniffPageImageUrl/, '复制必须复用 sniffPageImageUrl')
  assert.match(saveBody, /sniffPageImageUrl/, '保存必须复用 sniffPageImageUrl')
})

test('嗅探出的 URL 必须过协议白名单，不能拿来就用', () => {
  const body = functionBody(mainSrc, 'sniffPageImageUrl')
  // 页面是不可信的，它返回的字符串可能被构造成 javascript: 之类
  assert.match(body, /\^\(https\?|https\?:/, '嗅探结果必须只认 http(s)/blob/data')
})
