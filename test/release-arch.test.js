'use strict'

/**
 * 客户端更新 · 架构匹配守卫。
 *
 * ## 被修的缺陷
 *
 * 后台「客户端版本」的架构字段是自由文本，占位符还写着「64位 / Apple 芯片 / 可空」，
 * 于是库里会同时出现 `x64`、`64位`、`Intel 芯片` 等写法。而服务端的匹配逻辑是：
 *
 *     if ((arch === 'x64' || arch === 'ia32') && /intel|64|32/i.test(String(row.arch)))
 *
 * 两个问题：
 *   1. `x64` 与 `ia32` 得分完全相同，正则 `/intel|64|32/` 又同时匹配 "64" 和 "32"，
 *      于是 **32 位客户端会被推送 64 位安装包** —— 装不上。
 *   2. 它只是加分项，不参与筛选：架构完全不匹配的记录，只要系统对上了就能被选中。
 *
 * 发错架构的包，用户是**下载 80MB、卸载旧版、打开才发现打不开**的。
 * 所以现在架构是筛选条件，不匹配就不发。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { ARCH, normalizeArch, archCompatible, archLabel } = require('../server/lib/release-arch')

const root = path.join(__dirname, '..')

// ------------------------------------------------------------------ 归一化

test('归一化：x64 的各种写法都收敛到同一个值', () => {
  for (const raw of ['x64', 'X64', ' x64 ', '64位', '64', 'Intel 芯片', 'intel', 'amd64', 'x86_64', 'x86-64']) {
    assert.equal(normalizeArch(raw), ARCH.X64, JSON.stringify(raw))
  }
})

test('归一化：arm64 的各种写法都收敛到同一个值', () => {
  for (const raw of ['arm64', 'ARM64', 'Apple 芯片', 'apple', 'aarch64', 'M1', 'M2', 'm4']) {
    assert.equal(normalizeArch(raw), ARCH.ARM64, JSON.stringify(raw))
  }
})

test('归一化：32 位写法收敛到 ia32', () => {
  for (const raw of ['ia32', '32位', 'x86', 'win32']) {
    assert.equal(normalizeArch(raw), ARCH.IA32, JSON.stringify(raw))
  }
})

test('★ arm64 不能被 "64" 抢走（顺序敏感）', () => {
  // 如果先判 64 位，arm64 会被归成 x64 —— 给 Apple 芯片推 x64 包，同样装不上。
  assert.equal(normalizeArch('arm64'), ARCH.ARM64)
  assert.equal(normalizeArch('ARM64'), ARCH.ARM64)
  assert.equal(normalizeArch('aarch64'), ARCH.ARM64)
  // 反向确认 x86_64 仍归 x64，没被裸 x86 抢走
  assert.equal(normalizeArch('x86_64'), ARCH.X64)
  assert.equal(normalizeArch('x86-64'), ARCH.X64)
})

test('归一化：空值表示不限架构', () => {
  for (const raw of ['', '   ', null, undefined]) {
    assert.equal(normalizeArch(raw), '')
  }
})

// ------------------------------------------------------------------ 兼容性

test('★ 32 位客户端不会匹配到 64 位包（这就是修掉的 bug）', () => {
  assert.equal(archCompatible('ia32', 'x64'), false, '32 位客户端绝不能被推 x64 包')
  assert.equal(archCompatible('ia32', '64位'), false)
  assert.equal(archCompatible('ia32', 'Intel 芯片'), false)
})

test('★ 64 位客户端不会匹配到 32 位包（反向同样要挡住）', () => {
  assert.equal(archCompatible('x64', 'ia32'), false)
  assert.equal(archCompatible('x64', '32位'), false)
})

test('arm64 与 x64 互不匹配（Windows on ARM 能模拟 x64，但不该悄悄换包）', () => {
  assert.equal(archCompatible('arm64', 'x64'), false)
  assert.equal(archCompatible('x64', 'arm64'), false)
  assert.equal(archCompatible('arm64', 'Apple 芯片'), true)
})

test('同架构的各种写法互通（历史自由文本不会导致漏发）', () => {
  assert.equal(archCompatible('x64', '64位'), true)
  assert.equal(archCompatible('x64', 'Intel 芯片'), true)
  assert.equal(archCompatible('x64', 'x86_64'), true)
  assert.equal(archCompatible('ia32', '32位'), true)
  assert.equal(archCompatible('ia32', 'x86'), true)
})

test('留空 = 不限架构，任何客户端都能用', () => {
  for (const client of ['x64', 'arm64', 'ia32']) {
    assert.equal(archCompatible(client, ''), true, client)
    assert.equal(archCompatible(client, null), true, client)
  }
})

test('★ 填了但认不出来 → 不匹配（保守方向，防止一个笔误推给所有人）', () => {
  // 把认不出的写法当成"不限架构"的话，把 x64 打成 x46 就会让这个包
  // 推给所有架构的用户，而错的那部分人装完才发现打不开 —— 静默且有害。
  assert.equal(archCompatible('x64', 'x46'), false)
  assert.equal(archCompatible('x64', 'garbage'), false)
  assert.equal(archCompatible('arm64', '??'), false)
})

test('客户端没报架构时放行（缺字段不该让用户永远收不到更新）', () => {
  assert.equal(archCompatible('', 'x64'), true)
  assert.equal(archCompatible(undefined, 'arm64'), true)
})

test('archLabel 对无法识别的值给出明确提示，而不是假装正常', () => {
  assert.match(archLabel('x64'), /x64/)
  assert.match(archLabel('Apple 芯片'), /arm64/)
  assert.match(archLabel(''), /不限/)
  assert.match(archLabel('x46'), /无法识别|不限/, '认不出的值必须显式提示')
})

// ---------------------------------------------------------------- 接线守卫

test('findUpdate 用 archCompatible 做筛选，不再用模糊正则打分', () => {
  const source = fs.readFileSync(path.join(root, 'server/services/core-service.js'), 'utf8')
  const at = source.indexOf('async findUpdate(')
  assert.ok(at > 0, '找不到 findUpdate')
  const block = source.slice(at, source.indexOf('async listClientReleases(', at))

  assert.match(block, /archCompatible\(arch, row\.arch\)/, '没有用 archCompatible 筛选')
  assert.doesNotMatch(block, /intel\|64\|32/i,
    '旧的模糊正则又回来了 —— 它会让 32 位客户端匹配到 64 位包')
  assert.doesNotMatch(block, /arch === 'x64' \|\| arch === 'ia32'/,
    'x64 与 ia32 不能被同等对待')
})

test('找不到匹配架构的版本时，不返回任何下载地址', () => {
  const source = fs.readFileSync(path.join(root, 'server/services/core-service.js'), 'utf8')
  const at = source.indexOf('async findUpdate(')
  const block = source.slice(at, source.indexOf('async listClientReleases(', at))

  assert.match(block, /const archBlocked = /, '缺少架构不匹配的判定')
  assert.match(block, /url: row\.url \|\| \(app \|\| archBlocked \? '' :/,
    '架构不匹配时必须把 url 置空 —— 兜底地址指向的同样是不匹配的包')
  assert.match(block, /compatible: !archBlocked/, '缺少 compatible 字段')
  assert.match(block, /reason/, '缺少 reason，客户端无法区分"没有新版本"和"架构不匹配"')
})

test('后台架构字段是下拉，不再是可以随便输的自由文本', () => {
  const vue = fs.readFileSync(path.join(root, 'src/components/admin/AdminClients.vue'), 'utf8')
  assert.doesNotMatch(vue, /v-model="form\.arch"[^>]*><\/el-input>/, '架构又变回自由文本输入框了')
  assert.match(vue, /<el-select v-model="form\.arch"/, '架构应当是下拉选择')
  assert.match(vue, /value="x64"/, '缺少 x64 选项')
  assert.match(vue, /value="arm64"/, '缺少 arm64 选项')
  // 选项值必须是规范值，不能是"64位"这种展示文案
  assert.doesNotMatch(vue, /value="64位"/, '选项值不能是展示文案')
})

test('前端 archLabel 的判断顺序与服务端一致（ARM 优先）', () => {
  const vue = fs.readFileSync(path.join(root, 'src/components/admin/AdminClients.vue'), 'utf8')
  const at = vue.indexOf('archLabel(raw)')
  const block = vue.slice(at, at + 700)
  const armAt = block.indexOf('/arm|apple|aarch/')
  const x64At = block.indexOf('/x64|x86[_-]?64|amd64|intel/')
  assert.ok(armAt > 0 && x64At > 0, 'archLabel 缺少两类判断')
  assert.ok(armAt < x64At, 'ARM 必须先判，否则 arm64 会被 "64" 抢成 x64')
})

test('没有硬编码 32 位构建（Electron v44 起不再发布 ia32）', () => {
  // Electron 官方 Breaking Changes：v44+ 只发布 64 位平台，
  // v43 系列 2027 年 1 月 EOL 后 32 位彻底停止支持。
  // 再加 ia32 构建等于给未来埋一个必须回滚的坑。
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'))
  const winTargets = pkg.build.win.target
  for (const t of winTargets) {
    assert.ok(!t.arch.includes('ia32'), `Windows ${t.target} 不该构建 ia32`)
  }
  assert.ok(winTargets.some(t => t.arch.includes('x64')), 'Windows 必须有 x64 构建')
})
