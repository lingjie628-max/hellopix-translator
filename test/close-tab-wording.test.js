'use strict'

/**
 * 关闭窗口的确认文案。
 *
 * ## 为什么这个文案值得单独测
 *
 * 2026-10-25 用户贴出弹窗截图问：「重新登陆时登陆哪一种账号？是重新登陆软件
 * 会自动打开吗？还是重新扫码登录打开？」
 *
 * 这说明原文案「需要重新登录才能再次打开」**有歧义**。实际行为是：
 *
 *   · 关掉窗口后再打开 → open-platform.js 用 usedCount 分配**新编号**，
 *     得到**全新分区**，没有 cookie，等于一台新设备 → 只能拿手机**重新扫码**。
 *     点「登录」没用，账号密码没有意义。
 *   · 重启软件 → restoreOneApp 复用 row.partition，登录态**还在**，不用扫码。
 *
 * 两种情况的答案相反，文案却只说"重新登录"，用户自然猜不准。
 * 用户猜到错的那一种（以为重启后要重新登录），就会连软件都不敢关。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')

function read (rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

/** 把源码里的注释剥掉，只看真正会显示给用户的字符串 */
function stripComments (src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
}

const tabsSrc = read('desktop/renderer/tabs.js')
const appSrc = read('desktop/renderer/app.js')

test('★ 关闭确认必须说明"重新扫码"，不能只说"重新登录"', () => {
  const code = stripComments(tabsSrc)
  assert.match(code, /重新扫码/,
    '文案没提"扫码" —— 用户会以为点登录就行，实际只能扫码')
  assert.doesNotMatch(code, /需要重新登录才能再次打开/,
    '旧文案（歧义版）又回来了')
})

test('★ 必须区分"重启软件" —— 那个不需要扫码，否则用户不敢关软件', () => {
  const code = stripComments(tabsSrc)
  assert.match(code, /重启软件不影响/, '没说明重启不丢登录态，用户会连带不敢重启')
})

test('★ 批量关闭（3 处入口）也必须是同一套措辞', () => {
  for (const [name, src] of [['tabs.js', tabsSrc], ['app.js', appSrc]]) {
    const code = stripComments(src)
    assert.doesNotMatch(code, /关闭后需要重新登录才能再次打开/,
      name + ' 里还有旧文案')
  }
  // 批量关闭的两处必须说"重新扫码"
  const batch = stripComments(appSrc)
  assert.match(batch, /重新扫码/, 'app.js 的批量关闭文案没提扫码')
})

test('★ confirm-text 必须允许换行，否则三段文案会挤成一坨', () => {
  const css = read('desktop/renderer/styles.css')
  const block = (css.match(/\.confirm-text\s*\{[\s\S]*?\}/) || [''])[0]
  assert.match(block, /white-space:\s*pre-line/,
    '缺 white-space: pre-line，文案里的 \\n 会被当成空格')
})

test('★ 文案的前提必须成立：关掉再开是新分区（index 只增不减）', () => {
  // 这条锁住文案的**事实基础**。如果哪天有人改了分配逻辑、让关掉的槽位
  // 能复用，文案就变成"骗用户重新扫码"，用户白折腾一次。
  const openSrc = read('desktop/src/window/open-platform.js')
  assert.match(openSrc, /counts\[item\.id\]\s*=\s*Number\(counts\[item\.id\]\s*\|\|\s*0\)\s*\+\s*1/,
    '分配编号的逻辑变了 —— 请重新确认"关掉再开是否还需要扫码"，再同步改文案')

  // 关闭流程里不能出现"把 usedCount 减回去"的写法
  const mainSrc = read('desktop/main.js')
  const closeFn = (mainSrc.match(/function closeTab\s*\(id\)[\s\S]*?\n\}/) || [''])[0]
  assert.ok(closeFn, '找不到 closeTab')
  assert.doesNotMatch(closeFn, /usedCount\[[^\]]*\]\s*=/,
    'closeTab 里居然动了 usedCount —— 槽位会被复用，文案就不对了')
})

test('★ 关闭流程不得清理分区存储（否则"挂起保留登录态"也是假的）', () => {
  const mainSrc = read('desktop/main.js')
  const destroyFn = (mainSrc.match(/function destroyTab\s*\(tab\)[\s\S]*?\n\}/) || [''])[0]
  assert.ok(destroyFn, '找不到 destroyTab')
  assert.doesNotMatch(destroyFn, /clearStorageData\(\s*\{\s*storages:\s*\[[^\]]*cookies/,
    'destroyTab 里清了 cookie —— 那"关掉再开"其实还能保持登录，文案说法要改')
  assert.doesNotMatch(destroyFn, /clearStorageData\(\s*\{\s*storages:\s*\[[^\]]*localstorage/,
    'destroyTab 里清了 localStorage —— 同上')
})
