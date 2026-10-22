#!/usr/bin/env node
'use strict'

/**
 * 修掉 Redis 双前缀：`pix:pix:*` → `pix:*`
 *
 * ## 用法
 *
 *   node scripts/fix-redis-prefix.js            # 预演，只统计不动数据
 *   node scripts/fix-redis-prefix.js --apply    # 真正改名
 *   node scripts/fix-redis-prefix.js --apply --rollback   # 回退成双前缀
 *
 * ## 为什么是脚本，不是迁移
 *
 * 1. 迁移挂在 systemd 的 `ExecStartPre` —— Redis 慢一下服务就起不来，
 *    把 Redis 数据搬迁塞进去等于给启动路径加一个能挂死的环节；
 * 2. node-pg-migrate 管的是 PG schema，超纲了；
 * 3. 这个动作需要**先看统计再决定动手**（见 `--apply`），迁移没有预演能力。
 *
 * 脚本可反复执行：第二次跑时已无双前缀键，直接空转。
 *
 * ## 事故经过
 *
 *   · `server/stores/redis-client.js` 硬编码 `PREFIX = 'pix:'`；
 *   · `server/db/redis.js` 又把 `REDIS_KEY_PREFIX` 交给 ioredis 的 `keyPrefix`；
 *   · 运维设了 `REDIS_KEY_PREFIX=pix:` —— 两者叠加，线上键全成了 `pix:pix:*`。
 *
 * 因为读写两端同一个客户端，双前缀**自洽**，业务从不报错，所以潜伏很久
 * （2026-10-21 第一次发现时线上有 4632 个）。
 *
 * ## 为什么必须搬迁而不是让它自然过期
 *
 * 前缀改对后旧键查不到，等价于：
 *   · 所有用户**掉线**；
 *   · 翻译缓存**全量击穿** —— 冷启动瞬间打满上游通道，会直接撞限流、
 *     成本飙升。这一条比掉线严重得多。
 *
 * ## 为什么用 RENAME
 *
 * `RENAME` 在 Redis 内原子执行且**保留 TTL**。GET+SET 会丢过期时间
 * （缓存永不过期、内存只涨不跌），而且对集合型键（`session-subject:*`）
 * 直接类型错误。集合里的成员是完整键名，也要跟着改，否则
 * `revokeSubject` 会 DEL 到不存在的键 —— **退出登录不生效**。
 */

const Redis = require('ioredis')
const config = require('../server/config')

const PREFIX = String(process.env.REDIS_KEY_PREFIX || 'pix:').endsWith(':')
  ? String(process.env.REDIS_KEY_PREFIX || 'pix:')
  : String(process.env.REDIS_KEY_PREFIX) + ':'
const DOUBLE = PREFIX + PREFIX

const apply = process.argv.includes('--apply')
const rollback = process.argv.includes('--rollback')

function client() {
  // 裸客户端：**不能带 keyPrefix**，否则 keys/rename 作用的是去掉前缀后的
  // 名字，会和真实键名错位。这正是双前缀事故的另一面。
  return new Redis(config.redis.url, {
    lazyConnect: true, maxRetriesPerRequest: 2, connectTimeout: 5000
  })
}

async function scan(redis, pattern) {
  let cursor = '0'
  const out = []
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500)
    cursor = next
    out.push(...batch)
  } while (cursor !== '0')
  return out
}

async function main() {
  const redis = client()
  await redis.connect()

  const source = rollback ? PREFIX : DOUBLE
  const label = rollback ? '双前缀（回退）' : '单前缀（修正）'

  console.log(`模式: ${apply ? '执行' : '预演（加 --apply 才会动数据）'}`)
  console.log(`方向: ${source}* → ${label}`)

  const keys = await scan(redis, source + '*')
  // 回退时别把本来就是双前缀的键再叠一层
  const targets = rollback ? keys.filter(k => !k.startsWith(DOUBLE)) : keys

  const byNs = {}
  for (const k of targets) {
    const rest = k.slice(source.length)
    const ns = rest.split(':')[0] || '(none)'
    byNs[ns] = (byNs[ns] || 0) + 1
  }
  console.log(`待处理键: ${targets.length}`)
  Object.entries(byNs).sort((a, b) => b[1] - a[1])
    .forEach(([ns, n]) => console.log(`  ${ns.padEnd(20)} ${n}`))

  if (!apply || !targets.length) {
    await redis.quit()
    return
  }

  let renamed = 0
  const failures = []
  let dropped = 0
  for (const oldKey of targets) {
    const newKey = rollback ? PREFIX + oldKey : oldKey.slice(PREFIX.length)
    try {
      if (await redis.exists(newKey)) {
        // 目标已存在。
        //
        // 老实现直接 `del(oldKey)`，理由是"新代码已经写过这条，旧的是孤儿"。
        // 对缓存键（trans-cache / engines / prefs）这没问题。但**对会话键是灾难**：
        // 新旧两条并存时，正在被验证的往往是旧的那条（双前缀时期签发、还没过期），
        // 新代码写完的那条可能是另一个用户的。一删，用户当场掉线，
        // 而且 TTL 也跟着没了 —— 再登一次才知道自己被踢了。
        //
        // 正确做法：**保留 TTL 更长的那条**。两条都无法证明新旧时，
        // 宁可不动（留下一个孤儿键，比踢人下线便宜得多）。
        const oldTtl = await redis.ttl(oldKey)
        const newTtl = await redis.ttl(newKey)
        if (oldTtl > newTtl && oldTtl > 0) {
          // 旧的活得更久：把新键换成旧的（旧键是更权威的那份）
          await redis.del(newKey)
          await redis.rename(oldKey, newKey)
        } else {
          // 新的活得更久、或者已经永不过期：旧键确实是孤儿，可以回收
          await redis.del(oldKey)
          dropped++
        }
      } else {
        await redis.rename(oldKey, newKey)
      }
      renamed++
    } catch (error) {
      failures.push(`${oldKey}: ${error.message}`)
    }
  }
  console.log(`已处理 ${renamed} 个键` + (dropped ? `（其中 ${dropped} 个是与新键并存、按 TTL 判为孤儿的旧键）` : ''))

  // 集合成员修正：session-subject:* 是 SET，成员是完整 session 键名。
  const sets = await scan(redis, (rollback ? PREFIX : DOUBLE) + 'session-subject:*')
  let members = 0
  for (const setKey of sets) {
    if (rollback && setKey.startsWith(DOUBLE)) continue
    const newSetKey = rollback ? PREFIX + setKey : setKey.slice(PREFIX.length)
    if (newSetKey === setKey) continue
    const old = await redis.smembers(setKey).catch(() => [])
    const fixable = rollback
      ? old.filter(m => !m.startsWith(DOUBLE))
      : old.filter(m => m.startsWith(DOUBLE))
    if (!fixable.length) continue
    const mapped = fixable.map(m => rollback ? PREFIX + m : m.slice(PREFIX.length))
    await redis.sadd(newSetKey, ...mapped).catch(() => {})
    await redis.srem(setKey, ...fixable).catch(() => {})
    members += fixable.length
  }
  if (members) console.log(`修正集合成员 ${members} 个`)

  if (failures.length) {
    console.log(`${failures.length} 个键处理失败（前 5 个）：`)
    failures.slice(0, 5).forEach(line => console.log('  ' + line))
  }

  await redis.quit()
}

main().catch(error => {
  console.error('执行失败:', error.message)
  process.exitCode = 1
})
