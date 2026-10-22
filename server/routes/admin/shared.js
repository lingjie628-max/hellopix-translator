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
  res.json(page(mapRows(rows.rows), count.rows[0].total, paging))
}

module.exports = { adminList, adminJoinedList }
