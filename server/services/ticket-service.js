'use strict'

/**
 * 工单状态机与派单规则。
 *
 * ## 为什么状态机要单独一个文件，而且纯函数
 *
 * 「改状态」看起来只是 `UPDATE tickets SET status=$2`，实际有三处必须拦住：
 *   1. 不能从 `closed` 直接跳回 `new` —— 关掉的工单是被客服确认过的问题，
 *      重开会让历史统计（平均解决时长、复发率）失效；
 *   2. `resolved` / `closed` 必须写时间戳，且**只能写一次** —— 反复
 *      「解决→重开→再解决」会把 resolved_at 刷成最后一次，平均时长被稀释；
 *   3. 商户回复已解决的工单，应自动回到 `in_progress`，否则客服看不到。
 *
 * 这些规则如果写进 SQL 或路由里，就只能靠读代码确认；写成纯函数就能被
 * 单测逐条钉死（见 test/tickets.test.js）。路由只负责取数据、调这里、写回。
 *
 * ## 状态语义
 *
 *   new          刚提单，没人接
 *   in_progress  客服已接单，正在处理
 *   waiting_user 等商户补充信息（球在商户那边）
 *   resolved     客服认为已解决，等商户确认（球也在商户那边，但可自动关）
 *   closed       终态，不再变动
 */

const { ApiError } = require('../lib/http')

const STATUSES = ['new', 'in_progress', 'waiting_user', 'resolved', 'closed']
const PRIORITIES = ['low', 'medium', 'high', 'urgent']
const CATEGORIES = ['recharge', 'translation', 'login', 'bug', 'feature', 'other']

/** 终态：只进不出（见文件头第 1 条）。 */
const TERMINAL = new Set(['closed'])

/**
 * 允许的流转。`resolved` 可以回到 `in_progress`（商户说没好），
 * `closed` 不行 —— 要重开，请让商户新建工单并引用原单号，
 * 这样「复发」是可统计的事实，而不是把旧单改出新时间线。
 */
const TRANSITIONS = {
  new: ['in_progress', 'waiting_user', 'resolved', 'closed'],
  in_progress: ['waiting_user', 'resolved', 'closed'],
  waiting_user: ['in_progress', 'resolved', 'closed'],
  resolved: ['in_progress', 'closed'],
  closed: []
}

/**
 * 状态推进是否合法。
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function canTransition (from, to) {
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) return false
  if (from === to) return false
  return (TRANSITIONS[from] || []).includes(to)
}

/**
 * 计算一次状态变更要连带写的列。
 *
 * 只有第一次进入 resolved / closed 才写时间戳；退出时不擦除
 * （历史「这单曾经解决过」是事实，擦掉会让复核无从下手）。
 *
 * @param {{status:string, resolved_at?:Date|null, closed_at?:Date|null}} current
 * @param {string} to
 * @param {Date} [now]
 * @returns {{status:string, resolvedAt:Date|null, closedAt:Date|null}}
 */
function nextState (current, to, now = new Date()) {
  const from = current && current.status
  if (!canTransition(from, to)) {
    throw new ApiError(400, `工单不能从「${label(from)}」改为「${label(to)}」`, 'TICKET_BAD_TRANSITION')
  }
  const resolvedAt = current.resolved_at || current.resolvedAt || null
  const closedAt = current.closed_at || current.closedAt || null
  return {
    status: to,
    resolvedAt: to === 'resolved' && !resolvedAt ? now : resolvedAt,
    closedAt: to === 'closed' && !closedAt ? now : closedAt
  }
}

/**
 * 商户回复后工单应该变成什么状态。
 *
 * 规则：球在商户那边时（waiting_user / resolved），回复代表「我补充了/我还没好」，
 * 推回 in_progress 让客服重新看到；其它状态（new / in_progress）保持不动 ——
 * 商户追加一句信息不该把客服的接单状态重置。
 *
 * @param {string} status
 * @returns {string} 目标状态（可能与入参相同）
 */
function afterUserReply (status) {
  if (status === 'waiting_user' || status === 'resolved') return 'in_progress'
  return status
}

/** 中文名，给提示语和前端用。 */
function label (status) {
  return {
    new: '待处理',
    in_progress: '处理中',
    waiting_user: '待商户回复',
    resolved: '已解决',
    closed: '已关闭'
  }[status] || String(status || '')
}

/** 校验枚举，拒绝写入非法值（DB CHECK 是第二道防线，不是第一道）。 */
function assertEnum (value, allowed, code, what) {
  if (!allowed.includes(value)) {
    throw new ApiError(400, `${what}取值不合法：${value}`, code)
  }
  return value
}

/** 合法优先级 / 分类的入口校验。 */
function normalizePriority (value) {
    const v = String(value || 'medium').trim()
    return assertEnum(v, PRIORITIES, 'TICKET_BAD_PRIORITY', '优先级')
  }
function normalizeCategory (value) {
  const v = String(value || 'other').trim()
  return assertEnum(v, CATEGORIES, 'TICKET_BAD_CATEGORY', '分类')
}

module.exports = {
  STATUSES,
  PRIORITIES,
  CATEGORIES,
  TERMINAL,
  TRANSITIONS,
  canTransition,
  nextState,
  afterUserReply,
  label,
  assertEnum,
  normalizePriority,
  normalizeCategory
}
