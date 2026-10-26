'use strict'

/**
 * 后台路由的公共列表壳子。
 *
 * `repo` 必须**显式传入** —— 这两个函数原先定义在 `productionRouter` 闭包里，
 * 直接引用外层 `repo` 就能用。提到模块作用域后闭包没了，
 * `repo` 变成未定义标识符，5 条列表路由全部 500。
 * （test/route-handlers-executable.test.js 抓到的。）
 */

const { input, pagination, page } = require('../../lib/http')
const { mapRows } = require('../../repositories/production-repository')

async function adminList(repo, req, res, table, whereBuilder) {
  const data = input(req)
  const paging = pagination(req, { size: 50 })
  const built = whereBuilder ? whereBuilder(data) : { where: 'TRUE', values: [] }
  const result = await repo.list(table, { where: built.where, values: built.values, limit: paging.size, offset: paging.offset })
  result.rows.forEach(row => { delete row.passwordHash })
  res.json(page(result.rows, result.total, paging))
}

async function adminJoinedList(repo, req, res, config) {
  const data = input(req)
  const paging = pagination(req, { size: 50 })
  const values = []
  let filter = ''
  if (data.keyword) {
    values.push(`%${data.keyword}%`)
    filter = ` AND (${config.keyword.map(column => `${column} ILIKE $1`).join(' OR ')})`
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

module.exports = { adminList, adminJoinedList }
