'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.join(__dirname, '..')
const config = fs.readFileSync(
  path.join(ROOT, 'deploy/nginx/deny-jfbaibaox.com.conf'),
  'utf8'
)

test('retired domain has a dedicated HTTP and HTTPS virtual host', () => {
  assert.match(config, /server_name jfbaibaox\.com www\.jfbaibaox\.com;/)
  assert.equal((config.match(/listen 80;/g) || []).length, 1)
  assert.equal((config.match(/listen 443 ssl http2;/g) || []).length, 1)
})

test('retired domain returns 410 and never proxies to the application', () => {
  assert.equal((config.match(/return 410/g) || []).length, 2)
  assert.doesNotMatch(config, /proxy_pass|hello-pix-proxy|root\s+\/opt\/hello-pix/)
  assert.doesNotMatch(config, /server_name[^;]*pixfanyi\.com/)
})

test('retired domain response is not cacheable', () => {
  assert.equal((config.match(/Cache-Control "no-store"/g) || []).length, 2)
})
