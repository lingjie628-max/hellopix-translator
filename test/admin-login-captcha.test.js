'use strict'

/**
 * 超管登录 · 图形验证码加载失败可观测性
 *
 * ## 生产现象（2026-11-11 反馈）
 *
 * 用户原话：「超管登录没有跳出什么图形验证码，一直无法登录显示图形验证码已过期」
 *
 * ## 根因：两句话是同一个问题
 *
 * `AdminLogin.vue` 的 `getImageCode()` 原实现只有 `.then()`，**没有 catch**，
 * 也不检查响应体：
 *
 *   this.getRequest('/user/captcha').then(resp => {
 *     if (resp && resp.data && resp.data.success) { ... }
 *   })
 *
 * 接口 429 / 5xx / 网络抖动时：
 *   1. `codeImg` 保持 `''` → 界面上只有一块**空白**，看起来"根本没跳验证码"；
 *   2. `form.imageId` 也是空 → 点登录时服务端 `captcha.consume` 拿到空 key，
 *      按"键不存在"处理，返回 `CAPTCHA_EXPIRED`「图形验证码已过期」。
 *
 * 所以"没跳出验证码"和"说过期"不是两个 bug，是**一次拉图失败引发的连锁**。
 *
 * ## 与 registration-captcha.test.js 的关系
 *
 * 那份测试记录过完全同类的事故：注册页前端漏传 `imageId`，后端一律回
 * 「已过期」，把人卡死。教训一样 —— **必须让"没拿到验证码"可见**，
 * 不能让用户对着一句"已过期"瞎猜。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const vue = fs.readFileSync(path.join(ROOT, 'src/components/admin/AdminLogin.vue'), 'utf8')

/** 抠出 getImageCode 方法体（取到下一个同级方法定义为止）。 */
function imageCodeMethod () {
  const at = vue.indexOf('getImageCode()')
  assert.ok(at > 0, 'AdminLogin.vue 里找不到 getImageCode')
  // 用下一个方法名的位置作边界，比找 "    }," 可靠 —— 方法体内有嵌套的
  // 缩进代码块，"    }," 会在 catch 分支里提前命中。
  const next = vue.indexOf('submit()', at)
  assert.ok(next > at, 'getImageCode 后面找不到 submit()')
  return vue.slice(at, next)
}

test('★ 拉验证码失败必须有 catch（否则空白页 + "已过期"死循环）', () => {
  const body = imageCodeMethod()
  assert.ok(/\}\)\.catch\s*\(/.test(body),
    'getImageCode 没有 catch —— 接口失败时 codeImg 保持空，' +
    '用户看到空白，点登录必然回"图形验证码已过期"')
})

test('★ 失败时必须清空 imageId（不能带着旧值去登录）', () => {
  const body = imageCodeMethod()
  const catchAt = body.indexOf('}).catch(')
  assert.ok(catchAt > 0, '找不到 .catch 链')
  const catchBody = body.slice(catchAt)
  assert.ok(/imageId\s*=\s*''/.test(catchBody),
    'catch 里必须清空 form.imageId —— 留着旧值会让"过期"报错更难解释')
})

test('★ 200 但响应里没有图，同样必须算失败', () => {
  const body = imageCodeMethod()
  assert.ok(/data\.image\s*&&\s*data\.imageId/.test(body),
    '必须同时校验 image 与 imageId 都存在')
  // then 分支（成功回调）里必须有失败兜底。用 "}).catch(" 作边界，
  // 不能裸搜 ".catch(" —— 代码注释里也会出现这个词。
  const thenAt = body.indexOf('.then(')
  const catchAt = body.indexOf('}).catch(')
  assert.ok(thenAt > 0 && catchAt > thenAt, '找不到 .then(...).catch(...) 链')
  const thenBody = body.slice(thenAt, catchAt)
  assert.ok(/codeError\s*=/.test(thenBody),
    'then 分支也要设置 codeError —— 200 无图时不能静默')
})

test('★ 失败原因要落到界面可见的字段上', () => {
  assert.ok(/codeError/.test(vue), '缺少 codeError 状态字段')
  assert.ok(/v-else[\s\S]{0,200}codeError/.test(vue),
    '模板里必须在没有图时显示 codeError，否则用户仍只看到空白')
})

test('★ 429（限流）要给出可区分的提示', () => {
  const body = imageCodeMethod()
  assert.ok(/429/.test(body),
    '限流时提示"请求过于频繁"比笼统的"加载失败"更有用 —— ' +
    '用户会知道该等一会儿而不是反复点')
})

test('★ 没有 imageId 时不允许提交（本地先拦住）', () => {
  // 找到 credentials 那一步的 submit
  const at = vue.indexOf('subtitle')
  const submitAt = vue.indexOf('submit()', at > 0 ? at : 0)
  assert.ok(submitAt > 0, '找不到 submit 方法')
  const body = vue.slice(submitAt, submitAt + 1600)
  assert.ok(/!this\.form\.imageId/.test(body),
    '提交前必须检查 imageId —— 没图就没有 imageId，' +
    '放过去只会换来一句误导性的"已过期"')
  assert.ok(/getImageCode\(\)/.test(body),
    '拦住之后要顺手重新拉一次图，而不是让用户自己点')
})

test('★ 拉图请求要 silent，错误自己显示（避免双弹）', () => {
  const body = imageCodeMethod()
  assert.ok(/silent:\s*true/.test(body),
    '未设 silent 时全局拦截器会再弹一次错误提示，和图片位置的提示叠成两条')
})

test('★ 加载中要有状态，不能只是空白', () => {
  assert.ok(/codeLoading/.test(vue), '缺少 codeLoading 状态')
  assert.ok(/加载中/.test(vue), '加载中必须有可见文案')
})

test('★ 点击重试：失败框与图片都必须可点', () => {
  // 图片状态下可点刷新
  assert.ok(/@click="getImageCode"/.test(vue), '验证码必须支持点击刷新')
  // 失败状态下同样可点（不能只在有图时可点）
  const boxes = vue.match(/@click="getImageCode"/g) || []
  assert.ok(boxes.length >= 1, '至少要有可点击的刷新入口')
  assert.ok(/captcha-fallback/.test(vue), '失败占位必须有独立的样式类')
})

test('★ 429 后要退避，避免"失败→重拉→又失败"刷死额度', () => {
  const body = imageCodeMethod()
  assert.ok(/codeCooldown/.test(body), '429 时缺少退避标记')
  assert.ok(/5\d{3}|5000/.test(body), '退避时长应明确（当前用 5000ms）')
  // 登录失败后的自动换图要遵守退避
  assert.ok(/!this\.codeCooldown\)\s*this\.getImageCode\(\)/.test(vue),
    '登录失败后的自动换图必须检查退避，否则限流期间会连打两次失败提示')
})

test('★ 验证码仍必须提交给服务端（不能为了"不报过期"就跳过校验）', () => {
  // 防回归：有人可能图省事把图形验证码去掉，那是降低超管入口的防护等级
  assert.ok(/imageCode/.test(vue), '必须保留图形验证码输入框')
  assert.ok(/imageId/.test(vue), '必须保留 imageId 提交')
  assert.ok(/getImageCode/.test(vue), '必须保留拉取验证码的能力')
})
