'use strict'

/**
 * 生成更新签名用的 Ed25519 密钥对。
 *
 *   node scripts/update-keygen.js
 *
 * ## 只需跑一次
 *
 * 换了密钥，所有**旧客户端**只认旧公钥（内置在 app.asar 里），新公钥它们不认。
 * 所以换钥必须走轮换：
 *
 *   1. 生成新钥
 *   2. 把新钥填进客户端 `desktop/src/update/trusted-keys.js` 的 PRIMARY，
 *      把**旧钥**挪到 PREVIOUS
 *   3. 发一版客户端，让用户升上来（这一版新旧钥都认）
 *   4. 服务端换成新私钥开始签
 *   5. 等旧版本覆盖率足够低，再清空 PREVIOUS
 *
 * 跳过第 2、3 步直接换服务端私钥 = 所有旧客户端立即失去更新能力，
 * 而它们恰恰是最需要被更新的那批。
 *
 * ## 输出什么
 *
 *   update-signing.key   私钥（PKCS8 PEM）—— 只放构建机 / 服务器环境变量
 *   update-signing.pub   公钥（SPKI PEM）—— 提交进仓库
 *   update-signing.pub.b64  单行 base64 公钥 —— 填进 trusted-keys.js
 *
 * 私钥**不要**提交进 git。脚本会提醒。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const outDir = path.resolve(process.argv[2] || '.')
const keyPath = path.join(outDir, 'update-signing.key')
const pubPath = path.join(outDir, 'update-signing.pub')
const pubB64Path = path.join(outDir, 'update-signing.pub.b64')

if (fs.existsSync(keyPath)) {
  console.error(`私钥已存在：${keyPath}`)
  console.error('换钥会让所有旧客户端失去更新能力，必须走轮换流程（见本文件注释）。')
  console.error('确实要重新生成请先手工删除该文件。')
  process.exit(1)
}

fs.mkdirSync(outDir, { recursive: true })

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')

const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const publicPem = publicKey.export({ type: 'spki', format: 'pem' })
const publicDerB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

fs.writeFileSync(keyPath, privatePem, { mode: 0o600 })
fs.writeFileSync(pubPath, publicPem, { mode: 0o644 })
fs.writeFileSync(pubB64Path, publicDerB64 + '\n', { mode: 0o644 })

console.log('')
console.log('已生成更新签名密钥（Ed25519）')
console.log('')
console.log(`  私钥：${keyPath}`)
console.log('        → 复制到构建机或服务器环境变量 UPDATE_SIGNING_KEY，然后从本机删除')
console.log('        → 绝不要提交进 git')
console.log('')
console.log(`  公钥：${pubPath}`)
console.log(`  单行：${pubB64Path}`)
console.log('')
console.log('把下面这行填进 desktop/src/update/trusted-keys.js 的 PRIMARY：')
console.log('')
console.log(`  '${publicDerB64}'`)
console.log('')
console.log('服务端启动前设置：')
console.log(`  export UPDATE_SIGNING_KEY="$(cat ${path.basename(keyPath)})"`)
console.log('')
