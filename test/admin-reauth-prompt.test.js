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

test('连续 428 必须共享同一个密码框，不能互相覆盖', () => {
  assert.match(apiSource, /let reauthPrompt = null/,
    '需要一个模块级 in-flight 状态')
  assert.match(apiSource, /if \(reauthPrompt\) return reauthPrompt/,
    '并发 428 必须复用正在等待的密码框')
  assert.match(apiSource, /finally \{\s*reauthPrompt = null/,
    '密码框结束后必须清空状态，下一次高危操作可以重新询问')
})

test('商户保存按钮必须防止重复提交', () => {
  const usersSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'admin', 'AdminUsers.vue'),
    'utf8'
  )
  assert.match(usersSource, /<el-button type="primary" :loading="saving" @click="save">保存<\/el-button>/,
    '保存按钮必须显示 loading')
  assert.match(usersSource, /save\(\) \{\s*if \(this\.saving\) return/,
    '请求未结束时再次点击保存必须直接忽略')
  assert.match(usersSource, /\.finally\(\(\) => \{\s*this\.saving = false/,
    '无论成功失败都必须恢复按钮状态')
})
