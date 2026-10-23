'use strict'

/**
 * 把服务端 `/client/update` 的响应变成「可以放心交给用户下载」的结果。
 *
 * ## 为什么单独一层，而不是塞进 ipc/app.js
 *
 * ipc 那层已经在做两件事（拿响应、过域名白名单），再塞签名校验会让
 * 一个函数里混着三种失败语义。拆出来后：
 *
 *   · `hardened`  —— 服务端带了签名清单，验签通过
 *   · `legacy`    —— 服务端还没升级，只做白名单（**降级模式**）
 *   · `rejected`  —— 带了清单但签名/哈希/版本不对，一律不给下载地址
 *
 * 三种结果分开，是因为它们的处置完全不同：legacy 可以继续用但要在日志里
 * 留痕（说明服务端还没升级），rejected 则必须彻底阻断并告警。
 *
 * ## 为什么允许 legacy 降级
 *
 * 如果新版客户端一上线就硬性要求签名，那么服务端发布脚本没跟上时，
 * **所有用户会同时失去更新能力**，而且他们手里的版本没有修复能力 ——
 * 只能让用户手动重装。降级模式给了灰度空间。
 *
 * 但降级必须是**可关闭**的：`PIX_REQUIRE_SIGNED_UPDATE=1` 时 legacy 也拒绝。
 * 全部客户端与服务端升级到位后打开它，才真正闭环。
 *
 * ## 降级模式下的域名白名单仍然生效
 *
 * 降级不等于什么都放行 —— 白名单检查由调用方照做（见 ipc/app.js）。
 * 这里只负责「清单本身可信吗」。
 */

const {
  manifestPayload,
  verifySignature,
  compareVersions
} = require('./signature')
const { PUBLIC_KEYS } = require('./trusted-keys')

/** 服务端把清单放在这几个字段之一都可以，取第一个非空对象。 */
function extractManifest (data) {
  if (!data || typeof data !== 'object') return null
  const candidates = [data.manifest, data.obj && data.obj.manifest, data.signedManifest]
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && candidate.signature) return candidate
  }
  return null
}

/**
 * 校验签名清单，返回规范化的发布信息。
 * 任何一步失败都抛错 —— 调用方负责把它变成「不给下载地址」。
 */
function validateManifest (manifest, options) {
  const appId = String(options.appId || '')
  const currentVersion = String(options.currentVersion || '')
  const expectedChannel = String(options.channel || 'stable')

  for (const field of ['appId', 'version', 'url', 'sha256', 'signature']) {
    if (!String(manifest[field] || '').trim()) throw new Error(`更新清单缺少 ${field}`)
  }

  // 先验签：在此之前不看任何业务字段，避免成为信息泄露 oracle
  verifySignature(manifestPayload(manifest), manifest.signature, options.publicKeys || PUBLIC_KEYS)

  // ---- 以下是策略判断，签名已经保证这些字段没被改过 ----

  if (manifest.appId !== appId) {
    // 同一作者的另一个产品签出的合法清单，不能拿来给这个产品推包
    throw new Error(`更新清单属于其他应用（${manifest.appId}）`)
  }
  if (manifest.channel && manifest.channel !== expectedChannel) {
    throw new Error(`更新通道不匹配：期望 ${expectedChannel}`)
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(manifest.version))) {
    throw new Error('更新清单版本号格式无效')
  }
  if (!/^[a-f0-9]{64}$/i.test(String(manifest.sha256))) {
    throw new Error('更新清单 sha256 格式无效')
  }

  // 防降级：签名只能证明「这是官方发的」，证明不了「它比现在新」。
  // 攻击者可以重放一份旧的、签名合法的清单，把用户拉回有已知漏洞的版本。
  const floor = String(manifest.minVersion || '0.0.0')
  if (compareVersions(String(manifest.version), floor) < 0) {
    throw new Error('更新清单版本低于其自身声明的下限')
  }
  // 已经比当前版本旧的清单直接丢掉，不给用户「降级按钮」
  if (compareVersions(String(manifest.version), currentVersion) < 0) {
    throw new Error(`拒绝降级：清单版本 ${manifest.version} 低于当前 ${currentVersion}`)
  }

  return {
    version: String(manifest.version),
    url: String(manifest.url),
    sha256: String(manifest.sha256).toLowerCase(),
    channel: String(manifest.channel || expectedChannel),
    minVersion: floor,
    title: String(manifest.title || manifest.version)
  }
}

/**
 * 主入口。
 *
 * @param {object} data     服务端响应体
 * @param {object} options  { appId, currentVersion, channel, allowLegacy, logger, env }
 * @returns {{status: 'hardened'|'legacy'|'rejected', remote, url, sha256, reason}}
 */
function resolveRelease (data, options) {
  const opts = options || {}
  const logger = opts.logger || (() => {})
  const manifest = extractManifest(data)

  // 严格开关：设了 `PIX_REQUIRE_SIGNED_UPDATE=1` 就不许降级。
  //
  // 原本这条只写在文件头注释里，代码里根本没有 —— 运维以为设了环境变量
  // 就锁死了，实际上 legacy 照走。现在真的接上。
  // 读取时机放在调用时而不是模块加载时：测试和运维都可能中途改，
  // 而且 Electron 里 env 在 app 启动后仍有被覆盖的场合。
  const env = opts.env || process.env
  const requireSigned = String(env.PIX_REQUIRE_SIGNED_UPDATE || '') === '1'
  const allowLegacy = !!opts.allowLegacy && !requireSigned

  if (!manifest) {
    if (!allowLegacy) {
      // ★ remote 必须保留 ★
      //
      // 这里原来写 `remote: ''`，结果是：服务端没升级（没有签名清单）时，
      // 客户端拿到空 remote，渲染层按 `remote > local` 判断 → 显示"当前已是最新"。
      // 但用户手上确实不是最新版 —— 界面等于在骗他，而且骗得毫无痕迹。
      //
      // 正确语义：**有新版、但不可下载**（没签名不敢装）。渲染层对
      // "remote 有值、url 为空" 已有专门的提示，走那条分支才对。
      return {
        status: 'rejected',
        remote: legacyRemoteOf(data),
        url: '',
        sha256: '',
        reason: '服务端未提供签名清单，已按配置拒绝更新'
      }
    }
    // 降级：没清单就沿用旧字段。留痕，便于确认服务端还有多少没升级。
    const remote = String((data && (data.version || (data.obj && data.obj.version))) || '')
    const url = String((data && (data.url || (data.obj && data.obj.url))) || '')
    if (remote) logger('warn', 'update', `服务端未提供签名清单，降级为白名单模式：${remote}`)
    return {
      status: 'legacy',
      remote,
      url,
      sha256: '',
      reason: remote ? '' : '暂无可用版本'
    }
  }

  try {
    const release = validateManifest(manifest, {
      appId: opts.appId,
      currentVersion: opts.currentVersion,
      channel: opts.channel,
      publicKeys: opts.publicKeys
    })
    return {
      status: 'hardened',
      remote: release.version,
      url: release.url,
      sha256: release.sha256,
      reason: ''
    }
  } catch (error) {
    // 带了清单却验不过：这不是「没有更新」，是**有人在改更新通道**。
    // 必须单独告警，不能和「网络失败」混在一起。
    //
    // remote 同样要保留（理由见上面没清单那一段）：验签失败不代表
    // 没有新版本，只代表**这个版本不敢装**。界面要能说清"有新版但不可下载"。
    logger('error', 'update', '更新清单校验失败：' + error.message)
    return {
      status: 'rejected',
      remote: legacyRemoteOf(data),
      url: '',
      sha256: '',
      reason: error.message
    }
  }
}

/**
 * 从服务端响应里尽力抠出「远端版本号」。
 *
 * 服务端有两种形状：扁平（`{version}`）和嵌套（`{obj:{version}}`）。
 * 验签失败 / 缺清单时我们仍然想把版本号显示给用户，所以这两种都要认。
 * 拿不到就返回空串 —— 界面按"未知"处理，而不是编一个版本号出来。
 */
function legacyRemoteOf (data) {
  if (!data) return ''
  const flat = data.version || (data.obj && data.obj.version)
  return String(flat || '').trim()
}

module.exports = {
  extractManifest,
  validateManifest,
  resolveRelease
}
