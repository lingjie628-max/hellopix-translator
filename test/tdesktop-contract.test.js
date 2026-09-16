'use strict'

// 魔改 tdesktop（C++）↔ 启动器（JS）↔ 正式后端（Node）三方契约的交叉验证。
//
// 这一层此前完全没有测试：C++ 读的 JSON 键、POST 的路径、带的请求头、表单字段名，
// 全靠人工核对。而它恰好是"装了 exe 但气泡不出译文"这类故障的高发区 ——
// 任何一边改了名字，编译照样成功、测试照样全绿，只有真机联调才会暴露。
//
// 这里的做法是从 C++ 源码里把字面量抽出来，跟 JS/服务端的真实定义逐项对齐，
// 而不是把期望值再抄一遍（抄一遍等于没测）。

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { BRIDGE_NAME, buildBridge } = require('../standalone/telegram-win/lib/bridge')

const ROOT = path.join(__dirname, '..')
const CPP = path.join(
  ROOT, 'standalone/telegram-win/tdesktop-fork/hello_pix_translate_provider.cpp'
)
const CPP_HEADER = path.join(
  ROOT, 'standalone/telegram-win/tdesktop-fork/hello_pix_translate_provider.h'
)
const PRODUCTION_ROUTES = path.join(ROOT, 'server/routes/production.js')
const REGISTER_API = path.join(ROOT, 'server/register-production-api.js')
const AUTH_SERVICE = path.join(ROOT, 'server/services/auth-service.js')
const SECURITY = path.join(ROOT, 'server/security.js')
const CORE_SERVICE = path.join(ROOT, 'server/services/core-service.js')

const read = (file) => fs.readFileSync(file, 'utf8')

// 抽出形如 object.value(u"apiBase"_q) 里的键名
function quotedKeys(text) {
  return [...text.matchAll(/value\(u"([^"]+)"_q\)/g)].map((m) => m[1])
}

// 抽出形如 form.addQueryItem(u"text"_q, ...) 里的表单字段名
// C++ 里有的字段是多行写法（addQueryItem( 换行后才是 u"to"_q），所以要允许空白
function formFields(text) {
  return [...text.matchAll(/addQueryItem\(\s*u"([^"]+)"_q/g)].map((m) => m[1])
}

function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker)
  assert.notEqual(start, -1, `C++ 源码里找不到锚点: ${startMarker}`)
  const end = text.indexOf(endMarker, start)
  assert.notEqual(end, -1, `C++ 源码里找不到结束锚点: ${endMarker}`)
  return text.slice(start, end)
}

test('tdesktop bridge json keys match what the launcher writes', () => {
  const cpp = read(CPP)
  const reader = sliceBetween(cpp, 'Bridge ReadBridge()', 'class HelloPixTranslateProvider')
  const cppKeys = new Set(quotedKeys(reader))

  const written = buildBridge({
    apiBase: 'http://127.0.0.1:8080',
    deviceId: 'dev',
    cookies: { pix_session: 's', pix_csrf: 't' },
    prefs: { engine: 'deepseek', lang: 'zh', transRecv: true, transSend: true, transGroup: true }
  })
  const jsKeys = new Set(Object.keys(written))

  const missingInCpp = [...jsKeys].filter((key) => !cppKeys.has(key))
  const readButNeverWritten = [...cppKeys].filter((key) => !jsKeys.has(key))
  assert.deepEqual(
    missingInCpp,
    [],
    `启动器写了这些键但魔改电报不读（写了也白写）: ${missingInCpp.join(', ')}`
  )
  assert.deepEqual(
    readButNeverWritten,
    [],
    `魔改电报读这些键但启动器从不写（永远是默认值）: ${readButNeverWritten.join(', ')}`
  )
})

test('tdesktop reads the same bridge filename the launcher writes', () => {
  const cpp = read(CPP)
  assert.match(
    cpp,
    new RegExp(`u"${BRIDGE_NAME.replace('.', '\\.')}"_q`),
    `C++ 里的桥接文件名必须与 BRIDGE_NAME(${BRIDGE_NAME}) 一致`
  )
})

test('tdesktop posts to the endpoint the server actually mounts', () => {
  const cpp = read(CPP)
  const posted = cpp.match(/apiBase \+ u"([^"]+)"_q/)
  assert.ok(posted, 'C++ 里找不到翻译请求路径')
  const cppPath = posted[1]

  const register = read(REGISTER_API)
  const mount = register.match(/app\.use\('([^']+)', productionRouter/)
  assert.ok(mount, '找不到 production 路由的挂载前缀')
  const routes = read(PRODUCTION_ROUTES)
  // production.js 里有多个 router.post，要取所有声明的路径，
  // 再看 C++ 打的那条是不是"挂载前缀 + 某个已声明路径"
  const declared = [...routes.matchAll(/router\.post\('([^']+)'/g)].map((m) => m[1])
  assert.ok(declared.length > 0, '找不到任何 translate 路由声明')

  const matched = declared.find((route) => `${mount[1]}${route}` === cppPath)
  assert.ok(
    matched,
    `魔改电报打到 ${cppPath}，但服务端没声明这条路由（已声明: ${declared.map((r) => mount[1] + r).join(', ')}）`
  )
})

test('tdesktop form fields are the ones the server reads', () => {
  const cpp = read(CPP)
  const sent = new Set(formFields(cpp))
  assert.deepEqual(
    [...sent].sort(),
    ['engine', 'from', 'text', 'to'],
    'C++ 表单字段发生变化时，服务端读取逻辑(core-service data.*)要一起改'
  )
  const core = read(CORE_SERVICE)
  for (const field of sent) {
    assert.match(
      core,
      new RegExp(`data\\.${field}\\b`),
      `服务端 core-service 没有读取表单字段 data.${field}`
    )
  }
})

test('tdesktop request headers match what the server enforces', () => {
  const cpp = read(CPP)
  for (const header of ['X-Pix-Device', 'X-CSRF-Token', 'Cookie', 'Idempotency-Key']) {
    assert.ok(
      cpp.includes(`"${header}"`),
      `C++ 必须带上 ${header}，否则服务端会拒绝或无法绑定设备`
    )
  }

  // 服务端实际读取的头（大小写在 Node 里不敏感，这里比对小写形式）
  const auth = read(AUTH_SERVICE)
  assert.match(auth, /req\.headers\['x-pix-device'\]/, 'auth-service 不再读 x-pix-device')
  const security = read(SECURITY)
  assert.match(security, /req\.headers\['x-csrf-token'\]/, 'security 不再读 x-csrf-token')
  const routes = read(PRODUCTION_ROUTES)
  assert.match(routes, /Idempotency-Key/, 'production 路由不再要求 Idempotency-Key')

  // 设备绑定是硬校验: 请求带 x-pix-device 且与登录设备不符会被拒
  assert.match(
    auth,
    /startsWith\('\/client\/'\)\s*\|\|\s*req\.headers\['x-pix-device'\]/,
    '设备绑定校验逻辑变了，桥接里的 deviceId 必须与登录设备一致这条前提要重新确认'
  )
})

test('tdesktop parses the response fields the server returns', () => {
  const cpp = read(CPP)
  const handler = cpp.slice(cpp.indexOf('QNetworkReply::finished'))
  const keys = new Set(quotedKeys(handler))
  assert.ok(keys.has('success'), 'C++ 不读 success，失败响应会被当成译文')
  assert.ok(keys.has('translation'), 'C++ 不读 translation，气泡里没内容可显示')

  const core = read(CORE_SERVICE)
  const response = sliceBetween(core, 'const response = {', 'if (!refundable)')
  for (const key of ['success', 'translation']) {
    assert.match(
      response,
      new RegExp(`\\b${key}\\b`),
      `服务端响应对象里没有 ${key} 字段，C++ 会解析失败`
    )
  }
})

test('tdesktop provider exports the hooks the patch injects', () => {
  const header = read(CPP_HEADER)
  const cpp = read(CPP)
  for (const hook of [
    'CreateHelloPixTranslateProvider',
    'HelloPixShouldTranslateIncoming',
    'HelloPixShouldTranslateSend',
    'HelloPixShouldTranslateGroup',
    'HelloPixTargetLanguage'
  ]) {
    assert.ok(header.includes(hook), `头文件缺少 ${hook} 的声明`)
    assert.ok(cpp.includes(hook), `实现里缺少 ${hook}`)
  }

  // 补丁往 tdesktop 里注入的调用点，必须都能在 provider 里找到实现
  const apply = read(path.join(ROOT, 'standalone/telegram-win/tdesktop-fork/apply.py'))
  for (const hook of ['HelloPixShouldTranslateIncoming', 'HelloPixShouldTranslateSend', 'HelloPixShouldTranslateGroup']) {
    assert.ok(
      apply.includes(`Ui::${hook}()`),
      `apply.py 没有把 ${hook} 注入 tdesktop，桥接开关会变成空壳`
    )
    assert.ok(header.includes(hook), `${hook} 被注入但 provider 没有实现`)
  }
})
