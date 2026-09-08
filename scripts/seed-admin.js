const fs = require('fs')
const { hashPassword } = require('../server/security')
const { transaction, closePostgres } = require('../server/db/postgres')

const ROLES = new Set(['superadmin', 'admin', 'operator', 'auditor'])
const COMMON_PASSWORDS = new Set([
  'admin123456',
  'password123456',
  'qwerty123456',
  '1234567890123456'
])

function required(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function readPassword() {
  const file = String(process.env.ADMIN_PASSWORD_FILE || '').trim()
  if (file) return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '')
  return String(process.env.ADMIN_PASSWORD || '')
}

function validatePassword(password, username) {
  const problems = []
  if (password.length < 16 || password.length > 128) problems.push('长度必须为 16-128 位')
  if (!/[a-z]/.test(password)) problems.push('必须包含小写字母')
  if (!/[A-Z]/.test(password)) problems.push('必须包含大写字母')
  if (!/[0-9]/.test(password)) problems.push('必须包含数字')
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('必须包含特殊字符')
  if (/\s/.test(password)) problems.push('不得包含空白字符')
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    problems.push('不得包含管理员用户名')
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) problems.push('不得使用常见密码')
  if (problems.length) throw new Error(`ADMIN_PASSWORD 强度不足：${problems.join('；')}`)
}

async function main() {
  const username = required('ADMIN_USERNAME')
  const nickname = required('ADMIN_NICKNAME')
  const role = required('ADMIN_ROLE')
  const password = readPassword()

  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(username)) {
    throw new Error('ADMIN_USERNAME 格式无效')
  }
  if (!ROLES.has(role)) throw new Error(`ADMIN_ROLE 必须是：${Array.from(ROLES).join(', ')}`)
  validatePassword(password, username)

  await transaction(async client => {
    await client.query(
      `INSERT INTO admins (username, password_hash, nickname, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [username, hashPassword(password), nickname, role]
    )
  }, { isolationLevel: 'SERIALIZABLE' })

  console.log(`管理员 ${username} 创建成功`)
}

if (require.main === module) {
  main()
    .catch(error => {
      const message = error.code === '23505'
        ? '管理员用户名已存在，脚本不会覆盖现有密码'
        : error.message
      console.error(`Seed admin failed: ${message}`)
      process.exitCode = 1
    })
    .finally(() => closePostgres())
}

module.exports = { validatePassword, readPassword, main }
