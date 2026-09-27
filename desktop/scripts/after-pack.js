/**
 * macOS 打包后的 ad-hoc 签名（electron-builder 的 afterPack 钩子）。
 *
 * ## 为什么需要这一步
 *
 * 2026-09-27：用户从官网下载 HelloPix-0.1.6-arm64.dmg，双击后 macOS 弹：
 *
 *   「Hello Pix.app」已损坏，无法打开。你应该将它移到废纸篓。
 *
 * 文件**没有损坏**。根因是 package.json 的 mac 配置里写了 `identity: null`
 * （显式关闭签名），electron-builder 于是完全跳过 codesign，bundle 里连
 * `_CodeSignature/` 目录都不存在，只留下 Electron 二进制自带的 linker 签名。
 * 那个签名是针对**原始 Electron.app** 的，与 electron-builder 改造过的
 * bundle 对不上，`codesign --verify` 直接报：
 *
 *   code has no resources but signature indicates they must be present
 *
 * 实测 0.1.6 产物（`codesign -dv --verbose=4`）：
 *
 *   Identifier=Electron            ← 应为 com.hellopix.desktop
 *   Info.plist=not bound           ← Info.plist 未被签名覆盖
 *   Sealed Resources=none          ← 完全没有资源封印
 *
 * ## 为什么「签名无效」比「没有签名」更糟
 *
 * macOS 对下载来的（带 com.apple.quarantine 隔离属性）应用的判定分两种，
 * **差别恰恰在于用户能不能自己救回来**：
 *
 *   · 签名**无效**   → 「已损坏，应移到废纸篓」→ Gatekeeper 走**没有旁路**的
 *                      代码路径，右键「打开」也没用，只能开终端敲 xattr。
 *   · 签名**有效但不受信任**（ad-hoc）→ 「无法验证开发者」→ 右键「打开」，
 *                      或 系统设置 → 隐私与安全性 → 「仍要打开」即可放行。
 *
 * 所以这一步把用户从"必须开终端"降到"右键打开一下"。
 *
 * ## ad-hoc 与正式签名怎么共存
 *
 * ad-hoc 签名**不证明开发者身份**，也无法公证。要让用户双击即开、零提示，
 * 必须走 Apple Developer Program → Developer ID Application 证书 → 签名 + 公证。
 *
 * 配置侧已经铺好（见 package.json 的 mac 段）：`identity` 不再写死 `null`，
 * 而是留空让 electron-builder **自动发现** Developer ID Application 证书
 * （它只认这一种类型，不会误用 Apple Development）；并显式指定了
 * hardenedRuntime / entitlements / notarize。
 *
 * **关键**：`identity: null` 会让 electron-builder 在 `sign()` 里直接 return，
 * 连公证都不会尝试（`notarizeIfProvided` 排在那之后）。所以那三个字不删掉，
 * 公证永远不可能发生 —— 这是它必须被移除的原因，不是风格问题。
 *
 * 本钩子的职责随之变成"**判断该不该兜底**"：
 *
 *   · 钥匙串里有 Developer ID Application → 交给 electron-builder 正式签名，
 *     本钩子跳过（否则会留下 `--timestamp=none` 的 ad-hoc 签，而公证
 *     **要求安全时间戳**，那是隐患 —— 虽然正式签名会覆盖它，但没必要冒这个险）。
 *   · 没有证书 → 本钩子兜底做 ad-hoc，把用户从"必须开终端"降到"点一下放行"。
 *
 * 顺序上是安全的：本钩子（afterPack）跑在 electron-builder 签名**之前**
 * （macPackager.js 里 emitAfterPack 在 doSignAfterPack 之上），
 * 所以跳过与否都不会覆盖正式签名。
 *
 * 用 `PIX_ADHOC_SIGN=1` 可强制走 ad-hoc（调试用）；
 * `PIX_ADHOC_SIGN=0` 则要求必须有证书，没有就构建失败。
 *
 * ## 失败即中断构建（fail-closed）
 *
 * 签名失败若只是打个警告，就会**静默产出**一个"已损坏"的安装包 ——
 * 那正是本次要修的 bug，等于把它原样再发一遍。所以这里签完必须再验一次，
 * 任何一步失败都让构建失败：宁可发不出包，也不要发一个装不上的包。
 */

const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

/** '-' 表示 ad-hoc 签名：不依赖任何证书，也不需要联网找时间戳服务器。 */
const SIGN_IDENTITY = '-'
const CODESIGN_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 用 spawnSync 而不是 execFileSync。
 *
 * 踩过的坑：`codesign -dv` 把信息写在 **stderr** 且返回 0，而 execFileSync
 * 成功时只回 stdout —— 于是解析结果恒为空，后面的校验被静默跳过。改用
 * spawnSync 可以不管退出码都拿到 stdout + stderr。
 */
function codesign(args) {
  const result = spawnSync('codesign', args, { encoding: 'utf8', timeout: CODESIGN_TIMEOUT_MS })
  if (result.error) throw result.error
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` }
}

/**
 * 钥匙串里有没有可用的 Developer ID Application 证书。
 *
 * 用 electron-builder 自己用的同一条命令去问，而不是自己读文件 ——
 * 判定口径必须与它一致，否则会出现"本钩子跳过了、它也没签"的空档，
 * 那产出的就是 0.1.6 那种**连签名都没有**的包，比 ad-hoc 更糟。
 *
 * 返回证书的可读名（用于日志），没有则返回 null。
 */
function detectDeveloperIdIdentity() {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
    timeout: 30 * 1000
  })
  if (result.error) throw result.error
  if (result.status !== 0) return null
  const line = (result.stdout || '')
    .split('\n')
    .find(it => /Developer ID Application/.test(it))
  if (!line) return null
  const quoted = /"([^"]+)"/.exec(line)
  return quoted ? quoted[1] : 'Developer ID Application'
}

async function afterPack(context) {
  // 只管 macOS。Windows / Linux 的打包流程完全不受影响。
  if (context.electronPlatformName !== 'darwin') return

  const productName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${productName}.app`)
  if (!fs.existsSync(appPath)) {
    throw new Error(`[adhoc-sign] 找不到待签名的应用：${appPath}`)
  }

  // ---- 决定该不该兜底 --------------------------------------------------------
  //
  // 判定优先级（高 →低）：
  //   1. PIX_ADHOC_SIGN=1/0 —— 显式指定，用于调试与"必须公证"的发版流程
  //   2. 钥匙串里有 Developer ID Application —— 让 electron-builder 正式签名
  //   3. 都没有 —— 本钩子做 ad-hoc 兜底
  const override = process.env.PIX_ADHOC_SIGN
  if (override != null && override !== '' && override !== '0' && override !== '1') {
    throw new Error(`[adhoc-sign] PIX_ADHOC_SIGN 只能是 0 或 1，收到「${override}」`)
  }

  const developerId = detectDeveloperIdIdentity()

  if (override === '0' && !developerId) {
    throw new Error(
      '[adhoc-sign] PIX_ADHOC_SIGN=0 要求本机存在 Developer ID Application 证书，但钥匙串里没有。\n'
      + '  这是刻意的 fail-closed：发版流程一旦要求公证，就不该在没证书的机器上\n'
      + '  静默产出一个用户装不上的包。'
    )
  }

  const doAdhoc = override === '1' ? true : (override === '0' ? false : !developerId)
  if (!doAdhoc) {
    console.log(`[adhoc-sign] 检测到 Developer ID Application${developerId ? `（${developerId}）` : ''}，`
      + '跳过 ad-hoc —— 交由 electron-builder 正式签名并公证（afterSign 会复核票据）')
    return
  }
  if (developerId) {
    console.log(`[adhoc-sign] 本机有证书（${developerId}），但 PIX_ADHOC_SIGN=1 要求强制走 ad-hoc`)
  }

  console.log(`[adhoc-sign] 对 ${productName}.app 做 ad-hoc 签名（${context.arch}）…`)

  // 内层（Helper / Framework）必须先签，再签外层。--deep 让 codesign 自行按
  // "由内到外"处理；手动逐个签容易漏掉 chrome_crashpad_handler 这类散件。
  const signed = codesign(['--force', '--deep', '--sign', SIGN_IDENTITY, '--timestamp=none', appPath])
  if (signed.status !== 0) {
    throw new Error(`[adhoc-sign] 签名失败（退出码 ${signed.status}）：\n${signed.output}`)
  }

  // 签完**必须**自己验一遍：签名"写进去了"与"校验能过"是两回事，
  // 而用户撞上的恰恰是后者失败。这一步就是把本次事故挡在构建阶段。
  const verified = codesign(['--verify', '--deep', '--strict', appPath])
  if (verified.status !== 0) {
    throw new Error(`[adhoc-sign] 签名校验未通过（退出码 ${verified.status}）：\n${verified.output}`)
  }

  // 再读出落库后的真实身份做断言。上面的 --verify 只看结构是否自洽，
  // 看不出"签的其实还是原始 Electron 身份"这种错 —— 而 0.1.6 正是如此
  // （Identifier=Electron、Info.plist=not bound、Sealed Resources=none）。
  //
  // 注意两种输出格式不一样，别用同一个正则去套：
  //   签名正常：Sealed Resources version=2 rules=13 files=10
  //   没有封印：Sealed Resources=none
  const info = codesign(['-dv', '--verbose=4', appPath]).output
  const pick = key => {
    const match = new RegExp(`^${key}=(.*)$`, 'm').exec(info)
    return match ? match[1].trim() : ''
  }
  const identifier = pick('Identifier')
  const teamIdentifier = pick('TeamIdentifier') || '(未设置，ad-hoc 属正常)'
  const sealedVersion = (/^Sealed Resources version=(\d+)/m.exec(info) || [])[1]
  const sealedNone = /^Sealed Resources=none\s*$/m.test(info)
  const plistEntries = (/^Info\.plist entries=(\d+)/m.exec(info) || [])[1]
  const plistNotBound = /^Info\.plist=not bound\s*$/m.test(info)

  const failures = []
  if (!identifier) failures.push('读不到 Identifier')
  if (identifier === 'Electron') failures.push('签名身份仍是原始的 Electron（未覆盖改造后的 bundle）')
  if (sealedNone || !sealedVersion) failures.push('资源封印缺失（应出现「Sealed Resources version=N」）')
  if (plistNotBound || !plistEntries) failures.push('Info.plist 未被签名覆盖（应出现「Info.plist entries=N」）')
  if (failures.length) {
    throw new Error(`[adhoc-sign] 签名未真正生效，拒绝产出安装包：\n  - ${failures.join('\n  - ')}\n`
      + `完整签名信息：\n${info}`)
  }

  console.log(`[adhoc-sign] 签名完成：identifier=${identifier} teamIdentifier=${teamIdentifier} ` +
    `sealedResources=v${sealedVersion} infoPlistEntries=${plistEntries}`)
}

module.exports = afterPack
// electron-builder 两种解析方式（module.exports 与 .default）都兼容
module.exports.default = afterPack
