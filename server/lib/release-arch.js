'use strict'

/**
 * 发布记录的 CPU 架构归一与匹配。
 *
 * ## 为什么需要它
 *
 * 后台「客户端版本」的架构字段是个**自由文本输入框**，占位符还写着
 * 「64位 / Apple 芯片 / 可空」—— 于是同一列里会同时出现 `x64`、`64位`、
 * `Intel 芯片`、`arm64`、`Apple 芯片` 等各种写法。
 *
 * 原来的匹配逻辑靠模糊文本打分：
 *
 *     if ((arch === 'x64' || arch === 'ia32') && /intel|64|32/i.test(String(row.arch)))
 *
 * 它有两个问题：
 *
 *   1. **`x64` 与 `ia32` 得分完全相同**，正则又是 `/intel|64|32/` ——
 *      arch 写着 `x64` 的记录会同时命中 32 位客户端，反之亦然。
 *      也就是说：**32 位客户端会被推送 64 位安装包**，而它根本装不上。
 *   2. 它只是加分项，不参与筛选。一个架构完全不匹配的记录，只要操作系统
 *      对上了就能拿满分被选中。
 *
 * 发错架构的包，用户是**装完打开才发现打不开**的 —— 那时他已经下载了 80MB、
 * 卸载了旧版。所以这里改成**精确匹配**：宁可这次不给更新（用户留在能跑的旧版），
 * 也不要给一个装不上的包。
 *
 * ## 匹配规则
 *
 *   - 发布记录没写架构（空）= 不限架构，任何客户端都能用
 *   - 其余情况**必须归一后完全相等**
 *   - 客户端没报架构时放行（缺字段不能成为"永远收不到更新"的理由）
 *
 * 刻意**不做** x64 → ia32 之类的降级回退：64 位 Windows 确实能跑 32 位程序，
 * 但把一个 x64 客户端悄悄换成 32 位包，内存上限和性能都会变，属于用户没同意的降级。
 * 要发通用包，把架构留空即可。
 */

/** 架构规范值 */
const ARCH = {
  X64: 'x64',
  ARM64: 'arm64',
  IA32: 'ia32'
}

/**
 * 把任意写法归一成规范值，认不出来返回空串。
 *
 * 判断顺序很重要：**必须先判 ARM** —— `arm64` 里含 `64`，
 * 先判 64 位就会把它错认成 x64，而给 Apple 芯片推 x64 包同样是装不上的。
 */
function normalizeArch(raw) {
  const t = String(raw == null ? '' : raw).trim().toLowerCase()
  if (!t) return ''

  // 1) ARM 优先：arm64 / aarch64 / Apple 芯片 / M1..
  if (/arm|apple|aarch/.test(t)) return ARCH.ARM64
  if (/^m[1-9]$/.test(t)) return ARCH.ARM64

  // 2) 明确的 x64 写法（含 x86_64 / x86-64，这两个必须先于裸 x86 判断）
  if (/x64|x86[_-]?64|amd64|intel/.test(t)) return ARCH.X64

  // 3) 32 位写法
  if (/ia32|x86|win32|32/.test(t)) return ARCH.IA32

  // 4) 只剩数字 64 的写法（如 "64位" 去掉"位"之外的形式）
  if (/64/.test(t)) return ARCH.X64

  return ''
}

/**
 * 客户端架构与发布记录架构是否兼容。
 *
 * @param {string} clientArch 客户端上报的 process.arch（win32/darwin/linux 上的 x64/arm64/ia32）
 * @param {string} releaseArch 后台录入的架构（自由文本）
 */
function archCompatible(clientArch, releaseArch) {
  const raw = String(releaseArch == null ? '' : releaseArch).trim()
  // **明确留空** = 不限架构
  if (!raw) return true

  const have = normalizeArch(raw)
  // 写了内容但认不出来 → **不匹配**。
  //
  // 这里刻意选保守方向：把认不出的写法当成"不限架构"的话，
  // 一个笔误（比如把 x64 打成 x46）就会让这个包推给**所有**架构的用户，
  // 而错的那部分人装完才发现打不开 —— 静默且有害。
  // 反过来判成"不匹配"，最坏也只是这次不发更新，是可见、可修的。
  if (!have) return false

  const want = normalizeArch(clientArch)
  // 客户端没报架构：无从判断，放行。
  // 缺一个字段就让用户永远收不到更新，比偶尔放宽更糟。
  if (!want) return true
  return want === have
}

/** 只用于展示：把规范值翻回中文说明 */
function archLabel(arch) {
  const v = normalizeArch(arch)
  if (v === ARCH.X64) return 'x64（Intel/AMD 64 位）'
  if (v === ARCH.ARM64) return 'arm64（Apple 芯片 / ARM 64 位）'
  if (v === ARCH.IA32) return 'ia32（32 位，已停止发布）'
  return '不限架构'
}

module.exports = { ARCH, normalizeArch, archCompatible, archLabel }
