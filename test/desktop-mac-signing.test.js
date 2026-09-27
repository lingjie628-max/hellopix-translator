'use strict'

/**
 * 钉住 macOS 签名的配置不变量。
 *
 * ## 为什么需要
 *
 * 这些配置项有个共同特点：**写错了不会报错，只会静默降级**。最典型的是
 * `mac.identity: null` —— electron-builder 在 `sign()` 里遇到它就**直接 return**，
 * 而 `notarizeIfProvided()` 排在那之后。也就是说这三个字会让**公证永远不可能发生**，
 * 但构建照样成功、日志里只是一条不显眼的 warning。
 *
 * 我们已经在 0.1.6 上吃过一次「静默产出装不上的包」的亏（见
 * docs/macOS安装包签名与已损坏问题.md）。当时也是"配置看起来没问题、构建成功、
 * 用户装不上"。所以这里把几个必须有、且能纯静态校验的前提钉死：
 * 谁要是改回去，CI 当场红，而不是等用户来投诉。
 *
 * 这些都是纯读配置文件的检查 —— 不需要 macOS、不需要证书、不需要跑构建，
 * 因此在任何 CI 环境都能跑。
 */

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const DESKTOP = path.join(__dirname, '..', 'desktop')
const buildConfig = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8')).build
const mac = buildConfig.mac

test('mac 配置：identity 不得写死为 null（那会让公证永远不可能发生）', () => {
  assert.notEqual(
    mac.identity,
    null,
    'identity: null 会让 electron-builder 在 sign() 里直接 return，'
    + '而公证排在它之后 —— 公证将永远不被尝试，且构建不会失败。'
    + '要自动发现证书就删掉这个字段，不要写 null。'
  )
})

test('mac 配置：hardenedRuntime 必须开启（公证的硬性前提）', () => {
  assert.equal(
    mac.hardenedRuntime,
    true,
    '公证要求 hardened runtime。关掉它，公证必然被 Apple 拒绝。'
  )
})

test('mac 配置：notarize 不得被显式关闭', () => {
  assert.notEqual(
    mac.notarize,
    false,
    'notarize: false 会跳过公证，用户仍会看到「无法验证开发者」。'
  )
})

test('mac 配置：entitlements 文件存在，且含 Electron 必需的三条', () => {
  assert.ok(mac.entitlements, '必须指定 entitlements 文件')
  const file = path.join(DESKTOP, mac.entitlements)
  assert.ok(fs.existsSync(file), `entitlements 文件不存在：${mac.entitlements}`)

  const plist = fs.readFileSync(file, 'utf8')
  // 逐条断言而不是"非空即可"：少任何一条的后果都不同且都不轻 ——
  // 缺 allow-jit 是 arm64 上启动即崩，缺 disable-library-validation 是公证失败。
  const required = [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation'
  ]
  for (const key of required) {
    assert.ok(plist.includes(key), `entitlements 缺少必需项：${key}`)
  }

  // 嵌套二进制（Helper / Framework）也要用同一份，否则它们没有这些豁免。
  assert.equal(
    mac.entitlementsInherit,
    mac.entitlements,
    'entitlementsInherit 应与 entitlements 指向同一份，'
    + '否则 Helper / Framework 拿不到必需的豁免。'
  )
})

test('mac 构建：两个签名钩子都必须注册', () => {
  assert.equal(buildConfig.afterPack, 'scripts/after-pack.js',
    'afterPack 是 ad-hoc 兜底与"已损坏"结构断言的落点，不能摘掉')
  assert.equal(buildConfig.afterSign, 'scripts/after-sign.js',
    'afterSign 是公证复核（fail-closed）的唯一落点，不能摘掉')

  // 钩子文件真的在，且导出了函数 —— 只写路径不写文件会静默不执行。
  for (const rel of [buildConfig.afterPack, buildConfig.afterSign]) {
    const file = path.join(DESKTOP, rel)
    assert.ok(fs.existsSync(file), `钩子文件不存在：${rel}`)
    const mod = require(file)
    assert.equal(typeof mod, 'function', `${rel} 必须导出函数`)
  }
})

test('after-pack：必须能识别 Developer ID 证书，否则会覆盖正式签名并破坏公证', () => {
  const source = fs.readFileSync(path.join(DESKTOP, buildConfig.afterPack), 'utf8')
  // 有证书时必须让位：ad-hoc 签名用的是 --timestamp=none，而公证要求安全时间戳。
  assert.match(source, /Developer ID Application/,
    'after-pack 必须检测 Developer ID 证书并在存在时跳过 ad-hoc 签名')
  assert.match(source, /security['"\]]?, ?\[?'find-identity/,
    '必须用 electron-builder 同一条 security find-identity 命令判定，口径不一致会留下"两边都没签"的空档')
})

test('after-sign：必须守住"配了公证凭据却没钉上票据"这一路', () => {
  const source = fs.readFileSync(path.join(DESKTOP, buildConfig.afterSign), 'utf8')
  assert.match(source, /stapler/, 'after-sign 必须用 stapler validate 核实票据')
  assert.match(source, /APPLE_API_KEY|APPLE_APP_SPECIFIC_PASSWORD|APPLE_KEYCHAIN_PROFILE/,
    '必须识别 electron-builder 支持的三套公证凭据')
  assert.match(source, /PIX_REQUIRE_NOTARIZED/,
    '必须支持"要求公证"的开关，使发版时未公证的构建直接失败')
})

test('发版脚本必须带 PIX_REQUIRE_NOTARIZED=1', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8')).scripts
  const release = scripts['pack:mac:release']
  assert.ok(release, '必须有 pack:mac:release 这个发版脚本')
  assert.match(
    release,
    /PIX_REQUIRE_NOTARIZED=1/,
    '发版脚本必须要求公证 —— 否则一条命令就能发出"签了名但没公证"的包，'
    + '而用户在 macOS 上照样看到「无法验证开发者」。'
  )
})
