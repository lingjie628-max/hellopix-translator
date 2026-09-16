/**
 * 生产 API 地址的唯一来源。
 *
 * 为什么需要单独一个模块、而不是各处写 process.env：
 *   终端用户双击安装好的客户端时，进程环境是干净的 —— 没有任何 PIX_* 变量。
 *   所以正式域名必须"编译进包"，靠运行时环境变量是不行的。
 *
 * 做法：electron-builder 的 extraMetadata 把 pixPublicUrl 写进**打包后**的
 * package.json；源码里的 package.json 不含这个字段。于是：
 *   - 开发态（npm start）：读不到 → 回落本机后端，不误连生产；
 *   - 发布态（安装包）：读到正式域名，开箱即用；
 *   同一份代码，不需要分叉。
 *
 * 优先级：运行时环境变量（运维排障/临时切线路）> 包内内置值 > 本机开发后端
 */
const DEV_FALLBACK = 'http://127.0.0.1:3000'

function packagedPublicUrl() {
  try {
    const value = require('./package.json').pixPublicUrl
    return typeof value === 'string' ? value.trim() : ''
  } catch (e) {
    return ''
  }
}

const PUBLIC_URL = String(
  process.env.PIX_API || process.env.PIX_PUBLIC_URL || packagedPublicUrl() || DEV_FALLBACK
)
  .trim()
  .replace(/\/+$/, '')

module.exports = { PUBLIC_URL, DEV_FALLBACK }
