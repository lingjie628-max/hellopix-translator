'use strict'

/**
 * 超管总览 `/admin/stats` 的字段契约。
 *
 * ## 起因
 *
 * 超管在总览页看到的是：企业账号 0（明明已把两个商户升成企业）、
 * 翻译售出/通道成本空白、当前通道显示 "-"、
 * 「最近翻译扣费」与「超管操作记录」永远"暂无数据"。
 *
 * 实查下来是**同一个病**：`AdminDashboard.vue` 与 `AdminTranslate.vue` 读的
 * `enterpriseUsers / translateSell / translateCost / activeEngine / packageBill /
 * recentTranslates / recentAudits / fanCount / rechargeCount` 这些字段，
 * **只在 mock 里实现过** —— 真后端 `/admin/stats` 只回了 10 个计数，
 * 其余一个都没有。（库里 audit_logs 有 135 行、translate_logs 有 457 行，
 * 所以那两张表"暂无数据"纯粹是接口没查。）
 *
 * ## 一条必须如实说明的口径
 *
 * `translate_logs.sell_amount` 在 `core-service` 里是**写死的 0**
 * （`VALUES(...,$8,0,...)`）。本系统按套餐整包售卖，不按字符计价 ——
 * 所以「翻译售出」的真值就是 0，那不是取错了列。
 * 真正的钱在「充值金额」（实收 paid_amount）与「通道成本」（cost_amount）。
 * 本文件把这条口径也钉住，防止有人日后"顺手"把它改成别的列。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')

const routes = read('server/routes/production.js')
const dashboard = read('src/components/admin/AdminDashboard.vue')
const mock = read('mock/index.js')

function statsBlock() {
  const at = routes.indexOf("router.get('/admin/stats'")
  assert.ok(at > 0, '找不到 /admin/stats 路由')
  return routes.slice(at, routes.indexOf('\n  }))', at))
}

test('/admin/stats 必须回前端要用的每一个字段', () => {
  const block = statsBlock()

  // 计数类：别名必须能让 mapRow 转成前端读的驼峰名
  for (const [column, field] of [
    ['user_count', 'userCount'],
    ['active_users', 'activeUsers'],
    ['enterprise_users', 'enterpriseUsers'],
    ['sub_count', 'subCount'],
    ['fan_count', 'fanCount'],
    ['short_link_hits', 'shortLinkHits'],
    ['char_balance', 'charBalance'],
    ['char_used', 'charUsed'],
    ['recharge_sum', 'rechargeSum'],
    ['recharge_count', 'rechargeCount'],
    ['translate_cost', 'translateCost'],
    ['translate_sell', 'translateSell'],
    ['recharge_pending', 'rechargePending']
  ]) {
    assert.match(block, new RegExp(`AS ${column}`),
      `缺少 ${column}（前端读 ${field}）。缺了它，那张卡片在生产上永远是空的/0`)
  }

  // 列表与当前通道
  assert.match(block, /recentTranslates:/, '必须回 recentTranslates，否则「最近翻译扣费」永远暂无数据')
  assert.match(block, /recentAudits:/, '必须回 recentAudits，否则「超管操作记录」永远暂无数据')
  assert.match(block, /activeEngine:/, '必须回 activeEngine，否则「当前通道」一直显示 "-"')
  assert.match(block, /packageBill/, '必须回 packageBill（当前通道卡片的副标题）')
  assert.match(block, /grossProfit/, '必须回 grossProfit（「毛利估算」卡片的数值）')
})

test('工单已下线：总览不得再统计 orders', () => {
  const block = statsBlock()
  assert.ok(!/FROM orders/.test(block),
    '工单功能 2026-09-25 已下线、产线 orders 表 0 行，总览不该再统计它 —— '
    + '留着一个恒为 0 的「工单」卡片，只会让人以为显示坏了')
  assert.ok(!/AS order_count/.test(block), '不应再回 order_count')
  assert.ok(!/AS open_orders/.test(block), '不应再回 open_orders')
})

test('企业账号数必须按 users.enterprise 真实统计', () => {
  const block = statsBlock()
  assert.match(block, /count\(\*\) FROM users WHERE enterprise/,
    '「企业账号」必须数 users.enterprise = true 的行。'
    + '超管已经把商户设为「企业」，平台总览就该跟着变')
})

test('进粉统计不得引用不存在的 fans 表', () => {
  const block = statsBlock()
  // 生产库没有 fans 表（只有 order_fans / customers）。
  // 写成 FROM fans 会让整个 /admin/stats 直接 500 —— 那比少一个数字严重得多。
  assert.ok(!/FROM fans\b/.test(block),
    '生产库里没有 fans 表，FROM fans 会让总览整体 500；进粉落在 order_fans 上')
  assert.match(block, /FROM order_fans/, '进粉数应当取 order_fans')
})

test('最近翻译扣费：别名要对齐前端列（cost / sell / direction / createTime）', () => {
  const block = statsBlock()
  for (const alias of ['AS cost', 'AS sell', 'AS direction', 'AS create_time', 'AS engine']) {
    assert.ok(block.includes(alias),
      `最近翻译扣费缺少 ${alias}。前端那几列直接读这些名字，别名错了就是整列空白`)
  }
  assert.match(block, /JOIN users u ON u\.id=t\.user_id/, '要带上商户名（前端第一列就是商户）')
})

test('超管操作记录：别名要对齐前端列（admin / action / detail / createTime）', () => {
  const block = statsBlock()
  assert.match(block, /actor AS admin/, '前端「账号」列读 admin，必须把 audit_logs.actor 起别名')
  assert.match(block, /COALESCE\(detail->>'message',''\) AS detail/,
    '人类可读的对象名存在 detail->>\'message\' 里（见 repo.audit），「对象」列要取它')
  assert.match(block, /AS create_time/, '「时间」列读 createTime')
})

test('金额小数位要收住，否则界面会印出 0.047575 这种长串', () => {
  const block = statsBlock()
  assert.match(block, /ROUND\(COALESCE\(sum\(cost_amount\),0\),4\)/,
    '成本按 4 位小数收口 —— numeric 原样返回会是 0.047575')
  assert.match(block, /ROUND\(COALESCE\(sum\(paid_amount\),0\),2\)/, '充值金额按 2 位小数收口')
})

test('套餐文案的币种必须跟「价格货币」一致，不能写死 ¥', () => {
  const block = statsBlock()
  assert.match(block, /settingOf\(settings, 'billing\.currency'/, '套餐文案要读后台的币种设置')
  assert.ok(!/packageBill[\s\S]{0,200}?¥/.test(block),
    'packageBill 里不得写死 ¥：生产币种是 USD，会出现"套餐 ¥200"与"$35.685"并排的错位')
})

test('「翻译售出」的口径必须如实留在代码里（sell_amount 恒为 0）', () => {
  const block = statsBlock()
  assert.match(block, /AS translate_sell/, '「翻译售出」取 translate_logs.sell_amount')
  assert.match(routes, /sell_amount/,
    '口径说明必须留在 /admin/stats 的注释里：本系统按套餐整包售卖，sell_amount 写死为 0')

  // 真实写入点：core-service 里 sell_amount 就是常量 0
  const core = read('server/services/core-service.js')
  assert.match(core, /source_hash,snippet,cached,duration_ms,trigger\)\s*\n?\s*VALUES\([^)]*,0,/,
    'core-service 写入 translate_logs 时 sell_amount 就是常量 0 —— '
    + '若这里改成真实计价，请同步更新 /admin/stats 的口径说明与总览文案')
})

test('前端总览读的字段必须与后端返回一一对应', () => {
  for (const field of ['enterpriseUsers', 'grossProfit', 'translateCost',
    'activeEngine', 'packageBill', 'recentTranslates', 'recentAudits',
    'fanCount', 'shortLinkHits', 'rechargeCount', 'rechargePending', 'subCount']) {
    assert.ok(dashboard.includes(`s.${field}`) || dashboard.includes(`stats.${field}`),
      `AdminDashboard 没有读 ${field} —— 后端补了字段前端却没接上`)
  }
})

test('工单必须从界面彻底移除（卡片 / 侧栏 / 商户列 / 路由 / 页面）', () => {
  // 卡片：总览不该再有「工单」
  assert.ok(!/'工单'/.test(dashboard),
    '总览仍然有「工单」卡片 —— 它是恒为 0 的死数据')
  assert.ok(!/orderCount|openOrders/.test(dashboard), '总览不该再读 orderCount / openOrders')

  // 商户列表：不该再有「工单」列
  const usersVue = read('src/components/admin/AdminUsers.vue')
  assert.ok(!/prop="orderCount"/.test(usersVue), '商户列表仍保留「工单」列')

  // 侧栏：不该再有「全部工单」入口
  const layout = read('src/components/admin/AdminLayout.vue')
  assert.ok(!/\/admin\/orders/.test(layout), '侧栏仍有「全部工单」入口')

  // 路由与页面文件
  const router = read('src/router/index.js')
  assert.ok(!/AdminOrders/.test(router), '路由仍在 import / 注册 AdminOrders')
  assert.ok(!/\/admin\/orders/.test(router), '路由表里仍有 /admin/orders')
  assert.ok(!fs.existsSync(path.join(root, 'src/components/admin/AdminOrders.vue')),
    'AdminOrders.vue 应当已删除')

  // 真后端不该再提供工单读写接口
  assert.ok(!/router\.(get|post)\('\/admin\/orders/.test(routes),
    '真后端仍有 /admin/orders 接口 —— 没有创建入口的表不该有读写界面')
})

test('mock 与真后端在总览字段上保持一致', () => {
  for (const field of ['enterpriseUsers', 'grossProfit', 'translateCost',
    'activeEngine', 'packageBill', 'recentAudits', 'recentTranslates', 'fanCount',
    'rechargePending']) {
    assert.ok(mock.includes(field), `mock 的 /admin/stats 缺少 ${field}`)
  }
  // 工单在 mock 里也要一起消失，否则本地开发看到的与生产不一致。
  // 只匹配"作为字段返回"的写法，避免误伤解释性注释。
  assert.ok(!/orderCount\s*:/.test(mock), 'mock 仍在返回 orderCount 字段')
  assert.ok(!/app\.(get|post)\('\/apis\/admin\/orders/.test(mock),
    'mock 仍有 /apis/admin/orders 路由 —— 与真后端不一致')

  // 精确切出 packageBillText 的 return 语句再检查币种符号。
  // 只切函数体会误伤注释里"原先是写死的 ¥"这类说明文字。
  const at = mock.indexOf('function packageBillText()')
  assert.ok(at > 0, '找不到 mock 的 packageBillText()')
  const body = mock.slice(at, mock.indexOf('\n  }', at))
  const ret = (body.match(/return[^\n]*/) || [])[0] || ''
  assert.ok(ret.includes('$'), 'mock 的套餐文案应当用 $ 拼币种符号')
  assert.ok(!ret.includes('¥'),
    'mock 的套餐文案不得写死 ¥：mock 的币种符号是 $，'
    + '写死 ¥ 会让本地看到"套餐 ¥200"、生产看到"套餐 $200"')
})
