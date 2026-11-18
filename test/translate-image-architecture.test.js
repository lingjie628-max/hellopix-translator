'use strict'

/**
 * 图片翻译的**架构约束**。
 *
 * ## 这个文件是给以后的人看的
 *
 * 前面几个文件测的是"功能对不对"，这个文件测的是"**架构有没有被破坏**"。
 * 每一条都对应一个已经发生过、或者差一点发生的事故：
 *
 *   1. 成本不落台账 → 2026-10-11 DeepSeek 成本记 0，月度对账少一整块；
 *   2. 共用文本限额 → 图片单价几十倍，限额形同虚设；
 *   3. 自己解析通道 → 绕过套餐权益，没买 GPT 的商户也能用；
 *   4. 重复点击不缓存 → 用户点两次，我们付两次钱；
 *   5. 模板里写块注释 → 整段 UI 脚本断裂，功能静默消失。
 *
 * 这些不是"最好有"，是**破了就会真金白银亏钱或漏权限**。
 * 以后谁想重构图片翻译，先把这里跑绿。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('★ 架构1：图片翻译必须把成本落台账（防"成本记 0"事故重演）', () => {
  const src = read('server/services/core-service.js')
  // 定位 translateImage 方法体
  const start = src.indexOf('async translateImage(session, data)')
  assert.ok(start > 0, '找不到 translateImage')
  const body = src.slice(start, start + 6000)
  assert.match(
    body, /recordUpstreamUsage/,
    'translateImage 必须调用 recordUpstreamUsage —— 否则图片成本完全不进台账，' +
    '而图片单价远高于文本，漏记的损失比 2026-10-11 那次更大'
  )
})

test('★ 架构2：图片限额必须独立，不能搭文本的便车', () => {
  const ctx = read('server/routes/context.js')
  const routes = read('server/routes/production.js')

  assert.match(ctx, /translateImageIp\s*:/, '必须有独立的图片 IP 限额')
  assert.match(ctx, /translateImageAccount\s*:/, '必须有独立的图片账号限额')
  assert.match(ctx, /translateImageParentDaily\s*:/, '必须有按主账号的日成本上限')
  assert.match(routes, /translateImageParentDailyLimit/, '图片路由必须挂主账号日限额')

  // 路由必须用图片自己的限额
  const line = routes.split('\n').find(l => /router\.post\('\/translate\/image'/.test(l))
  assert.ok(line, '找不到 /translate/image 的注册行')
  assert.match(line, /translateImageIpLimit/, '图片路由必须挂图片 IP 限额')
  assert.match(line, /translateImageAccountLimit/, '图片路由必须挂图片账号限额')
  assert.doesNotMatch(
    line, /translateIpLimit|translateAccountLimit/,
    '图片路由不能复用文本限额 —— 一次图片的成本是文本的几十到几百倍，' +
    '共用额度等于限额失效'
  )

  // 数字必须比文本更严
  const imgMax = Number((ctx.match(/translateImageAccount:\s*limit\('translate-image-account',\s*(\d+)/) || [])[1])
  const txtMax = Number((ctx.match(/translateAccount:\s*limit\('translate-account',\s*(\d+)/) || [])[1])
  assert.ok(imgMax > 0 && txtMax > 0, '两个限额都要能解析出数字')
  assert.ok(imgMax < txtMax, '图片限额必须比文本更严（实际 ' + imgMax + ' vs ' + txtMax + '）')
})

test('★ 架构3：图片翻译必须复用文本的通道解析（否则绕过套餐权益）', () => {
  const src = read('server/services/core-service.js')
  const start = src.indexOf('async translateImage(session, data)')
  const body = src.slice(start, start + 6000)
  assert.match(
    body, /resolveTranslateEngine/,
    '必须走 resolveTranslateEngine —— 自己解析通道 = 没买 GPT 也能用，直接漏权限'
  )
})

test('★ 架构4：图片结果必须有缓存（重复点击不能重复付费）', () => {
  const src = read('desktop/src/ipc/translate.js')
  assert.match(src, /imageCache/, '缺图片结果缓存')
  assert.match(src, /imageCacheGet/, '缺读缓存')
  assert.match(src, /imageCachePut/, '缺写缓存')
  // 容量上限：常驻软件里无界 Map 就是内存泄漏
  assert.match(src, /IMAGE_CACHE_MAX/, '缺容量上限（常驻软件无界增长 = 内存泄漏）')
  assert.match(src, /accountKey/, '客户端图片缓存键必须带账号')
  assert.match(src, /engineKey/, '客户端图片缓存键必须带引擎')
})

test('★ 架构4b：服务端图片请求必须有内容锁和短期结果缓存', () => {
  const src = read('server/services/core-service.js')
  assert.match(src, /image:result:/, '缺服务端图片结果缓存键')
  assert.match(src, /image:lock:/, '缺服务端图片并发锁')
  assert.match(src, /IMAGE_REQUEST_IN_PROGRESS/, '并发重放必须明确拒绝')
  assert.match(src, /'PX',\s*10 \* 60_000/, '图片结果缓存必须有短 TTL')
})

test('★ 架构5：注入脚本内部不许块注释（模板会被截断）', () => {
  const { buildImageTranslateScript } = require('../desktop/src/translate/image-translate-ui.js')
  const src = buildImageTranslateScript()
  const body = src.slice(src.indexOf('(function installImageTranslate'))
  assert.equal(body.indexOf('/*'), -1,
    '注入脚本内部用了块注释 —— 它整体在模板字符串里，*/ 会提前截断模板')
})

test('★ 架构6：图片功能下线后不再为 /translate/image 放开大 body', () => {
  const src = read('server/index.js')
  const lines = src.split('\n')
  const findLine = re => lines.findIndex(l => re.test(l) && !/^\s*[*/]/.test(l))
  const globalIdx = findLine(/app\.use\(express\.json\(\{\s*limit:\s*'256kb'[^}]*\}\)\)/)
  assert.ok(globalIdx >= 0, '找不到全局 256kb 解析器')
  assert.match(lines[globalIdx], /256kb/, '全局限制必须保持 256kb')
  assert.equal(
    findLine(/app\.use\('\/apis\/translate\/image',\s*express\.json/),
    -1,
    '图片翻译已下线，不能继续为它开放 16MB body'
  )
})

test('★ 架构7：图片路由必须挂在 CSRF 之后（不是公开端点）', () => {
  const src = read('server/routes/production.js')
  const csrfIdx = src.indexOf('router.use(security.csrf)')
  const imageIdx = src.indexOf("router.post('/translate/image'")
  assert.ok(csrfIdx > 0 && imageIdx > 0)
  assert.ok(csrfIdx < imageIdx, '图片路由必须在 CSRF 中间件之后注册')
})

test('★ 架构8：同步 IPC 通道必须带来源校验（否则任意页面可拉取）', () => {
  const src = read('desktop/src/ipc/translate.js')
  const idx = src.indexOf("reg.handleSync('translate:pageScripts'")
  assert.ok(idx > 0, '找不到同步通道注册')
  const line = src.slice(idx, idx + 600)
  assert.match(line, /trustedTabSender/,
    '同步通道必须校验来源 —— 它返回的是页面世界脚本的 URL，任意嵌入页面不该拿得到')
})

test('★ 架构9：同步通道拒绝时也必须 setReturnValue（否则渲染进程卡死）', () => {
  const src = read('desktop/src/ipc/registrar.js')
  const start = src.indexOf('function handleSync')
  assert.ok(start > 0)
  const body = src.slice(start, start + 1200)
  assert.match(body, /event\.returnValue\s*=\s*value/,
    '同步通道必须无条件 setReturnValue —— 漏一个分支就是整个页面挂住')
})

test('★ 架构10：图片适配器必须归一化 usage（字段名不匹配 = 成本记 0）', () => {
  const src = read('server/services/translation-image.js')
  assert.match(src, /normalizeUsage/,
    '必须调 normalizeUsage —— 上游给的是 prompt_tokens，台账读的是 promptTokens，' +
    '不归一化就是 2026-10-11 事故的原样重演')
  assert.doesNotMatch(src, /usage:\s*data\s*&&\s*data\.usage/,
    '不能直接透传上游原始 usage')
})
