'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('独立应用下载不读取套餐权益', () => {
  const renderer = read('desktop/renderer/site-info.js')
  const fn = renderer.slice(
    renderer.indexOf('function openStandaloneDownload()'),
    renderer.indexOf('\n}', renderer.indexOf('function openStandaloneDownload()')) + 2
  )
  assert.doesNotMatch(fn, /standaloneClient/, '新版客户端不能再用套餐字段拦截独立应用')
  assert.doesNotMatch(fn, /当前套餐未包含独立应用版/)
})

test('套餐后台不再把独立应用列为可配置权益', () => {
  const admin = read('src/components/admin/AdminPackages.vue')
  assert.doesNotMatch(admin, /setClient\('standalone'/)
  assert.match(admin, /独立应用版对所有账号开放，不受套餐限制/)
})
