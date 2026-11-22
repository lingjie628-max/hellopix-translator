'use strict'

/**
 * ★ 打包清单里的文件必须真的存在 ★
 *
 * ## 为什么要有这条
 *
 * 1.2.5 发版时，`desktop/guest-inject.js` 被整份删掉（4910 行）并提交，
 * 版本号却照常升到 1.2.5 发了出去。这个文件是翻译功能的 preload ——
 * 没有它，客户端**翻译整个失效**，而所有测试都是绿的：
 *
 *   · 测试跑的是 require 到的模块，文件不存在就直接 import 失败，
 *     但没人在 CI 里检查"package.json 的 files 清单是否可满足"
 *   · electron-builder 的 files 里写了不存在的文件**不报错**，静默跳过
 *   · 用户装完才发现：翻译按钮点了没反应 / 显示"翻译组件未启动"
 *
 * 这条测试只问一件事：**build.files 里每条字面量路径，构建时是否真的存在**。
 * 它不保证功能正确，但它保证"我们不会把一个缺文件的包装发给用户"。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const desktopRoot = path.join(__dirname, '..', 'desktop')
const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'))

test('desktop/package.json 的 build.files 每一项都必须真实存在', () => {
  const files = (pkg.build && pkg.build.files) || []
  assert.ok(files.length > 0, 'build.files 不能为空')

  const missing = []
  for (const entry of files) {
    // 只检查字面量（不含 * 通配）。通配项由 electron-builder 自己展开，
    // 允许匹配 0 个文件（例如某个可选目录还没建）。
    if (/[*?{}[\]]/.test(entry)) continue
    // 以 ! 开头的是排除规则，不要求存在
    if (entry.startsWith('!')) continue
    const abs = path.join(desktopRoot, entry)
    if (!fs.existsSync(abs)) missing.push(entry)
  }

  assert.deepStrictEqual(missing, [],
    'build.files 里这些文件不存在，打出来的包会缺东西：\n  ' + missing.join('\n  '))
})

test('★ 翻译 preload（guest-inject.js）必须在且非空', () => {
  // 单独再钉一条：这是 1.2.5 事故的直接受害文件。
  // 泛化检查可能被"从清单里删掉"绕过，这条不会。
  const p = path.join(desktopRoot, 'guest-inject.js')
  assert.ok(fs.existsSync(p), 'desktop/guest-inject.js 不存在 —— 翻译桥会整个失效')
  const src = fs.readFileSync(p, 'utf8')
  assert.ok(src.length > 50000,
    'guest-inject.js 只有 ' + src.length + ' 字节，像是被写空了（正常 200KB+）')
  // 核心能力必须在：emoji 保管 + 翻译入口
  for (const needle of ['maskEmoji', 'restoreEmoji', 'translateParsed']) {
    assert.ok(src.includes(needle), 'guest-inject.js 缺少关键实现：' + needle)
  }
})

test('打包清单里必须声明 guest-inject.js（不能让 preload 漏在包外）', () => {
  const files = (pkg.build && pkg.build.files) || []
  assert.ok(files.includes('guest-inject.js'),
    'build.files 没有包含 guest-inject.js —— 装完的客户端翻译会失效')
})

test('打包清单里必须声明计数工单 preload', () => {
  const files = (pkg.build && pkg.build.files) || []
  assert.ok(files.includes('ticket-preload.js'),
    'build.files 没有包含 ticket-preload.js —— 桌面进粉中心会跳登录页')
})
