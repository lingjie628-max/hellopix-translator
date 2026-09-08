const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const {
  isPrivateHost,
  validateApiUrl,
  isAllowedPlatformUrl,
  isAllowedExternalUrl
} = require('../desktop/security-policy')

test('API policy rejects unsafe schemes, credentials, private targets and unlisted hosts', () => {
  const options = { development: false, allowedHosts: ['api.hello-pix.example'] }
  assert.equal(validateApiUrl('https://api.hello-pix.example', options), 'https://api.hello-pix.example')
  assert.equal(validateApiUrl('http://api.hello-pix.example', options), null)
  assert.equal(validateApiUrl('https://user:pass@api.hello-pix.example', options), null)
  assert.equal(validateApiUrl('https://169.254.169.254/latest/meta-data', options), null)
  assert.equal(validateApiUrl('https://127.0.0.1', options), null)
  assert.equal(validateApiUrl('https://evil.example', options), null)
  assert.equal(validateApiUrl('http://127.0.0.1:8080', { development: true, allowedHosts: [] }), 'http://127.0.0.1:8080')
  assert.equal(isPrivateHost('metadata.google.internal'), true)
})

test('platform navigation stays within trusted domains and custom origin', () => {
  const whatsapp = { id: 'whatsapp-pro', url: 'https://web.whatsapp.com/' }
  assert.equal(isAllowedPlatformUrl(whatsapp, 'https://web.whatsapp.com/', whatsapp.url), true)
  assert.equal(isAllowedPlatformUrl(whatsapp, 'https://accounts.google.com/login', whatsapp.url), true)
  assert.equal(isAllowedPlatformUrl(whatsapp, 'https://evil.example/', whatsapp.url), false)
  assert.equal(isAllowedPlatformUrl(whatsapp, 'data:text/html,test', whatsapp.url), false)

  const custom = { id: 'custom-web', customUrl: true }
  assert.equal(isAllowedPlatformUrl(custom, 'https://docs.example/a', 'https://docs.example/start'), true)
  assert.equal(isAllowedPlatformUrl(custom, 'https://other.example/a', 'https://docs.example/start'), false)
})

test('external links require HTTPS trusted hosts', () => {
  assert.equal(isAllowedExternalUrl('https://download.example/app.dmg', ['download.example']), true)
  assert.equal(isAllowedExternalUrl('http://download.example/app.dmg', ['download.example']), false)
  assert.equal(isAllowedExternalUrl('https://127.0.0.1/app.dmg', ['127.0.0.1']), false)
  assert.equal(isAllowedExternalUrl('tg://resolve?domain=hello', []), true)
})

test('remote pages have no page-world IPC bridge or dynamic code injection', () => {
  const root = path.join(__dirname, '..')
  const guest = fs.readFileSync(path.join(root, 'desktop', 'guest-inject.js'), 'utf8')
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  assert.equal(guest.includes('exposeInMainWorld'), false)
  assert.equal(guest.includes('window.helloPix'), false)
  assert.equal(main.includes('executeJavaScript('), false)
  assert.equal(main.includes('else cb(true)'), false)
  assert.match(main, /ipcMain\.handle\('auth:get'.*publicAuth/)
})

test('Vue dialogs do not enable raw HTML rendering', () => {
  const root = path.join(__dirname, '..', 'src')
  const order = fs.readFileSync(path.join(root, 'components', 'order', 'OrderInfo.vue'), 'utf8')
  const recharge = fs.readFileSync(path.join(root, 'components', 'user', 'UserRechargePage.vue'), 'utf8')
  assert.equal(order.includes('dangerouslyUseHTMLString'), false)
  assert.equal(recharge.includes('dangerouslyUseHTMLString'), false)
})

test('production refuses to boot the in-memory demo backend', () => {
  const root = path.join(__dirname, '..')
  const result = spawnSync(process.execPath, ['server/index.js'], {
    cwd: root,
    env: Object.assign({}, process.env, { NODE_ENV: 'production' }),
    encoding: 'utf8'
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /拒绝启动/)
})
