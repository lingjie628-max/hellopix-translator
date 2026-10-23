/**
 * 客户端发布记录的签名与哈希（`client_releases.sha256` / `.signature` / `.min_version`）。
 *
 * ## 起因
 *
 * `/client/update` 现在只回版本号和下载地址，客户端唯一的防线是
 * `DOWNLOAD_HOSTS` 域名白名单。白名单能挡「把用户引到 evil.com」，
 * 挡不住**服务端被攻破后在白名单域名上换一个恶意包** —— 那时 URL 完全合法。
 *
 * 更新通道是唯一能给所有用户推代码执行的通道，却把完整性押在了服务端的
 * 健康上。所以加一层与服务端无关的校验：安装包哈希由构建机私钥签名，
 * 客户端内置公钥验签。服务器就算被打穿，也签不出一份合法清单。
 *
 * ## 为什么哈希和签名要落库，而不是每次现算
 *
 * 安装包在对象存储 / CDN 上，服务端现算要么得先把上百 MB 拉回来
 * （每次有人点「检查更新」都拉一次，成本和延迟都不可接受），要么信任
 * 上游返回的长度差不多的头 —— 那不叫校验。发布时算一次、签一次、
 * 落库，之后每次下发只是读三列。
 *
 * ## 三列都可能为空
 *
 * 存量记录没有签名（历史发布），迁移不能填假值 —— 一个伪造成
 * "已签名"的空串会让客户端把 `signature: ''` 当成"有签名字段"，
 * 走到验签失败而不是"没签名"。所以三列都允许 NULL，只有真正经过
 * 签名脚本发布的记录才有值。
 *
 * `min_version` 是**防降级**的下限：签名只能证明"这是官方发的"，
 * 证明不了"它比现在新"。攻击者可以重放一份旧的、签名合法的清单，
 * 把用户拉回有已知漏洞的版本。
 */

exports.up = async pgm => {
  await pgm.db.query(`
    ALTER TABLE client_releases
      ADD COLUMN IF NOT EXISTS sha256 text,
      ADD COLUMN IF NOT EXISTS signature text,
      ADD COLUMN IF NOT EXISTS min_version text
  `)
  // 签名清单是按条查的（每次更新检查取一条），且只在有值时出现；
  // 条件索引比全表索引小得多，也不会拖慢后台列表的分页查询。
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS client_releases_signed_idx
      ON client_releases (id)
      WHERE signature IS NOT NULL
  `)
}

exports.down = async pgm => {
  await pgm.db.query('DROP INDEX IF EXISTS client_releases_signed_idx')
  await pgm.db.query(`
    ALTER TABLE client_releases
      DROP COLUMN IF EXISTS sha256,
      DROP COLUMN IF EXISTS signature,
      DROP COLUMN IF EXISTS min_version
  `)
}
