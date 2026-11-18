/**
 * WhatsApp 商业版：与绿色版、多功能版并列的第三个入口。
 *
 * ## 为什么它和另外两个是同一个 URL
 *
 * WhatsApp Business **没有独立的网页聊天入口**。官方口径是：用手机上的
 * WhatsApp Business App 扫 `web.whatsapp.com` 的二维码，登录态挂在手机上。
 * `business.whatsapp.com` 是 Business Platform（API / 服务商体系），
 * 不是能给人聊天的界面 —— 把它当入口写进平台表，用户点开只会看到一个
 * 卖 API 的官网。
 *
 * 所以三者的区别只在**登录的是哪个号**，靠分区隔离。
 *
 * ## 锁住三件事
 *
 *   1. 平台表里有这个 id，且名字/图标/URL 正确；
 *   2. 安全策略的白名单里有它 —— 漏配的话页面导航会被直接拒绝，
 *      表现为「点了没反应」或白屏，且没有任何报错提示；
 *   3. 账号归一化把它当 WhatsApp 处理（走手机号，不猜 opaque 身份）。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const DESKTOP = path.join(ROOT, 'desktop')
const platforms = require(path.join(DESKTOP, 'shared/platforms.js'))
const { isAllowedPlatformUrl } = require(path.join(DESKTOP, 'src/config/security-policy.js'))
const { normalizePlatformUid } = require(path.join(ROOT, 'server/lib/identity.js'))

const biz = platforms.find((p) => p.id === 'whatsapp-biz')

test('平台表：WhatsApp商业版 存在且配置正确', () => {
  assert.ok(biz, 'platforms.js 里没有 whatsapp-biz')
  assert.equal(biz.name, 'WhatsApp商业版')
  assert.equal(biz.url, 'https://web.whatsapp.com/')
  assert.equal(biz.icon, 'whatsapp', '图标复用现有的 whatsapp.svg，别指向不存在的文件')
  assert.notEqual(biz.listed, false, '必须在应用列表里可见')
})

test('三个 WhatsApp 入口都在，且商业版是独立 id（否则多开会串号）', () => {
  const ids = platforms.filter((p) => p.id.startsWith('whatsapp')).map((p) => p.id)
  assert.deepEqual(ids.slice(0, 3), ['whatsapp-green', 'whatsapp-pro', 'whatsapp-biz'])
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复')
})

test('图标文件真实存在', () => {
  const file = path.join(DESKTOP, 'renderer/icons', biz.icon + '.svg')
  assert.ok(fs.existsSync(file), '缺少 ' + file)
})

test('安全策略放行商业版，且不越权到别的域名', () => {
  assert.equal(isAllowedPlatformUrl(biz, 'https://web.whatsapp.com/', biz.url), true)
  assert.equal(isAllowedPlatformUrl(biz, 'https://web.whatsapp.com/business', biz.url), true)
  assert.equal(isAllowedPlatformUrl(biz, 'https://faq.whatsapp.com/', biz.url), true)
  assert.equal(isAllowedPlatformUrl(biz, 'https://evil.example.com/', biz.url), false)
  assert.equal(isAllowedPlatformUrl(biz, 'http://web.whatsapp.com/', biz.url), false, '不接受明文 http')
})

test('账号归一化：商业版按 WhatsApp 处理（走手机号）', () => {
  const result = normalizePlatformUid('whatsapp-biz', '+8613800138000')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'use_phone')
})

test('★ 每个平台的入口域名都必须在白名单里（防止下次新增平台漏配）', () => {
  // 这条是这个测试的核心价值：新增平台时只要忘了改 security-policy.js，
  // 平台能出现在列表里、能点，但页面会被导航护栏拦掉。
  for (const item of platforms) {
    if (item.extension) continue // 扩展平台另有专门的测试
    if (item.customUrl || item.id === 'tickets') continue // 用户自带地址
    const parsed = new URL(item.url)
    assert.equal(
      isAllowedPlatformUrl(item, parsed.origin + '/', item.url),
      true,
      item.id + ' 的站点不在 PLATFORM_DOMAINS 白名单里'
    )
  }
})

test('★ 商业版默认开启防撤回，且"新开"与"重启恢复"两条路径口径一致', () => {
  // 两处各有一份 ANTI_REVOKE_DEFAULT：open-platform.js（新开）与 main.js（重启恢复）。
  // 只改一处的话，用户新开一个好使，重启一次防撤回就悄悄失效了 —— 没有任何报错。
  const src = (f) => fs.readFileSync(path.join(DESKTOP, f), 'utf8')
  for (const file of ['src/window/open-platform.js', 'main.js']) {
    const text = src(file)
    assert.match(
      text,
      /ANTI_REVOKE_DEFAULT = new Set\(\[[^\]]*'whatsapp-biz'/,
      file + ' 里的 ANTI_REVOKE_DEFAULT 没包含 whatsapp-biz'
    )
    assert.ok(
      !/'whatsapp-pro' && settings\.antiRevoke/.test(text),
      file + ' 还残留着只管 whatsapp-pro 的旧判定'
    )
  }
})

test('界面：商业版也能看到防撤回开关', () => {
  const text = fs.readFileSync(path.join(DESKTOP, 'renderer/add-app.js'), 'utf8')
  assert.match(text, /item\.id === 'whatsapp-biz'/, '新增表单里没给商业版放开防撤回开关')
})

