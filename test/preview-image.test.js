'use strict'

/**
 * 取图脚本（preview-image.js 的 EXTRACT_SCRIPT）的静态守卫。
 *
 * ## 为什么这里只做静态断言，不做真浏览器
 *
 * 这段脚本依赖 DOM / canvas / Image，要在真实 Chromium 里才能完整跑。
 * 项目里没有常驻的浏览器测试夹具，为它引入 Playwright 的代价（CI 时长、
 * 下载体积）大于收益。
 *
 * 所以这里钉住**那些错了会静默失效的点**：
 *   · 是否还在用 fetch（blob: 在隔离世界里会撞 CORS —— 这是已经踩过的坑）；
 *   · 是否对跨源污染做了处理（toDataURL 会抛 SecurityError）；
 *   · 是否缩放到 1600 长边（不缩放就是让用户为大图多付钱）；
 *   · 返回结构是否与 IPC 层对齐。
 *
 * 真机行为由发布前的冒烟清单覆盖（见文件末尾的清单）。
 */

const test = require('node:test')
const assert = require('node:assert')

const { EXTRACT_SCRIPT, extractPreviewImage } = require('../desktop/src/translate/preview-image')

test('取图脚本能被解析', () => {
  assert.doesNotThrow(() => new Function('return ' + EXTRACT_SCRIPT))
})

test('★ 不用 fetch 取图（blob: 在隔离世界里会撞 CORS）', () => {
  // 允许出现在注释里，但不允许出现在代码路径
  const code = EXTRACT_SCRIPT.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(code, /\bfetch\s*\(/, '取图不能走 fetch —— blob URL 在隔离世界里会被 CORS 拦掉')
})

test('★ 优先直接画已渲染的图片元素（像素已在渲染器里，不受 CORS 限制）', () => {
  assert.match(EXTRACT_SCRIPT, /paint\(best\.el\)/, '应优先用页面上已渲染的元素')
})

test('有 background-image 的兜底分支', () => {
  assert.match(EXTRACT_SCRIPT, /backgroundImage/)
  assert.match(EXTRACT_SCRIPT, /new Image\(\)/)
})

test('★ 缩放到 1600 长边（不缩放 = 让用户为大图多付钱）', () => {
  assert.match(EXTRACT_SCRIPT, /MAX_EDGE = 1600/)
  assert.match(EXTRACT_SCRIPT, /Math\.min\(1, MAX_EDGE \/ Math\.max\(sw, sh\)\)/)
})

test('★ toDataURL 被 try/catch 包住（跨源污染会抛 SecurityError）', () => {
  assert.match(EXTRACT_SCRIPT, /try \{\s*[\s\S]*toDataURL[\s\S]*\}\s*catch/)
  assert.match(EXTRACT_SCRIPT, /TAINTED_CANVAS/)
})

test('返回结构带 ok / image / mime（与 IPC 层对齐）', () => {
  assert.match(EXTRACT_SCRIPT, /ok: true/)
  assert.match(EXTRACT_SCRIPT, /mime:/)
  assert.match(EXTRACT_SCRIPT, /image:/)
})

test('太小的图不当预览图（图标/头像会误命中）', () => {
  assert.match(EXTRACT_SCRIPT, /IMAGE_TOO_SMALL/)
  assert.match(EXTRACT_SCRIPT, /120 \* 120/)
})

test('extractPreviewImage：webContents 已销毁时安全返回，不抛错', async () => {
  const res = await extractPreviewImage({ isDestroyed: () => true })
  assert.deepEqual(res, { ok: false, reason: 'NO_WEB_CONTENTS' })
})

test('extractPreviewImage：没有隔离世界能力时安全返回', async () => {
  const res = await extractPreviewImage({ isDestroyed: () => false })
  assert.deepEqual(res, { ok: false, reason: 'NO_ISOLATED_WORLD' })
})

test('extractPreviewImage：走 999 隔离世界（与右键菜单取图同一套，页面看不到）', async () => {
  let worldId = null
  const wc = {
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: async (id) => {
      worldId = id
      return [{ ok: true, image: 'AAA', mime: 'image/webp', from: '100x100' }]
    }
  }
  const res = await extractPreviewImage(wc)
  assert.equal(worldId, 999)
  assert.equal(res.ok, true)
  assert.equal(res.mime, 'image/webp')
})

test('extractPreviewImage：页面脚本抛错时转成失败结果，不冒泡', async () => {
  const wc = {
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: async () => { throw new Error('boom') }
  }
  const res = await extractPreviewImage(wc, { log: () => {} })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'EXTRACT_FAILED')
})

/**
 * ── 发布前冒烟清单（真机，无法自动化）─────────────────────────────
 *
 * 1. 打开 WhatsApp → 点开一张**带文字**的图片 → 右上角应出现「翻译图片」
 *    · 不出现：先看日志里有没有 "image-trans 取图失败"
 *    · 出现但位置飘：调 placeButton 的 top/right 偏移
 * 2. 点按钮 → 面板出现"正在识别…" → 若干秒后出现「原文 / 译文」列表
 * 3. 用 DeepL 引擎点一次 → 应提示"当前通道不支持图片翻译…你现在用的是 DeepL"
 * 4. 关掉图片预览 → 按钮和面板都应消失
 * 5. 聊天列表里滚动（未点开图片）→ 不应出现按钮（缩略图小于 200px）
 * ──────────────────────────────────────────────────────────────
 */
