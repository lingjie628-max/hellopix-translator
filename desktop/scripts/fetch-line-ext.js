'use strict'
/**
 * 打包前准备 LINE 官方 Chrome 扩展 → desktop/vendor/line-ext/
 *
 * LINE 个人号没有网页版，唯一的浏览器入口是官方扩展（ID ophjlpahpchlmihnnnihgmmeilfjmjjc）。
 * 这里把它从 Chrome 应用商店取下来，并做三件事：
 *   1. **校验**：整个 CRX 的 SHA-256 必须等于 PINNED_CRX_SHA256；头里的 crx_id 与公钥算出的 ID
 *      都必须是官方 ID。任何一项不符直接失败 —— 绝不把来路不明的代码打进安装包。
 *      LINE 更新扩展后这里会失败：先人工确认新版能用，再更新指纹。
 *   2. 把官方公钥写进 manifest.key：Electron 按 key 算扩展 ID，ID 与官方一致，
 *      LINE 服务端看到的来源才是正规扩展。
 *   3. 接上 line-ext-shim.js：补 Electron 不支持的 chrome.* 接口，否则后台脚本启动即崩、页面空白。
 *
 * 用法：node scripts/fetch-line-ext.js            （已有且版本一致则跳过）
 *       node scripts/fetch-line-ext.js --force
 *       PIX_LINE_CRX=/path/to/line.crx node scripts/fetch-line-ext.js   （用本地 CRX，仍然验签）
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const https = require('node:https')
const { execFileSync } = require('node:child_process')

const LINE_EXT_ID = 'ophjlpahpchlmihnnnihgmmeilfjmjjc'
/** LINE 3.7.2（2026-10-13 自 Chrome 应用商店取得，两次下载逐字节一致）。 */
const PINNED_CRX_SHA256 = '3722ab02edb0aba49c229399ee8df5b4b5a38c60b76efadadfbae395015eb859'
const ROOT = path.join(__dirname, '..')
const VENDOR = path.join(ROOT, 'vendor')
const OUT = path.join(VENDOR, 'line-ext')
const SHIM = path.join(ROOT, 'line-ext-shim.js')
const CRX_URL = 'https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0.0.0' +
  '&acceptformat=crx2,crx3&x=id%3D' + LINE_EXT_ID + '%26uc'

function download (url, redirects) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131.0.0.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if ((redirects || 0) > 5) return reject(new Error('重定向过多'))
        return resolve(download(new URL(res.headers.location, url).toString(), (redirects || 0) + 1))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('下载失败 HTTP ' + res.statusCode)) }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

function readVarint (b, i) {
  let v = 0
  let s = 0
  let c
  do {
    if (i >= b.length) throw new Error('protobuf 越界')
    c = b[i++]
    v += (c & 0x7f) * Math.pow(2, s)
    s += 7
  } while (c & 0x80)
  return [v, i]
}

function protoFields (b) {
  const out = []
  let i = 0
  while (i < b.length) {
    let key
    ;[key, i] = readVarint(b, i)
    const field = Math.floor(key / 8)
    const wire = key % 8
    if (wire === 2) {
      let len
      ;[len, i] = readVarint(b, i)
      out.push([field, b.subarray(i, i + len)])
      i += len
    } else if (wire === 0) {
      ;[, i] = readVarint(b, i)
    } else {
      throw new Error('CRX 头里出现不支持的 wire type ' + wire)
    }
  }
  return out
}

function extIdOf (publicKeyDer) {
  return crypto.createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 32)
    .split('').map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('')
}

/** 校验 CRX3 并返回 { zip, publicKey }。 */
function verifyCrx (buf, pinned) {
  const digest = crypto.createHash('sha256').update(buf).digest('hex')
  const expect = pinned === undefined ? PINNED_CRX_SHA256 : pinned
  if (expect && digest !== expect) {
    throw new Error('CRX 指纹不符（期望 ' + expect.slice(0, 12) + '…，实际 ' + digest.slice(0, 12) + '…）—— LINE 可能更新了扩展，确认新版可用后再更新 PINNED_CRX_SHA256')
  }
  if (buf.subarray(0, 4).toString('latin1') !== 'Cr24') throw new Error('不是 CRX 文件')
  if (buf.readUInt32LE(4) !== 3) throw new Error('只支持 CRX3，实际版本 ' + buf.readUInt32LE(4))
  const hlen = buf.readUInt32LE(8)
  const header = buf.subarray(12, 12 + hlen)
  const zip = buf.subarray(12 + hlen)
  const fields = protoFields(header)
  const signedHeader = (fields.find((f) => f[0] === 10000) || [])[1]
  if (!signedHeader) throw new Error('CRX 缺少 signed_header_data')
  const crxId = (protoFields(signedHeader).find((f) => f[0] === 1) || [])[1]
  if (!crxId) throw new Error('CRX 缺少 crx_id')
  const idFromHeader = Array.from(crxId).map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('')
  if (idFromHeader !== LINE_EXT_ID) throw new Error('CRX 的 crx_id 不是 LINE 官方扩展：' + idFromHeader)

  for (const [field, proof] of fields) {
    if (field !== 2) continue
    const pub = (protoFields(proof).find((f) => f[0] === 1) || [])[1]
    if (pub && extIdOf(pub) === LINE_EXT_ID) return { zip, publicKey: Buffer.from(pub) }
  }
  throw new Error('CRX 里没有 LINE 官方公钥')
}

/** 把垫片接进扩展：页面在第一个脚本前加载；后台 service worker 先 import 垫片。 */
function applyShim (dir) {
  fs.copyFileSync(SHIM, path.join(dir, 'pix-shim.js'))
  for (const page of ['index.html', 'popup.html']) {
    const f = path.join(dir, page)
    if (!fs.existsSync(f)) continue
    const html = fs.readFileSync(f, 'utf8')
    if (html.includes('pix-shim.js')) continue
    if (!/<script/i.test(html)) throw new Error(page + ' 里找不到 <script>，扩展结构变了')
    fs.writeFileSync(f, html.replace(/<script/i, '<script src="/pix-shim.js"></script><script'))
  }
  const mf = path.join(dir, 'manifest.json')
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'))
  const bg = m.background && m.background.service_worker
  if (!bg) throw new Error('manifest 没有 background.service_worker，扩展结构变了')
  if (bg !== 'pix-bg.js') {
    fs.writeFileSync(path.join(dir, 'pix-bg.js'), "import './pix-shim.js'\nimport './" + bg + "'\n")
    m.background.service_worker = 'pix-bg.js'
    m.background.type = 'module'
  }
  fs.writeFileSync(mf, JSON.stringify(m, null, 2))
}

async function main () {
  const force = process.argv.includes('--force')
  const metaFile = path.join(OUT, '.pix-meta.json')
  const shimHash = crypto.createHash('sha256').update(fs.readFileSync(SHIM)).digest('hex')
  if (!force && fs.existsSync(metaFile)) {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    if (meta.shimSha256 === shimHash && fs.existsSync(path.join(OUT, 'manifest.json'))) {
      console.log('[line-ext] 已就绪 v' + meta.version + '（--force 重新获取）')
      return
    }
  }

  const crx = process.env.PIX_LINE_CRX ? fs.readFileSync(process.env.PIX_LINE_CRX) : await download(CRX_URL)
  const { zip, publicKey } = verifyCrx(crx)
  console.log('[line-ext] 指纹与官方 ID 校验通过')

  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  const zipFile = path.join(VENDOR, 'line-ext.zip')
  fs.writeFileSync(zipFile, zip)
  try {
    execFileSync('unzip', ['-q', '-o', zipFile, '-d', OUT])
  } finally {
    fs.rmSync(zipFile, { force: true })
  }

  const mf = path.join(OUT, 'manifest.json')
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'))
  m.key = publicKey.toString('base64')
  fs.writeFileSync(mf, JSON.stringify(m, null, 2))
  applyShim(OUT)
  // _metadata 是商店的内容校验清单，改过文件后它会对不上；Electron 用不到，删掉。
  fs.rmSync(path.join(OUT, '_metadata'), { recursive: true, force: true })

  fs.writeFileSync(metaFile, JSON.stringify({
    id: LINE_EXT_ID,
    version: m.version,
    crxSha256: crypto.createHash('sha256').update(crx).digest('hex'),
    shimSha256: shimHash,
    fetchedAt: new Date().toISOString()
  }, null, 2))
  console.log('[line-ext] 已准备 v' + m.version + ' → ' + path.relative(ROOT, OUT))
}

if (require.main === module) {
  main().catch((e) => { console.error('[line-ext] 失败：' + ((e && e.message) || e)); process.exit(1) })
}

module.exports = { verifyCrx, extIdOf, applyShim, protoFields, LINE_EXT_ID, PINNED_CRX_SHA256 }
