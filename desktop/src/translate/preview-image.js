'use strict'

/**
 * 从客页里**取出正在预览的那张图**，转成 base64。
 *
 * ## 为什么这一整段必须跑在页面里（隔离世界）
 *
 * 图片的 `src` 可能是三种东西：
 *
 *   · `blob:https://web.whatsapp.com/...` —— 只在这个页面进程里有效，
 *     主进程拿不到（换进程取就是 404）；
 *   · `data:...`             —— 能直接读；
 *   · `https://...`          —— 带会话凭据，主进程裸抓可能 403。
 *
 * 三种里只有第二种主进程能独立处理。而页面里**已经渲染过的 `<img>`** 像素就在
 * 渲染器中，`drawImage` 直接取用 —— 既不用二次下载，也不受 blob 的跨源限制。
 * 所以整段逻辑放在页面上下文（隔离世界）执行、用 canvas 导出 base64。
 *
 * ## 为什么要缩放
 *
 * WhatsApp 的原图常常 1600~3000px。视觉模型按图计费，且像素越多越慢。
 * 翻译只需要**看清字**，1600px 长边足够，再大就是把钱花在模型看不见的细节上。
 *
 * 缩放还顺带解决了体积问题：3000px 的截图 base64 常有 3~6MB，
 * 缩到 1600px 一般 300~800KB，请求更快、更省钱。
 *
 * ## 为什么用「可见面积最大的图」而不是精确找灯箱
 *
 * 灯箱的 DOM 结构是 WhatsApp 私有的、随版本变（`.x1lliihq` 这类哈希类名
 * 每次发版都可能变）。写死选择器 = 下次它改版就静默失效。
 *
 * 而"用户点开的那张图"有一个稳定特征：**它在屏幕上占据的面积最大**。
 * 这个判据来自画面本身，不依赖任何类名，宿主改版也不会坏。
 */

/** 这一步必须在页面上下文执行：常量脚本，不拼任何外部输入。 */
const EXTRACT_SCRIPT = `
(async () => {
  const vw = innerWidth, vh = innerHeight
  const visibleArea = (el) => {
    const r = el.getBoundingClientRect()
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0))
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))
    return w * h
  }

  // 1) 找面积最大的可见图片（<img> 优先，其次 background-image）
  let best = null
  for (const img of document.images) {
    const url = img.currentSrc || img.src
    if (!url) continue
    const area = visibleArea(img)
    if (area > 0 && (!best || area > best.area)) best = { area: area, url: url }
  }
  if (!best) {
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      const bi = cs.backgroundImage
      if (!bi || bi === 'none') continue
      const m = bi.match(/url\\(["']?([^"')]+)["']?\\)/)
      if (!m) continue
      const area = visibleArea(el)
      if (area > 0 && (!best || area > best.area)) best = { area: area, url: m[1] }
    }
  }
  if (!best) return { ok: false, reason: 'NO_IMAGE' }

  // 太小的一律不当"预览图"：图标、头像也会上榜，但面积很小。
  if (best.area < 120 * 120) return { ok: false, reason: 'IMAGE_TOO_SMALL' }

  // 2) 缩放到长边 MAX_EDGE，再导出 base64
  //
  // ★ 为什么直接 drawImage(<img>) 而不是 fetch(url) → blob → createImageBitmap ★
  //
  // 试过 fetch 的两种坑：
  //   · blob: URL 在隔离世界里 fetch 会撞 CORS（blob 的 origin 是页面的，
  //     隔离世界发起的请求被当成跨源），WhatsApp 的图恰恰多数是 blob:；
  //   · 远程 https 图虽然能 fetch，但要在页面里做一次完整下载，
  //     等于把已经渲染好的像素又下载一遍。
  //
  // 页面上那个图片元素**已经渲染过**，它的像素就在渲染器里，
  // drawImage 直接取用，不受 CORS 影响、也不用二次下载。
  // 代价是拿不到 background-image 的像素（那种只能用 Image() 重新加载），
  // 所以下面留了一条兜底分支。
  const MAX_EDGE = 1600
  const canvas = document.createElement('canvas')
  const paint = (src) => {
    const sw = src.naturalWidth || src.width || 0
    const sh = src.naturalHeight || src.height || 0
    if (!sw || !sh) return null
    const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh))
    const dw = Math.max(1, Math.round(sw * scale))
    const dh = Math.max(1, Math.round(sh * scale))
    canvas.width = dw
    canvas.height = dh
    const ctx = canvas.getContext('2d')
    ctx.drawImage(src, 0, 0, dw, dh)
    return { size: sw + 'x' + sh, width: dw, height: dh }
  }

  let info = null
  if (best.el) {
    // <img> 分支：像素已在渲染器里，直接画
    try {
      if (!best.el.complete) await best.el.decode()
    } catch (e) { /* 已加载完的图 decode 会抛，忽略 */ }
    info = paint(best.el)
  }

  if (!info) {
    // 兜底：background-image / 未拿到<img>元素 —— 用 Image() 重新加载一次。
    // 这一步对跨源图会污染 canvas（toDataURL 抛 SecurityError），
    // 所以失败时如实返回，不假装成功。
    const loaded = await new Promise((resolve) => {
      const im = new Image()
      im.crossOrigin = 'anonymous'
      im.onload = () => resolve(im)
      im.onerror = () => resolve(null)
      im.src = best.url
    })
    if (!loaded) return { ok: false, reason: 'LOAD_FAILED' }
    try {
      info = paint(loaded)
    } catch (e) {
      return { ok: false, reason: 'TAINTED_CANVAS', detail: String((e && e.message) || e) }
    }
  }
  if (!info) return { ok: false, reason: 'BAD_BITMAP' }

  let dataUrl
  try {
    // WebP 质量 0.9：同样清晰度下比 JPEG 小 25%~35%，模型读小字不吃亏。
    dataUrl = canvas.toDataURL('image/webp', 0.9)
  } catch (e) {
    // 跨源图片会污染 canvas —— 这里如实上报，让上层提示用户截图翻译
    return { ok: false, reason: 'TAINTED_CANVAS', detail: String((e && e.message) || e) }
  }

  // 浏览器不支持 webp 编码时会静默退回 png（dataUrl 头仍是 image/png），
  // 所以 mime 从 dataUrl 里读，而不是写死。
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return { ok: false, reason: 'BAD_DATAURL' }
  const head = dataUrl.slice(0, comma)
  const mimeMatch = head.match(/^data:([^;]+)/)
  return {
    ok: true,
    mime: mimeMatch ? mimeMatch[1] : 'image/png',
    image: dataUrl.slice(comma + 1),
    width: info.width,
    height: info.height,
    from: info.size
  }
})()
`

/**
 * 从 webContents 里取出当前预览的图片。
 *
 * @param {object} wc    客页的 webContents
 * @param {object} [deps] { log: (msg) => void }（便于单测注入）
 * @returns {Promise<{ok:boolean, image?:string, mime?:string, reason?:string}>}
 */
async function extractPreviewImage (wc, deps) {
  const opts = deps || {}
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
    return { ok: false, reason: 'NO_WEB_CONTENTS' }
  }
  if (typeof wc.executeJavaScriptInIsolatedWorld !== 'function') {
    return { ok: false, reason: 'NO_ISOLATED_WORLD' }
  }

  try {
    // 世界 id 999 与右键菜单取图一致：同一套隔离世界，页面看不到我们的代码。
    const raw = await wc.executeJavaScriptInIsolatedWorld(999, [{ code: EXTRACT_SCRIPT }])
    const value = Array.isArray(raw) ? raw[0] : raw
    if (!value || typeof value !== 'object') return { ok: false, reason: 'NO_RESULT' }
    if (!value.ok) {
      log('取图失败：' + value.reason + (value.detail ? ' ' + value.detail : ''))
      return value
    }
    return value
  } catch (e) {
    log('取图异常：' + ((e && e.message) || e))
    return { ok: false, reason: 'EXTRACT_FAILED', detail: String((e && e.message) || e) }
  }
}

module.exports = { extractPreviewImage, EXTRACT_SCRIPT }
