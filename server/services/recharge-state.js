'use strict'

/**
 * 充值订单状态机。
 *
 * ## 状态图
 *
 * ```
 *   pending(0) ──结算成功──→ paid(1)         终态
 *       │
 *       ├──30 分钟未付────→ expired(2)       终态
 *       ├──用户/超管取消───→ cancelled(3)     终态
 *       └──无法自动判定───→ exception(4) ──人工──→ paid(1)
 *                                        └──────→ cancelled(3)
 * ```
 *
 * ## 三条设计原则
 *
 * 1. **paid / expired / cancelled 不可逆。**
 *    一笔已入账的订单不会被改回未支付；一张已过期的订单也不会被"复活"。
 *    过期之后收到的钱走异常池，而不是把历史改写成没发生过 ——
 *    「它曾经过期」本身是对账时的重要事实。
 *
 * 2. **exception 不是终态。**
 *    异常是「需要人看一眼」的中间态，最终必须落到 paid 或 cancelled。
 *    允许它悬着，等于让钱和字符的归属永远没有结论。
 *
 * 3. **终态订单收到迟到款，不改订单状态。**
 *    只在 recharge_exceptions 里记一条。把 expired 改成 exception
 *    会抹掉过期事实，反而说不清。
 *
 * ## 与数据库约束的关系
 *
 * 这里的状态转移表是**业务规则**；数据库侧另有一条
 * `recharges_terminal_consistency_check` 保证「非 pending 必须有终态时间」。
 * 两者互补：前者防非法流转，后者防"状态改了但忘了写终态字段"的半截更新。
 */

const { ApiError } = require('../lib/http')

const STATUS = Object.freeze({
  PENDING: 0,
  PAID: 1,
  EXPIRED: 2,
  CANCELLED: 3,
  EXCEPTION: 4
})

const STATUS_TEXT = Object.freeze({
  0: '待支付',
  1: '已支付',
  2: '已过期',
  3: '已取消',
  4: '异常待处理'
})

/** 不可逆终态。到这里的订单不会再变。 */
const TERMINAL_STATUSES = Object.freeze([STATUS.PAID, STATUS.EXPIRED, STATUS.CANCELLED])

/** 进入终态时写入 terminal_reason 的值 */
const TERMINAL_REASON = Object.freeze({
  [STATUS.PAID]: 'settled',
  [STATUS.EXPIRED]: 'expired',
  [STATUS.CANCELLED]: 'cancelled',
  [STATUS.EXCEPTION]: 'exception'
})

/** 允许的转移。空数组 = 终态，出不去。 */
const TRANSITIONS = Object.freeze({
  [STATUS.PENDING]: Object.freeze([STATUS.PAID, STATUS.EXPIRED, STATUS.CANCELLED, STATUS.EXCEPTION]),
  [STATUS.PAID]: Object.freeze([]),
  [STATUS.EXPIRED]: Object.freeze([]),
  [STATUS.CANCELLED]: Object.freeze([]),
  // 异常必须有人收尾，所以留两个出口
  [STATUS.EXCEPTION]: Object.freeze([STATUS.PAID, STATUS.CANCELLED])
})

const ALL_STATUSES = Object.freeze(
  Object.keys(STATUS_TEXT).map(Number)
)

function isValidStatus(status) {
  return ALL_STATUSES.includes(Number(status))
}

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(Number(status))
}

function isPending(status) {
  return Number(status) === STATUS.PENDING
}

function statusText(status) {
  return STATUS_TEXT[Number(status)] || `未知状态(${status})`
}

function canTransition(from, to) {
  const list = TRANSITIONS[Number(from)]
  return Array.isArray(list) && list.includes(Number(to))
}

/**
 * 断言一次状态转移合法，否则抛 409。
 *
 * 用 409（冲突）而不是 400：这不是请求格式错误，
 * 而是「当前资源状态不允许这个操作」——
 * 典型场景是两个入口（链监听 + 用户点「我已付款」）同时结算同一单，
 * 后到的那个应该看到明确的冲突，而不是一个语焉不详的失败。
 */
function assertTransition(from, to) {
  const fromStatus = Number(from)
  const toStatus = Number(to)
  if (!isValidStatus(fromStatus)) {
    throw new ApiError(500, `订单状态非法：${from}`, 'BAD_RECHARGE_STATUS')
  }
  if (!isValidStatus(toStatus)) {
    throw new ApiError(500, `目标状态非法：${to}`, 'BAD_RECHARGE_STATUS')
  }
  if (!canTransition(fromStatus, toStatus)) {
    throw new ApiError(409,
      `订单不能从「${statusText(fromStatus)}」变为「${statusText(toStatus)}」`,
      'ILLEGAL_RECHARGE_TRANSITION')
  }
}

/**
 * 订单是否已经过期（按时间判断，不改状态）。
 *
 * 过期是**惰性判定**：不依赖定时任务先把 status 改成 2 ——
 * 定时任务可能延迟、可能没跑，但「30 分钟有效期」这件事
 * 必须在任何一次结算尝试时都立刻成立。
 * 扫描任务只是把状态补齐，不是有效期的依据。
 */
function isExpired(order, now) {
  if (!order || !order.expiresAt) return false
  const expires = new Date(order.expiresAt).getTime()
  const at = now ? new Date(now).getTime() : Date.now()
  return Number.isFinite(expires) && at >= expires
}

/**
 * 有效状态：把「惰性过期」算进去之后的**对外状态**。
 *
 * ## 为什么需要它
 *
 * 过期是**惰性判定**的 —— 数据库里的 `status` 不会因为时间到了就自动变成 2。
 * 这是刻意的：为了"让列表显示 expired"而每分钟扫全表改状态，是无意义的写入，
 * 而且会让 `terminal_at` 这类审计字段失去意义。
 *
 * 但惰性判定有个必须堵上的副作用：**`status=0` 不能直接当成"还在等付款"展示**。
 * 一张三天前就该过期的订单，如果后台、报表、统计都按 pending 计，
 * 运营看到的数字就是假的 —— 而且会真的去等一笔永远不会来的款。
 *
 * 所以规则统一为：
 *   **凡是"展示"或"统计"订单状态的地方，一律用 effectiveStatus，不要直接读 status。**
 *
 *   status = 0 且 expires_at <= now  →  effective = EXPIRED(2)
 *   其余情况                          →  effective = status
 *
 * 注意它**只影响读**，不写库。数据库里的 status 仍然是 0，
 * 真实迁移由结算/扫描任务在需要时推进。
 */
function effectiveStatus(order, now) {
  const raw = Number(order && order.status)
  if (raw === STATUS.PENDING && isExpired(order, now)) return STATUS.EXPIRED
  return raw
}

/** 有效状态的文案，供接口直接下发 */
function effectiveStatusText(order, now) {
  return statusText(effectiveStatus(order, now))
}

/**
 * 订单当前是否**真的**在等付款。
 *
 * 与 `isPending(status)` 的区别：这个方法把"已过期但还没落状态"排除掉了。
 * 统计"有效待支付"必须用它，否则会把一堆僵尸订单算进去。
 */
function isEffectivelyPending(order, now) {
  return effectiveStatus(order, now) === STATUS.PENDING
}

/**
 * `effectiveStatus` 的 SQL 等价写法，供**列表/统计**直接在库里算。
 *
 * 为什么要有两份实现：列表要能排序、能筛选、能分页，就必须在 SQL 里算；
 * 单条订单在内存里判断时又不想多查一次库。两份实现共用同一个语义
 * （`status=0 且 expires_at<=now() 视为已过期`），并由
 * `test/recharge-effective-status.test.js` 里的守卫用例锁死一致性。
 *
 * @param {string} alias recharges 表别名，例如 'r'
 * @param {string} [nowExpr] 可注入的时间表达式，测试用
 */
function effectiveStatusSql(alias = 'r', nowExpr = 'now()') {
  const prefix = alias ? `${alias}.` : ''
  return `CASE WHEN ${prefix}status = ${STATUS.PENDING} AND ${prefix}expires_at <= ${nowExpr}`
    + ` THEN ${STATUS.EXPIRED} ELSE ${prefix}status END`
}

module.exports = {
  STATUS,
  STATUS_TEXT,
  TERMINAL_STATUSES,
  TERMINAL_REASON,
  TRANSITIONS,
  ALL_STATUSES,
  isValidStatus,
  isTerminal,
  isPending,
  statusText,
  canTransition,
  assertTransition,
  isExpired,
  effectiveStatus,
  effectiveStatusText,
  effectiveStatusSql,
  isEffectivelyPending
}
