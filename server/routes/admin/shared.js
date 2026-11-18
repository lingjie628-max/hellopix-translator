'use strict'

/**
 * 后台路由的公共列表壳子。
 *
 * `repo` 必须**显式传入** —— 原先定义在 `productionRouter` 闭包里，
 * 直接引用外层 `repo` 就能用。提到模块作用域后闭包没了，
 * `repo` 变成未定义标识符，5 条列表路由全部 500。
 * （test/route-handlers-executable.test.js 抓到的。）
 *
 * ## adminList 曾经存在，2026-11-01 删掉
 *
 * 它做的是 `repo.list(table)` —— 直接把表原样查出来。问题是**列名不对齐**：
 * 库里是 `created_at`，前端读 `loginTime` / `createTime`。用它查登录日志，
 * 时间列永远是空的（表格照样渲染，只是空一格，看着像"这条本来就没时间"）。
 *
 * 唯一的调用方 `/admin/logs` 已经改成显式写 SQL 别名。留着这个函数，
 * 下一个人加列表页时会照抄它，再踩一遍同样的坑。
 */

const { input, pagination, page, ApiError } = require('../../lib/http')
const { mapRows } = require('../../repositories/production-repository')

async function adminJoinedList(repo, req, res, config) {
  const data = input(req)
  const paging = pagination(req, { size: 50 })
  const values = []
  const filters = []
  /**
   * ★ 按父账号过滤（`?userId=` / `?parentId=`）★
   *
   * 2026-11-11 修：`/admin/subs` 原先**完全不读** `userId` ——
   * AdminUsers.vue 的「子账号」弹窗传的是 `{ userId: row.id }`，
   * 服务端却返回**全站所有子账号**。超管点开 A 商户，看到的是所有人的子账号；
   * 再点「踢下线」，`row.id` 可能是 B 商户名下的账号。
   * 解绑看着"没反应"，其实踢错了人（或踢了本该保留的）。
   *
   * 有过滤条件时只认 `config.parentColumn`（默认 `parent_id`）。
   */
  const parentRaw = data.userId !== undefined ? data.userId : data.parentId
  if (config.parentColumn && parentRaw !== undefined && parentRaw !== '' && parentRaw !== null) {
    const parentId = Number(parentRaw)
    if (!Number.isSafeInteger(parentId) || parentId <= 0) {
      throw new ApiError(400, '父账号参数不合法', 'BAD_PARENT_ID')
    }
    values.push(parentId)
    filters.push(`${config.parentColumn} = $${values.length}`)
  }
  let filter = filters.length ? ' AND ' + filters.join(' AND ') : ''
  if (data.keyword) {
    values.push(`%${data.keyword}%`)
    const start = values.length
    filter += ` AND (${config.keyword.map(column => `${column} ILIKE $${start}`).join(' OR ')})`
  }
  const count = await repo.query(`SELECT count(*)::bigint AS total FROM ${config.from} WHERE TRUE${filter}`, values)
  const rows = await repo.query(
    `SELECT ${config.select} FROM ${config.from} WHERE TRUE${filter}
       ORDER BY ${config.order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    values.concat([paging.size, paging.offset])
  )
  /**
   * ★ 补一个 `bound` 布尔位 ★
   *
   * mapRows 只做下划线→驼峰（bound_device → boundDevice），而前端
   * AdminUsers.vue 判的是 `row.bound`：
   *
   *   {{ scope.row.bound ? '已绑定' : '未绑定' }}   ← 「电脑」列
   *
   * 这个字段**只有 mock/index.js 的 enrichUser / publicSub 会补**
   * （copy.bound = u.boundDevice ? 1 : 0），真后端从来没给过。
   * 于是：
   *   · 本地对着 mock 开发，一路正常；
   *   · 上了生产，「电脑」列对所有商户/子账号恒显示"未绑定" ——
   *     超管据此判断"这家没绑设备"，实际 jiufa 名下每个子账号都绑着；
   *   · 连带着解绑按钮也没法按状态给不同文案。
   *
   * 与其要求每个调用方各自去读 boundDevice，不如在这里补成一致的口径。
   * 保留 boundDevice 原值，两个字段并存，不破坏已有消费者。
   */
  const withBound = mapRows(rows.rows).map(row => Object.assign({}, row, {
    bound: row.boundDevice || row.bound_device ? 1 : 0
  }))
  res.json(page(withBound, count.rows[0].total, paging))
}

module.exports = { adminJoinedList }
