'use strict'

/**
 * 套餐（packages）的读写。
 *
 * ## 为什么从路由里搬出来
 *
 * `/admin/packages/save` 原本是一条 178 行的路由，占 `admin.js` 的十分之一。
 * 它把三件不同的事揉在一起：
 *
 *   1. **字段校验与归一化** —— 标识符正则、价格取正、JSON 列解析、未知通道检查
 *   2. **事务写库**      —— INSERT/UPDATE 主表 + 重建 package_engines 关联
 *   3. **审计**          —— 记标题与通道数
 *
 * 中间任何一步出错，路由里都看不出来是哪一层。更麻烦的是：
 * **校验规则只在这一条路由里，别处要用就得复制一份**，
 * 复制出去的第二份迟早与第一份走偏（`chars` / `includedChars` 这种双名
 * 就已经在前后端各写了一遍）。
 *
 * 抽出来后路由只剩「调 save()，回 200」，规则只有一处。
 *
 * ## 校验为什么必须放在这一层
 *
 * 套餐是一张**能改金额**的表 —— `price` 决定商户付多少钱，
 * `included_chars` / `sub_quota` 决定买了能用多少。这些字段一旦写错，
 * 是直接的资金与权益错误，不是显示问题。所以：
 *
 * · `code` 必须是规范化的小写标识：它是套餐的对外唯一键，
 *   大小写混用会出现 `Pro` 与 `pro` 两个套餐指向同一件事
 * · `price` / `chars` / `subQuota` 一律向下夹到非负整数：
 *   前端传 `-1` 或 `"abc"` 时不能把脏值写进库里
 * · `engines` 必须逐个在 `engines` 表里存在：不存在的 id 会让
 *   `package_engines` 挂一条永远连不上通道的记录，商户买了却翻译不了
 */

const { ApiError } = require('../lib/http')
const { bool } = require('./core-service')

/** `code`：2-64 位小写字母/数字/下划线/横线，且以字母开头 */
const CODE_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/

const MAX_SUBTITLE = 300

/**
 * 解析 JSON 列（`engines` / `clients` / `features`）。
 *
 * 前端有时提交对象、有时提交 JSON 字符串（表单序列化会变成字符串），
 * 两种都得认。解析失败时的错误码是按列分开的 ——
 * 前端要据此把焦点定位到出错的输入框，不能统一报「参数错误」。
 */
function parseJsonColumn(value, fallback, kind) {
  if (value === undefined || value === null || value === '') return fallback
  let parsed
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value
  } catch (e) {
    // 与路由层原有的 safeParse 保持同一个错误码：
    // 前端已经按 BAD_JSON 做了提示文案，这里换成别的码会让它显示成未知错误。
    throw new ApiError(400, '提交的数据不是合法 JSON', 'BAD_JSON')
  }
  if (kind === 'array' && !Array.isArray(parsed)) {
    throw new ApiError(400, '通道列表必须是数组', 'BAD_PACKAGE_ENGINES')
  }
  if (kind === 'object' && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
    throw new ApiError(400, '权益配置必须是对象', 'BAD_PACKAGE_FEATURES')
  }
  return parsed
}

/** 夹到非负整数。用于 chars / portLimit / subQuota / sortOrder */
function nonNegativeInt(value) {
  return Math.max(0, Math.floor(Number(value) || 0))
}

/** 夹到非负数，保留小数。用于 price */
function nonNegativeNumber(value) {
  return Math.max(0, Number(value) || 0)
}

/**
 * 布尔字段：字面量解析，认不出就 400。
 *
 * 不做 `Number()` 猜测 —— 那会把 `"true"`/`"no"` 一律当成 NaN → false，
 * 静默把开关关掉。认不出时宁可报错，也不能默默地按 false 存进去。
 */
function unknownBool(value, field) {
  const parsed = bool(value)
  if (parsed === null) {
    throw new ApiError(400, `${field} 必须是 true/false/1/0`, 'BAD_BOOLEAN')
  }
  return parsed
}

class PackageService {
  constructor(repo) {
    this.repo = repo
  }

  /**
   * 校验并归一化套餐字段。
   *
   * @param {object} data 请求体
   * @returns {Promise<{code:string, engineIds:string[], fields:object}>}
   */
  async normalize(data) {
    const code = String(data.code || '').trim().toLowerCase()
    const title = String(data.title || '').trim()

    if (!title) throw new ApiError(400, '套餐名称不能为空', 'PACKAGE_TITLE_REQUIRED')
    if (!CODE_PATTERN.test(code)) {
      throw new ApiError(400,
        '套餐标识必须是 2-64 位小写字母/数字/下划线/横线，且以字母开头',
        'BAD_PACKAGE_CODE')
    }

    const engineIds = parseJsonColumn(data.engines, [], 'array').map(id => String(id))
    if (engineIds.length) {
      // 一次查完再比对，避免逐个 id 往返。
      // 用 ANY 而不是 IN (...) 拼串：避免把用户输入拼进 SQL，也省掉参数上限的烦恼。
      const found = await this.repo.query('SELECT id FROM engines WHERE id = ANY($1::text[])', [engineIds])
      const known = new Set(found.rows.map(row => row.id))
      const unknown = engineIds.filter(id => !known.has(id))
      if (unknown.length) {
        throw new ApiError(400, `未知通道: ${unknown.join(', ')}`, 'ENGINE_NOT_FOUND')
      }
    }

    const fields = {
      title,
      subtitle: String(data.subtitle || '').slice(0, MAX_SUBTITLE),
      portLimit: nonNegativeInt(data.port || data.portLimit),
      // 端口不限：缺省为 true。前端没传这个字段时按"不限"处理，
      // 因为历史上所有存量套餐都是不限端口的。
      //
      // ⚠️ 不能写 `Boolean(Number(x))`：`Number('true')` / `Number('no')` 都是 NaN，
      // 于是 Boolean(NaN) 恒为 false —— 表单里传字符串 "true" 会把「不限端口」
      // 静默关掉，商户买完才发现端口被卡死，且没有任何报错。
      portUnlimited: data.portUnlimited === undefined || data.portUnlimited === ''
        ? true
        : unknownBool(data.portUnlimited, 'portUnlimited') === true,
      chars: nonNegativeInt(data.chars || data.includedChars),
      price: nonNegativeNumber(data.price),
      // 套餐自带的子账号额度。企业账号不受它限制，
      // 但对个人账号它是 `users.sub_quota` 的发放来源（结算买套餐、新建商户两处都取它）。
      subQuota: nonNegativeInt(data.subQuota),
      clients: parseJsonColumn(data.clients, {}, 'object'),
      features: parseJsonColumn(data.features, {}, 'object'),
      sortOrder: nonNegativeInt(data.sortOrder)
    }

    return { code, engineIds, fields }
  }

  /**
   * 新建或更新套餐。
   *
   * @param {object} data      请求体（有 id 即更新）
   * @param {object} actor     req.pixAdmin
   * @param {string} ip        req.ip
   * @returns {Promise<number>} 套餐 id
   */
  async save(data, actor, ip) {
    const { code, engineIds, fields } = await this.normalize(data)

    return this.repo.transaction(async client => {
      let packageId = data.id ? Number(data.id) : null

      if (packageId) {
        const updated = await this.repo.query(
          `UPDATE packages SET title=$2,subtitle=$3,port_limit=$4,port_unlimited=$5,included_chars=$6,
                  price=$7,clients=$8::jsonb,features=$9::jsonb,sort_order=$10,sub_quota=$11,
                  updated_at=NOW()
           WHERE id=$1 RETURNING id`,
          [packageId, fields.title, fields.subtitle, fields.portLimit, fields.portUnlimited,
            fields.chars, fields.price, JSON.stringify(fields.clients), JSON.stringify(fields.features),
            fields.sortOrder, fields.subQuota], client
        )
        if (!updated.rows[0]) throw new ApiError(404, '套餐不存在', 'PACKAGE_NOT_FOUND')
      } else {
        const inserted = await this.repo.query(
          `INSERT INTO packages(code,title,subtitle,port_limit,port_unlimited,included_chars,price,clients,features,sort_order,sub_quota)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11) RETURNING id`,
          [code, fields.title, fields.subtitle, fields.portLimit, fields.portUnlimited,
            fields.chars, fields.price, JSON.stringify(fields.clients), JSON.stringify(fields.features),
            fields.sortOrder, fields.subQuota], client
        )
        packageId = inserted.rows[0].id
      }

      // 关联表整体重建：先删后插比 diff 简单且不会漏删。
      // 套餐的通道集合很小（个位数），重建成本可以忽略。
      await this.repo.query('DELETE FROM package_engines WHERE package_id=$1', [packageId], client)
      if (engineIds.length) {
        await this.repo.query(
          `INSERT INTO package_engines(package_id,engine_id)
           SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
          [packageId, engineIds], client
        )
      }

      await this.repo.audit(client, actor, data.id ? '编辑套餐' : '新建套餐',
        `${fields.title}（${engineIds.length} 个通道）`, ip, { type: 'package', id: packageId })

      return packageId
    })
  }

  /**
   * 下架套餐（软删）。
   *
   * ## 为什么不物理删除
   *
   * `orders` / `recharges` / 商户的已发字符额度都还引用着这一档的
   * title 和 price。硬删之后，历史订单详情里那一栏会变成空白 ——
   * 用户三个月后回看账单，会看到一条「套餐：（空）」。
   *
   * 而 `packages.active` 这个字段本来就在用：
   * 官网定价页、商户充值页、管理端列表全部 `WHERE active=true`。
   * 置 false 就够了，不需要新功能，只需要一个入口。
   *
   * ## 至少要留一档在售
   *
   * 全部下架 = 官网没有任何可买的东西，充值页空白。
   * 这和"只剩一个超管"是同一类护栏：系统必须保持可用。
   *
   * @returns {Promise<string>} 被下架的套餐名称
   */
  async retire(data, actor, ip) {
    const id = Number(data && data.id)
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiError(400, '缺少套餐 ID', 'PACKAGE_ID_REQUIRED')
    }

    return this.repo.transaction(async client => {
      // 锁住这一行，避免两个管理员同时下架最后两档
      const found = await this.repo.query(
        'SELECT id,title,active FROM packages WHERE id=$1 FOR UPDATE', [id], client
      )
      const pkg = found.rows[0]
      if (!pkg) throw new ApiError(404, '套餐不存在', 'PACKAGE_NOT_FOUND')
      if (!pkg.active) return String(pkg.title)

      const left = await this.repo.query(
        'SELECT count(*)::int AS n FROM packages WHERE active=true AND id<>$1', [id], client
      )
      if (Number(left.rows[0].n) < 1) {
        throw new ApiError(409,
          '这是最后一个在售套餐，下架后充值页会空白。请先新建一个替档。',
          'LAST_PACKAGE')
      }

      await this.repo.query(
        'UPDATE packages SET active=false, updated_at=NOW() WHERE id=$1', [id], client
      )
      await this.repo.audit(client, actor, '下架套餐', String(pkg.title), ip,
        { type: 'package', id })
      return String(pkg.title)
    })
  }
}

module.exports = { PackageService, CODE_PATTERN, parseJsonColumn, nonNegativeInt }
