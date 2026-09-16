/**
 * 把存量的明文 TOTP 密钥加密。
 *
 * 009 引入两步验证时，`admins.totp_secret` 是 base32 **明文**存的。
 * 这让 2FA 在"数据库被读"的场景下形同虚设 —— 2FA 的意义正是
 * 「即使密码泄露也进不去」，而明文密钥意味着任何能读库的人
 * （运维、DBA、SQL 注入、备份泄露）都能直接生成有效动态码。
 *
 * 本迁移逐条把明文加密成 `enc:...`（AES-256-GCM）。
 *
 * ## 为什么用 JS 而不是纯 SQL
 *
 * 加密要调 Node 的 crypto，SQL 里做不了。这是本项目第一个
 * 需要跑代码的迁移，所以用 node-pg-migrate 的异步形式。
 *
 * ## 幂等
 *
 * 只处理不以 `enc:` 开头的记录，重复执行不会二次加密
 * （二次加密会把密文当明文再编一层，解出来就是乱的，等于锁死管理员）。
 *
 * ## 失败处理
 *
 * 未配置 PIX_CREDENTIAL_KEY 时**直接报错中止**，不做任何修改 ——
 * 静默跳过会让人以为已经加密了，而实际还是明文。
 */

// **必须用 totp-secret 的封装，不能直接调 encryptSecret。**
// encryptSecret 返回 Buffer，而 totp_secret 是 text 列 ——
// 直接字符串拼接会走 Buffer 的默认 utf8 解码，把二进制静默损坏：
// 存得进去、读不出来，且不报任何错。这个坑我在生产上真踩了一次，
// 代价是管理员的 TOTP 密钥不可恢复（只能用恢复码重进后重新绑定）。
const { credentialsKeyReady } = require('../server/lib/credentials')
const { encryptTotpSecret } = require('../server/lib/totp-secret')

exports.up = async pgm => {
  if (!credentialsKeyReady()) {
    throw new Error(
      '未配置 PIX_CREDENTIAL_KEY，无法加密 TOTP 密钥。' +
      '请先配置该环境变量再执行迁移 —— 明文密钥必须消除。'
    )
  }

  const { rows } = await pgm.db.query(
    `SELECT id, totp_secret FROM admins
     WHERE totp_secret IS NOT NULL AND totp_secret <> ''
       AND totp_secret NOT LIKE 'enc:%'`
  )

  for (const row of rows) {
    await pgm.db.query(
      'UPDATE admins SET totp_secret = $2 WHERE id = $1',
      [row.id, encryptTotpSecret(String(row.totp_secret))]
    )
  }

  // 迁移日志里只报条数，**不打印密钥** —— 迁移输出会进日志与终端历史
  console.log(`  已加密 ${rows.length} 条 TOTP 密钥`)
}

exports.down = async pgm => {
  // 回滚成明文是**故意不支持**的：那等于把刚修掉的漏洞又装回去。
  // 真要回退，应当回退整个 2FA 功能（009 的 down）。
  throw new Error('该迁移不可回滚 —— 把 TOTP 密钥退回明文等于重新引入漏洞')
}
