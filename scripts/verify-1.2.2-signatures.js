'use strict'

/**
 * 端到端验签：拿生产库现签的清单，走客户端同一条验签路径。
 *
 * 这模拟的是"用户点检查更新"那一刻，客户端拿到 /client/update 的返回之后
 * 会发生什么。只要这一步过了，就说明：私钥签出来的东西，客户端内置的公钥
 * 认账 —— 中间任何一环（payload 拼装规则、DER 编码、公钥注入）不一致都会挂。
 */

const { manifestPayload, verifySignature } = require('../desktop/src/update/signature')
const { PUBLIC_KEYS } = require('../desktop/src/update/trusted-keys')

const MANIFESTS = [
  { os: 'Windows', arch: 'x64', manifest: { appId: 'com.hellopix.desktop', version: '1.2.2', url: 'https://pixfanyi.com/downloads/HelloPix-Setup-1.2.2.exe', sha256: '48e2af2bea782cfc97c3edc96a829b31491178097c17b8933274c34a2a4f515d', channel: 'stable', minVersion: '1.2.0', signature: 'SG1byWrTZgJHkllRwlAsQbkzGN3s8ZJ4o+ZIgYZAFcprUxI4WMZBjCh/tlcmaPfqNaLnEo/X8DOsakUVaKuIAw==' } },
  { os: 'macOS', arch: 'x64', manifest: { appId: 'com.hellopix.desktop', version: '1.2.2', url: 'https://pixfanyi.com/downloads/Hello%20Pix-1.2.2.dmg', sha256: 'cd00f563c99de29c9cb82466f916e2ca10579b6f40757373b4cae05a04d7603f', channel: 'stable', minVersion: '1.2.0', signature: '/m5e+EvSvaoVZgAmBTh+1u2oeOh412YtcmFFUjhpLJMZnnTOF/HK95AzX9t6O2oFFiC6fN09GZsqUJUguXulBQ==' } },
  { os: 'macOS', arch: 'arm64', manifest: { appId: 'com.hellopix.desktop', version: '1.2.2', url: 'https://pixfanyi.com/downloads/Hello%20Pix-1.2.2-arm64.dmg', sha256: '69e70f8761f72e00aff85759d2a8f93d23a403254a75445a0c4548367af15731', channel: 'stable', minVersion: '1.2.0', signature: 'XDjkpVLYyCxEf+cAn2mtu0rPyfV1r3gXbsVeY6+AysUZx+urOl/jBEKz+q2OSRq3VWQ9yQUJlYEbYtjSoTdEBw==' } }
]

let bad = 0
for (const item of MANIFESTS) {
  const label = item.os + '/' + item.arch
  let ok = false
  try {
    const payload = manifestPayload(item.manifest)
    ok = verifySignature(payload, item.manifest.signature, PUBLIC_KEYS)
  } catch (e) {
    console.log('✘', label, '抛异常:', e.message)
    bad++
    continue
  }
  console.log(ok ? '✔' : '✘', label, ok ? '签名验证通过' : '签名验证失败')
  if (!ok) bad++
}

if (bad) {
  console.error('\n' + bad + ' 条验签失败')
  process.exit(1)
}
console.log('\n三条全部通过 —— 私钥签的、客户端公钥认账')
