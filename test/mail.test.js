'use strict'

/**
 * 邮件服务（SMTP）测试。
 *
 * 这一组测试对应四个真实发生过的缺陷，每一个都让生产环境的注册功能彻底不可用：
 *
 *   1. `readConfig` 读的是 `settings.mail.smtp`（嵌套），而 `repo.settings()`
 *      返回的是扁平键 `'mail.smtp'` —— 配置存进去了也读不出来，configured 恒为 false。
 *   2. `/admin/verify/save` 把页面上的 smtpHost/smtpPort/smtpUser/smtpPass/smtpFrom
 *      整体丢弃，只存通道参数 —— 管理员填完以为存上了，实际 mail.smtp 一直是空的。
 *   3. `/admin/verify` 把状态写死成未接通，无论真实配置如何都显示"未接入"。
 *   4. 测试发信只回一句原始报错，分不清卡在连接、认证还是投递。
 *
 * 所以这里既测行为，也用源码守卫锁死这几条回归。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  Mailer, readConfig, readAlertTo, describeSmtpError, validEmail,
  setting, objectSetting, esc
} = require('../server/lib/mailer')

const root = path.join(__dirname, '..')
const RESEND = {
  host: 'smtp.resend.com',
  port: 465,
  secure: true,
  user: 'resend',
  pass: 're_abcdefghijklmnop_1234567890',
  from: 'noreply@pixfanyi.com',
  fromName: 'Hello Pix'
}

// --------------------------------------------------------------- 配置读取契约

test('SMTP 配置从扁平点号键读取 —— repo.settings() 返回的就是这种形状', () => {
  const settings = { 'mail.smtp': RESEND, 'site.name': '皮克斯' }
  const cfg = readConfig(settings)
  assert.equal(cfg.configured, true)
  assert.equal(cfg.host, 'smtp.resend.com')
  assert.equal(cfg.port, 465)
  assert.equal(cfg.secure, true)
  assert.equal(cfg.user, 'resend')
  assert.equal(cfg.pass, RESEND.pass)
  assert.equal(cfg.from, 'noreply@pixfanyi.com')
})

test('嵌套写法（settings.mail.smtp）读不到配置 —— 这正是当初生产 503 的根因', () => {
  // 同样的数据，换成嵌套形状就什么都读不出来。
  // 这条断言是刻意的：谁要是把 readConfig 改回嵌套读法，这里立刻红。
  const nested = { mail: { smtp: RESEND } }
  const cfg = readConfig(nested)
  assert.equal(cfg.configured, false)
  assert.equal(cfg.host, '')
  assert.deepEqual(cfg.missing, ['SMTP 服务器', '账号', '密码/授权码', '发件地址'])
})

test('jsonb 偶发以字符串形态返回时也能解析', () => {
  const cfg = readConfig({ 'mail.smtp': JSON.stringify(RESEND) })
  assert.equal(cfg.configured, true)
  assert.equal(cfg.host, 'smtp.resend.com')
})

test('配置缺失时逐项列出缺什么，而不是只说"未配置"', () => {
  assert.deepEqual(readConfig({ 'mail.smtp': { host: 'smtp.resend.com' } }).missing,
    ['账号', '密码/授权码', '发件地址'])
  assert.deepEqual(readConfig({}).missing,
    ['SMTP 服务器', '账号', '密码/授权码', '发件地址'])
})

test('secure 按端口推断：465 默认开，未指定时跟随端口', () => {
  assert.equal(readConfig({ 'mail.smtp': Object.assign({}, RESEND, { port: 465, secure: undefined }) }).secure, true)
  assert.equal(readConfig({ 'mail.smtp': Object.assign({}, RESEND, { port: 587, secure: undefined }) }).secure, false)
  assert.equal(readConfig({ 'mail.smtp': Object.assign({}, RESEND, { port: 587, secure: true }) }).secure, true)
})

test('setting / objectSetting 的取值语义', () => {
  assert.equal(setting({ a: 1 }, 'a', 9), 1)
  assert.equal(setting({}, 'a', 9), 9)
  assert.equal(setting({ a: null }, 'a', 9), 9)
  assert.deepEqual(objectSetting({ 'a.b': { x: 1 } }, 'a.b', {}), { x: 1 })
  assert.deepEqual(objectSetting({ 'a.b': '{bad json' }, 'a.b', {}), {})
  assert.deepEqual(objectSetting({}, 'a.b', {}), {})
})

test('告警收件地址独立于 SMTP 配置存放（键名必须小写，见 DB 约束）', () => {
  assert.equal(readAlertTo({ 'mail.alert_to': 'ops@pixfanyi.com' }), 'ops@pixfanyi.com')
  assert.equal(readAlertTo({}), '')
})

// ------------------------------------------------------------- 错误映射与脱敏

test('SMTP 错误码映射成可执行的判断，而不是原样抛英文', () => {
  const cases = {
    EAUTH: /认证/,
    ECONNECTION: /连不上/,
    ESOCKET: /加密方式/,
    ETIMEDOUT: /超时/,
    EDNS: /解析/,
    EENVELOPE: /SPF|发件/
  }
  Object.keys(cases).forEach(code => {
    const d = describeSmtpError({ code, message: 'raw' })
    assert.equal(d.code, code)
    assert.match(d.reason, cases[code], code + ' 的说明不对')
  })
  assert.match(describeSmtpError({ code: 'SOMETHING_NEW' }).reason, /失败/)
})

test('口令绝不出现在错误详情里', () => {
  const d = describeSmtpError(
    { code: 'EAUTH', message: '535 auth failed: user=resend pass=' + RESEND.pass + ' rejected' },
    [RESEND.pass]
  )
  assert.doesNotMatch(d.detail, /re_abcdefghijklmnop/)
  assert.match(d.detail, /\*\*\*/)
})

test('脱敏阈值是 4 字符：达到就替换，短于 4 的留着（否则会把普通单词打成星号）', () => {
  // 阈值故意定得低：多替换只是难看，漏替换才是泄露。
  assert.equal(describeSmtpError({ code: 'EAUTH', message: 'auth failed' }, ['auth']).detail, '*** failed')
  assert.equal(describeSmtpError({ code: 'EAUTH', message: 'auth failed' }, ['uth']).detail, 'auth failed')
  // 真空口令被替换后不该残留任何片段
  const leaked = describeSmtpError({ code: 'EAUTH', message: 'pass=' + RESEND.pass }, [RESEND.pass]).detail
  assert.equal(leaked, 'pass=***')
})

test('错误详情压成单行并截断，避免把服务器应答整段塞进页面', () => {
  const d = describeSmtpError({ code: 'EENVELOPE', message: 'line1\nline2\n' + 'x'.repeat(500) })
  assert.doesNotMatch(d.detail, /\n/)
  assert.ok(d.detail.length <= 300, 'detail 应当被截断')
})

test('邮箱格式校验挡住明显不合法的输入', () => {
  assert.equal(validEmail('a@b.co'), true)
  assert.equal(validEmail('  a@b.co  '), true)
  assert.equal(validEmail('no-at-sign'), false)
  assert.equal(validEmail('a@b'), false)
  assert.equal(validEmail(''), false)
})

test('邮件 HTML 转义挡住用户名注入钓鱼链接', () => {
  assert.equal(esc('<a href="evil">点这里</a>'),
    '&lt;a href=&quot;evil&quot;&gt;点这里&lt;/a&gt;')
})

// ------------------------------------------------------------- sendTest 行为

/** 造一个 Mailer，并把 transport 换成可控的假实现。 */
function makeMailer(settings, transportStub) {
  const repo = { async settings() { return settings } }
  const mailer = new Mailer(repo)
  mailer.transport = () => transportStub
  return mailer
}

test('未配置时 sendTest 返回 MAIL_NOT_CONFIGURED，并说明缺哪几项', async () => {
  const mailer = makeMailer({ 'mail.smtp': { host: 'smtp.resend.com' } }, {})
  const r = await mailer.sendTest('a@b.com')
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'config')
  assert.equal(r.code, 'MAIL_NOT_CONFIGURED')
  assert.match(r.msg, /账号/)
})

test('收件邮箱不合法时直接返回 BAD_EMAIL，不去连 SMTP', async () => {
  let touched = false
  const mailer = makeMailer({ 'mail.smtp': RESEND }, {
    async verify() { touched = true },
    async sendMail() { touched = true }
  })
  const r = await mailer.sendTest('not-an-email')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'BAD_EMAIL')
  assert.equal(touched, false)
})

test('连接/认证失败时报 stage=connect 与真实错误码', async () => {
  const mailer = makeMailer({ 'mail.smtp': RESEND }, {
    async verify() {
      const e = new Error('535 auth failed with ' + RESEND.pass)
      e.code = 'EAUTH'
      throw e
    },
    async sendMail() { throw new Error('不该走到这里') }
  })
  const r = await mailer.sendTest('a@b.com')
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'connect')
  assert.equal(r.code, 'EAUTH')
  assert.doesNotMatch(r.detail, /re_abcdefghijklmnop/)
})

test('SMTP 接受连接但拒收该收件人时，报 SMTP_NOT_ACCEPTED 而不是假装成功', async () => {
  const mailer = makeMailer({ 'mail.smtp': RESEND }, {
    async verify() { return true },
    async sendMail() { return { accepted: [], rejected: ['a@b.com'], response: '550 rejected' } }
  })
  const r = await mailer.sendTest('a@b.com')
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'deliver')
  assert.equal(r.code, 'SMTP_NOT_ACCEPTED')
})

test('投递阶段抛错时报 stage=deliver 与真实错误码', async () => {
  const mailer = makeMailer({ 'mail.smtp': RESEND }, {
    async verify() { return true },
    async sendMail() {
      const e = new Error('550 sender not verified')
      e.code = 'EENVELOPE'
      throw e
    }
  })
  const r = await mailer.sendTest('a@b.com')
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'deliver')
  assert.equal(r.code, 'EENVELOPE')
  assert.match(r.msg, /EENVELOPE/)
})

test('成功时返回 messageId 与 accepted，且 ok 为 true', async () => {
  const mailer = makeMailer({ 'mail.smtp': RESEND }, {
    async verify() { return true },
    async sendMail(payload) {
      assert.equal(payload.to, 'a@b.com')
      // 发件人必须带域名地址；fromName 存在时用 "名称 <地址>" 形式
      assert.match(payload.from, /noreply@pixfanyi\.com/)
      assert.ok(payload.html && payload.text, '纯文本与 HTML 都要给')
      return { messageId: '<x@y>', accepted: ['a@b.com'] }
    }
  })
  const r = await mailer.sendTest('a@b.com')
  assert.equal(r.ok, true)
  assert.equal(r.stage, 'done')
  assert.equal(r.code, 'OK')
  assert.equal(r.messageId, '<x@y>')
  assert.deepEqual(r.accepted, ['a@b.com'])
})

test('sendTest 永不抛异常 —— 后台必须能拿到结构化结果', async () => {
  const mailer = makeMailer({ 'mail.smtp': RESEND }, {
    async verify() { throw new Error('boom') },
    async sendMail() { throw new Error('boom') }
  })
  const r = await mailer.sendTest('a@b.com')
  assert.equal(typeof r.ok, 'boolean')
  assert.equal(r.ok, false)
})

test('测试邮件不含验证码，一眼能看出是测试信', () => {
  // 早期测试信直接复用验证码模板（正文里是 000000），
  // 收件人会把它当成真实验证码去输。测试信就该是测试信。
  const mail = new Mailer({ async settings() { return {} } }).testMail()
  assert.match(mail.subject, /测试/)
  assert.match(mail.subject, /无需操作/)
  assert.doesNotMatch(mail.html, /\d{6}/, '测试邮件里不该出现任何 6 位数字')
  assert.match(mail.html, /不需要做任何操作/)
})

// ----------------------------------------------------------------- 源码守卫

const routeSource = fs.readFileSync(path.join(root, 'server/routes/production.js'), 'utf8')
const mailerSource = fs.readFileSync(path.join(root, 'server/lib/mailer.js'), 'utf8')
const verifyVue = fs.readFileSync(path.join(root, 'src/components/admin/AdminVerify.vue'), 'utf8')

test('路由层不再用嵌套写法读 mail.* 配置', () => {
  assert.doesNotMatch(routeSource, /settings\.mail\s*&&\s*settings\.mail\.smtp/)
  assert.doesNotMatch(routeSource, /settings\.mail\s*&&\s*settings\.mail\.alertTo/)
  assert.match(routeSource, /objectSetting\(settings, 'mail\.smtp'/)
})

test('mailer 不再用嵌套写法读配置', () => {
  assert.doesNotMatch(mailerSource, /settings\.mail\s*&&\s*settings\.mail\.smtp/)
  assert.match(mailerSource, /objectSetting\(settings, 'mail\.smtp'/)
})

test('「验证码接口」页不再返回写死的假状态', () => {
  assert.doesNotMatch(routeSource, /providerName:\s*merged\.provider\s*===\s*'smtp'\s*\?\s*'SMTP（未接入）'/)
  assert.doesNotMatch(routeSource, /wiredText:\s*'未接通',\s*\n\s*hasKey:\s*false/)
  assert.doesNotMatch(routeSource, /smtpReady:\s*false/)
  // 状态必须由 mailer 的真实配置推导
  assert.match(routeSource, /wired:\s*ready/)
})

test('/admin/verify/save 真的把 SMTP 字段写进 mail.smtp', () => {
  const start = routeSource.indexOf("router.post('/admin/verify/save'")
  assert.ok(start > 0, '找不到保存路由')
  const body = routeSource.slice(start, start + 4000)
  assert.match(body, /mail\.smtp/)
  for (const field of ['smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpPass', 'smtpFrom']) {
    assert.match(body, new RegExp(field), `保存逻辑丢了 ${field}`)
  }
})

test('/admin/verify/save 不把掩码当成新口令存进去，也不清空未提交的字段', () => {
  const start = routeSource.indexOf("router.post('/admin/verify/save'")
  const body = routeSource.slice(start, start + 4000)
  assert.match(body, /nextPass === '\*\*\*\*\*\*\*\*'/)
  // 留空的字段沿用原值
  assert.match(body, /\|\|\s*current\.host/)
  assert.match(body, /\|\|\s*current\.user/)
  assert.match(body, /\|\|\s*current\.from/)
})

test('位数设置前后端字段名一致 —— length 与 digits 曾经分叉过', () => {
  const start = routeSource.indexOf("router.post('/admin/verify/save'")
  const body = routeSource.slice(start, start + 4000)
  assert.match(body, /data\.digits \|\| data\.length/, '后端要同时接受 digits 与 length')
  assert.match(verifyVue, /v-model="form\.digits"/, '前端应绑定 digits')
  assert.doesNotMatch(verifyVue, /v-model="form\.length"/)
})

test('邮件口令在读取接口里只回掩码', () => {
  const mailGet = routeSource.slice(
    routeSource.indexOf("router.get('/admin/mail'"),
    routeSource.indexOf("router.post('/admin/mail'")
  )
  assert.match(mailGet, /pass: smtp\.pass \? '\*{8}' : ''/)
  const verifyStart = routeSource.indexOf("router.get('/admin/verify'")
  const verifyGet = routeSource.slice(verifyStart, routeSource.indexOf("router.post('/admin/verify/save'"))
  assert.match(verifyGet, /smtpPass: smtp\.pass \? '\*{8}' : ''/)
})

test('测试发信接口返回真实 HTTP 状态码，不再一律 200', () => {
  const start = routeSource.indexOf("router.post('/admin/mail/test'")
  const body = routeSource.slice(start, start + 900)
  assert.match(body, /res\.status\(status\)/, '失败必须带非 2xx 状态码')
  assert.match(body, /MAIL_NOT_CONFIGURED' \? 503/)
  assert.match(body, /BAD_EMAIL' \? 400 : 502/)
})

test('mailer 不再对外暴露只回一句原始报错的 verify()', () => {
  assert.doesNotMatch(mailerSource, /async verify\(\)\s*\{/)
  assert.match(mailerSource, /async sendTest\(to\)/)
})

test('nodemailer 是生产依赖 —— 线上漏装会让 configured 恒为 false', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.dependencies.nodemailer, 'nodemailer 必须在 dependencies 里')
})
