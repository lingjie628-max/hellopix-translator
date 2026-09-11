/**
 * 通道开关脚本：把某个翻译通道的 wired 置为 true/false。
 *
 * 为什么需要它：core-service 在扣费前会检查 engine.wired，wired=false 直接
 * 503 ENGINE_NOT_CONFIGURED。目前后台没有引擎管理接口，只能靠 SQL；而"手写
 * UPDATE 把没配凭据的通道打开"正是最容易出事的一步 —— 所以这里加了前置校验。
 *
 * 用法：
 *   node scripts/set-engine-wired.js youdao true
 *   node scripts/set-engine-wired.js papago false
 *
 * 安全约束：
 *   - 打开(wired=true)前必须确认该通道的适配器已具备凭据，否则拒绝执行；
 *   - 关闭(wired=false)任何时候都允许，用于紧急止血；
 *   - engines 表有 CHECK (wired = false OR enabled = true)，未启用的通道无法打开。
 */

const { query, closePostgres } = require('../server/db/postgres')
const { providers, channelStatus } = require('../server/services/translation-provider')

function parseTarget(value) {
  const text = String(value || '').trim().toLowerCase()
  if (text === 'true' || text === '1' || text === 'on') return true
  if (text === 'false' || text === '0' || text === 'off') return false
  throw new Error('第二个参数必须是 true 或 false')
}

async function main() {
  const engineId = String(process.argv[2] || '').trim()
  if (!engineId) throw new Error('用法: node scripts/set-engine-wired.js <engine-id> <true|false>')
  const wired = parseTarget(process.argv[3])

  const provider = providers[engineId]
  if (!provider) throw new Error(`未知通道: ${engineId}（适配层没有这个 id）`)

  const { rows } = await query(
    'SELECT id, name, enabled, wired FROM engines WHERE id = $1',
    [engineId]
  )
  if (!rows.length) throw new Error(`数据库里没有通道: ${engineId}`)
  const engine = rows[0]

  if (wired && !provider.configured()) {
    const status = channelStatus().find(row => row.id === engineId)
    throw new Error(
      `拒绝打开 ${engine.name}: 适配器还没有可用凭据` +
      `(credentialReady=${status ? status.credentialReady : 'unknown'})。` +
      '请先配置凭据并确认能真实翻译，再执行本命令。'
    )
  }
  if (wired && !engine.enabled) {
    throw new Error(`拒绝打开 ${engine.name}: 该通道 enabled=false（库级约束 wired 不能先于 enabled）`)
  }

  await query('UPDATE engines SET wired = $2 WHERE id = $1', [engineId, wired])
  console.log(`${engine.name}(${engineId}): wired ${engine.wired} -> ${wired}`)
  if (wired) {
    console.log('提醒：真实翻译会开始按字符计费，请先用一个测试账号跑通 /apis/translate/run 再放开给用户。')
  }
}

main()
  .catch(error => {
    console.error('失败:', error.message)
    process.exitCode = 1
  })
  .finally(() => closePostgres())
