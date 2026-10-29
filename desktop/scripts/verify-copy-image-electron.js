'use strict'
/**
 * 端到端验证：blob: 图片能不能真的进剪贴板。
 *
 * 复现 2026-10-29 的现场：
 *   1. 页面里造一个 blob: URL（和 WhatsApp 的 <img src="blob:..."> 一样）
 *   2. 走修复后的 downloadAsBuffer（blob 分支 → 页面内 fetch → base64 → Buffer）
 *   3. nativeImage 解析 → clipboard.writeImage
 *   4. 从剪贴板读回来，确认真的有图
 *
 * 如果第 4 步拿到的尺寸对，这条链路就是通的。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, net, session, nativeImage, clipboard, BrowserWindow } = require('electron')

const LOG = path.join(os.tmpdir(), 'pix-copy-image-verify.txt')
const lines = []
function log (s) { lines.push(s); fs.writeFileSync(LOG, lines.join('\n') + '\n') }

// ---- 和 main.js 里修复后的实现一致 ----
// ★ 必须用隔离世界 ★ 产品里就是这么做的（安全测试禁止 page world 执行）。
// 验收脚本如果走 page world，就证明不了产品路径真的能用。
const ISOLATED_WORLD_ID = 999

async function readUrlInPage (wc, url) {
  const literal = JSON.stringify(url)
  const code = `
    (async () => {
      const res = await fetch(${literal})
      if (!res.ok) throw new Error('页面读取失败 HTTP ' + res.status)
      const blob = await res.blob()
      const buf = await blob.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let bin = ''
      const CHUNK = 0x8000
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
      }
      return btoa(bin)
    })()
  `
  const raw = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }])
  const b64 = Array.isArray(raw) ? raw[0] : raw
  if (!b64 || typeof b64 !== 'string') throw new Error('页面没有返回图片数据')
  return Buffer.from(b64, 'base64')
}

async function downloadAsBuffer (wc, url) {
  const target = String(url || '')
  if (!target) throw new Error('图片地址为空')
  if (/^(blob|data):/i.test(target)) return readUrlInPage(wc, target)
  return new Promise((resolve, reject) => {
    let request
    try {
      request = net.request({ url: target, session: session.defaultSession, useSessionCookies: true })
    } catch (e) {
      reject(new Error('无法请求该地址：' + ((e && e.message) || e)))
      return
    }
    const chunks = []
    request.on('response', res => {
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}

async function copyImage (wc, url) {
  const buf = await downloadAsBuffer(wc, url)
  if (!buf || !buf.length) throw new Error('图片是空的')
  const image = nativeImage.createFromBuffer(buf)
  if (!image || image.isEmpty()) throw new Error('图片格式无法识别')
  clipboard.writeImage(image)
  return true
}

app.whenReady().then(async () => {
  log('=== 开始 ' + new Date().toISOString() + ' ===')
  const win = new BrowserWindow({
    show: false,
    webPreferences: { backgroundThrottling: false, offscreen: false }
  })
  // 必须等页面真正加载完，否则 executeJavaScript 会一直挂着
  await win.loadURL('data:text/html,<html><body>probe</body></html>')
  log('页面已加载')

  // 造一张 4x4 的 PNG blob —— 尺寸非 1x1，才能证明真的读到内容
  let made
  try {
    const rawMade = await win.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{
      code: `
      (() => {
        const c = document.createElement('canvas')
        c.width = 4; c.height = 4
        const ctx = c.getContext('2d')
        ctx.fillStyle = '#ff0000'
        ctx.fillRect(0, 0, 4, 4)
        return new Promise(resolve => {
          c.toBlob(b => resolve({ blobUrl: URL.createObjectURL(b), size: b.size }), 'image/png')
        })
      })()
    `
    }])
    made = Array.isArray(rawMade) ? rawMade[0] : rawMade
  } catch (e) {
    log('❌ 造 blob 失败: ' + e.message)
    app.exit(1)
    return
  }
  log(`页面里造出 blob: ${made.blobUrl}（${made.size} 字节）`)

  // 清空剪贴板，确保后面读到的是我们自己写进去的
  clipboard.clear()

  log('\n=== 执行复制 ===')
  try {
    await copyImage(win.webContents, made.blobUrl)
    log('✅ copyImage 返回成功')
  } catch (e) {
    log('❌ copyImage 失败: ' + e.message)
    app.exit(1)
    return
  }

  log('\n=== 验证剪贴板 ===')
  const back = clipboard.readImage()
  if (back.isEmpty()) {
    log('❌ 剪贴板里没有图 —— 修复没生效')
  } else {
    const s = back.getSize()
    log(`✅ 剪贴板里有图: ${s.width}x${s.height}`)
    log(s.width === 4 && s.height === 4
      ? '✅ 尺寸完全正确，链路打通'
      : `⚠️ 尺寸是 ${s.width}x${s.height}，预期 4x4`)
    // 存一份出来做人工确认
    const p = path.join(os.tmpdir(), 'pix-clipboard-verify.png')
    fs.writeFileSync(p, back.toPNG())
    log(`已导出: ${p}（${fs.statSync(p).size} 字节）`)
  }

  log('\n=== 对照：修复前会怎样 ===')
  try {
    await new Promise((resolve, reject) => {
      let req
      try {
        req = net.request({ url: made.blobUrl })
      } catch (e) {
        reject(new Error('同步抛异常（修复前这里会让 await 永久挂起）: ' + e.message))
        return
      }
      req.on('error', reject)
      req.end()
    })
    log('？！blob 居然能走 net.request')
  } catch (e) {
    log('修复前：' + e.message)
  }

  app.exit(0)
})

setTimeout(() => { log('硬超时'); app.exit(1) }, 45000)
