const { coversFile, missingFromWhitelist } = require('./helpers/whitelist')
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
} = require('../desktop/src/config/security-policy')

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
  // 原来只抽检 OrderInfo.vue 与 UserRechargePage.vue 两个文件 ——
  // 而 OrderInfo.vue 属于已删除的旧工单模块，文件没了测试就崩。
  // 与其换成另外两个文件继续抽检，不如扫**全部** .vue：
  // 覆盖面严格更大，也不会再被"某个文件被删"这种事弄挂。
  const root = path.join(__dirname, '..', 'src')
  const offenders = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.vue')) continue
      const text = fs.readFileSync(full, 'utf8')
      if (text.includes('dangerouslyUseHTMLString')) {
        offenders.push(path.relative(path.join(__dirname, '..'), full))
      }
    }
  }
  walk(root)
  assert.deepEqual(offenders, [], '这些组件开了原始 HTML 渲染，存在 XSS 风险')
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

test('desktop and standalone translation requests carry an idempotency key', () => {
  // 正式后端 core.translate 强制幂等键（缺失返回 400 IDEMPOTENCY_KEY_REQUIRED），
  // 桌面端与独立电报端必须带 requestId；同文本同参数幂等可避免重复渲染二次扣费。
  const root = path.join(__dirname, '..')
  const desktop = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  const telegramMain = fs.readFileSync(path.join(root, 'standalone', 'telegram', 'main.js'), 'utf8')
  assert.ok(desktop.includes('function transRequestId('), 'desktop 缺少幂等键生成函数')
  assert.ok(desktop.includes('requestId: transRequestId(text, from, to, engine)'), 'desktop translate:run 请求缺少 requestId')
  assert.ok(telegramMain.includes('function transRequestKey('), 'standalone telegram 缺少幂等键生成函数')
  assert.ok(telegramMain.includes('requestId: transRequestKey('), 'standalone telegram 翻译请求缺少 requestId')
})
