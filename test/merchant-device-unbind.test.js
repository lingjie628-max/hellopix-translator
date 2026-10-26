'use strict'

/**
 * 商户端（主账号）自己解绑子账号绑定的电脑
 *
 * ## 为什么要有这条
 *
 * 子账号首次登录会把当前电脑写进 bound_device，之后换机器登录被
 * 409 DEVICE_BOUND 挡住。原先这个能力：
 *   · 商户端 `/team/device/reset` **接口早就有**，但界面上没有任何入口；
 *   · 超管后台那个按钮叫「踢下线」，按"解绑"字面搜不到。
 * 两边都找不到 → 每次换电脑都得找客服 → 客服也找不到。
 *
 * ## 这条测试守三件事
 *
 *   1. 商户端列表必须返回 `bound`（否则界面判断不了该不该显示解绑）
 *   2. 界面必须有「解绑电脑」入口，且只在已绑定时出现
 *   3. **越权**：主账号只能解绑自己名下的子账号 —— 这条最重要，
 *      接口一旦漏了归属校验，任何商户都能把别人家的子账号踢下线
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')

const production = read('server/routes/production.js')
const teamVue = read('src/components/user/UserTeam.vue')

function routeBlock (src, signature) {
  const at = src.indexOf(signature)
  assert.ok(at > 0, '找不到路由：' + signature)
  // 取到该 router.X(...) 调用的收尾
  const end = src.indexOf('}))', at)
  return src.slice(at, end > 0 ? end + 3 : src.length)
}

test('★ 越权防线：主账号只能解绑自己名下的子账号', () => {
  const block = routeBlock(production, "router.post('/team/device/reset'")

  // 必须按 parent_id 校验归属，且排除已删除
  assert.match(block, /parent_id=\$2/,
    '解绑接口必须校验 parent_id —— 否则任何主账号都能传别人的子账号 id，把人家踢下线')
  assert.match(block, /deleted_at IS NULL/,
    '归属校验要排除已软删除的子账号')

  // 越权时必须是 404（不是 403/200）—— 不泄露"这个 id 存在"
  assert.match(block, /SUB_NOT_FOUND/,
    '越权解绑必须回 SUB_NOT_FOUND（404），不能回成功')

  // 子账号身份传 id 也不能越权：只解绑自己
  assert.match(block, /req\.pixUser\.kind === 'main'/,
    '只有主账号才能按 id 指定子账号；子账号身份必须只作用于自己')
})

test('解绑必须同时清 bound_device 与撤销会话', () => {
  const block = routeBlock(production, "router.post('/team/device/reset'")
  assert.match(block, /bound_device=''/, '必须清掉 bound_device')
  assert.match(block, /revokeUser/, '必须撤销在线会话 —— 只清字段的话对方仍在线')
})

test('★ /team/subs 必须返回 bound（前端据此决定显示不解绑按钮）', () => {
  const block = routeBlock(production, "router.get('/team/subs'")
  assert.match(block, /bound:/,
    '/team/subs 没有产出 bound —— 商户端「电脑」列与解绑入口都判断不了。'
    + 'repo.list 只做驼峰化（boundDevice），不会产生 bound')
  assert.match(block, /row\.boundDevice/,
    'bound 必须由 boundDevice 推导，不能写死')
})

test('★ 商户端界面有「解绑电脑」入口，且仅在已绑定时显示', () => {
  assert.match(teamVue, /解绑电脑/,
    '商户端缺少「解绑电脑」按钮 —— 换电脑只能找客服')

  // 只在已绑定时出现
  assert.match(teamVue, /v-if="scope\.row\.bound"[\s\S]{0,120}解绑电脑/,
    '「解绑电脑」应仅在 row.bound 为真时显示（没绑定时这个动作没有意义）')

  // 必须打到正确的接口
  assert.match(teamVue, /postRequest\('\/team\/device\/reset'/,
    '解绑按钮必须调用 /team/device/reset')

  // 必须带 id 并且是 row 自己的 id（不能漏传导致解绑自己）
  assert.match(teamVue, /resetDevice\s*\(row\)[\s\S]{0,400}\{\s*id:\s*row\.id\s*\}/,
    '解绑请求必须带上 row.id，漏传会退化成"解绑主账号自己"')
})

test('商户端必须如实告知：解绑会把对方踢下线', () => {
  // 二次确认里要说明后果，否则商户点一下员工就掉线，不知道发生了什么
  assert.match(teamVue, /resetDevice\s*\(row\)\s*\{/,
    '缺少 resetDevice 方法')
  const at = teamVue.indexOf('resetDevice(row)')
  const block = teamVue.slice(at, teamVue.indexOf('batch(status)', at) + 20)
  assert.match(block, /\$confirm/,
    '解绑必须二次确认')
  assert.match(block, /下线/,
    '确认文案必须说明"当前已登录的设备会下线"')
})

test('电脑状态列必须有真实判据（不能像后台那样恒显示未绑定）', () => {
  assert.match(teamVue, /已绑定[\s\S]{0,40}未绑定/,
    '缺少「已绑定/未绑定」状态展示')
  assert.match(teamVue, /scope\.row\.bound/, '状态列必须读 row.bound')
})
