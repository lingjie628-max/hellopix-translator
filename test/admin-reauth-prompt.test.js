const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const apiSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'utils', 'api.js'),
  'utf8'
)

test('428 二次认证必须真的弹出密码框（Vue 2 原型没有 $createElement）', () => {
  assert.doesNotMatch(
    apiSource,
    /Vue\.prototype\.\$createElement/,
    'Vue 2 的实例方法不在原型上，用它造 VNode 会让 428 重试直接抛错'
  )
  assert.match(
    apiSource,
    /MessageBox\.prompt\s*\(/,
    '二次认证应使用 Element UI 原生 prompt'
  )
  assert.match(apiSource, /inputType:\s*'password'/, '密码框必须是 password 类型')
  assert.match(apiSource, /if \(status === 428 && !config\.__reauthRetried\)/,
    '428 只能自动重试一次，避免密码错误时死循环')
})
