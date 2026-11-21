'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')

test('超管全局 Signal Token 入口已停用，独立客户端改用用户自己的账号', () => {
  const layout = fs.readFileSync(
    path.join(root, 'src', 'components', 'admin', 'AdminLayout.vue'),
    'utf8'
  )
  const router = fs.readFileSync(
    path.join(root, 'src', 'router', 'index.js'),
    'utf8'
  )
  const docs = fs.readFileSync(
    path.join(root, 'docs', 'Signal-翻译软件对接.md'),
    'utf8'
  )

  assert.doesNotMatch(layout, /\/admin\/signal/)
  assert.match(router, /path:\s*'\/admin\/signal',\s*redirect:\s*'\/admin\/clients'/)
  assert.doesNotMatch(router, /AdminSignalIntegration/)
  assert.match(docs, /全局 Token.*已废弃/)
  assert.match(docs, /每个用户在自己的客户端里登录 Hello Pix/)
})

test('官网独立 Signal 包不抢主客户端按钮，下载标签带系统与架构', () => {
  const landing = fs.readFileSync(
    path.join(root, 'src', 'components', 'Landing.vue'),
    'utf8'
  )
  assert.match(
    landing,
    /primaryDownloads\(\)[\s\S]{0,240}releaseGroup !== 'standalone'/,
    '独立应用不能进入主客户端 primaryDownloads'
  )
  assert.match(landing, /r\.os, r\.arch/)
  assert.match(landing, /' - ' \+ platform/)
  assert.match(landing, /id="standalone"/, '官网必须有独立应用版专门区块')
  assert.match(landing, /standaloneGroups/, '独立应用版必须按 app 分组展示')
  assert.match(landing, /未签名测试版/, '测试包必须明确标明签名状态')
})
