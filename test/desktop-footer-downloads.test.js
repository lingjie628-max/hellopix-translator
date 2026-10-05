'use strict'

/**
 * 底部下载入口的守卫测试。
 *
 * ## 被测的真实缺陷
 *
 * 客户端底部的「安卓手机版」「苹果手机版」按钮是 index.html 里**静态写死**的，
 * 而产品没有任何移动端 —— 服务端 `clientDownloads.android` / `.ios` 下发的是
 * 空字符串（core-service.js 的 `download()` 在 client_releases 里查不到记录就
 * 返回 ''，生产环境实测确实为空）。
 *
 * 于是这两个按钮**点了毫无反应**：`runFooterAction` 对空 URL 直接 `return`，
 * 既不打开链接也不报错。用户看到的不是"没有这个功能"，而是"软件坏了"。
 *
 * 更糟的是它和迁移 035 的结论直接冲突 —— 035 刚把「手机版」这个兑现不了的
 * 权益承诺从套餐文案里摘掉（理由写在那个文件头部），客户端底部却还在暗示
 * 有两个手机版可以下载。
 *
 * ## 这个测试为什么能测语义
 *
 * 渲染层没有 DOM 环境（仓库里没有 jsdom），所以这里不去模拟点击，而是把
 * 判定逻辑单独抽成纯函数 `footerDownloadVisible(key, downloads)`，
 * **从源码里切出来真的执行**。这样测的是"给定下发数据，按钮会不会显示"，
 * 而不是"源码里有没有出现某个字符串"。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const appSource = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'app.js'), 'utf8')
const htmlSource = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'index.html'), 'utf8')

/** 按大括号配平切出一个具名函数的源码 —— 比正则可靠，也比在源码里埋标记干净。 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start > 0, `源码里找不到函数 ${name}`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`函数 ${name} 的大括号不配平`)
}

// 把纯函数从渲染层源码里取出来执行。它不碰 DOM / window，所以能直接跑。
const footerDownloadVisible = new Function(
  `${extractFunction(appSource, 'footerDownloadVisible')}; return footerDownloadVisible`
)()

// ------------------------------------------------------------ 判定语义

test('★ 没有下载地址的入口不显示（生产环境 android/ios 就是空的）', () => {
  // 生产 /apis/site/info 实测：android 与 ios 都是空字符串。
  const live = { app: '', windows: 'https://pixfanyi.com/x.exe', macos: 'https://pixfanyi.com/x.dmg', android: '', ios: '' }

  assert.equal(footerDownloadVisible('android', live), false,
    '安卓入口在没有下载地址时仍会显示 —— 用户点下去毫无反应')
  assert.equal(footerDownloadVisible('ios', live), false,
    '苹果手机入口在没有下载地址时仍会显示 —— 用户点下去毫无反应')

  // 有真实地址的必须留着，否则会误伤正常功能。
  assert.equal(footerDownloadVisible('windows', live), true, 'Windows 有地址却不显示')
  assert.equal(footerDownloadVisible('macos', live), true, 'macOS 有地址却不显示')
})

test('app 恒由 checkUpdate 决定显隐；standalone 按是否存在在架独立应用显隐', () => {
  // app → checkUpdate()，不读 downloads.app。
  assert.equal(footerDownloadVisible('app', {}), true,
    'app 入口依赖 checkUpdate，不能因为没有 downloads.app 就隐藏')

  // standalone → standaloneApps。**没有在架独立应用时必须隐藏** —— 否则就是
  // 迁移 036 要摘掉的那种"有权益、没东西"：按钮在，点下去只弹「独立应用尚未上架」。
  assert.equal(footerDownloadVisible('standalone', {}), false,
    '没有在架独立应用时 standalone 入口仍然显示 —— 又是有权益没东西')
  assert.equal(footerDownloadVisible('standalone', { standaloneApps: [] }), false,
    '空的 standaloneApps 列表不应让入口显示')
  assert.equal(footerDownloadVisible('standalone', { standaloneApps: [{ url: '' }] }), false,
    '空地址的独立应用不算"可下载"')

  // 有真实在架记录时必须留着，否则会误伤恢复后的正常功能。
  assert.equal(
    footerDownloadVisible('standalone', { standaloneApps: [{ app: 'telegram-z', url: 'https://x/y.exe' }] }),
    true,
    '登记了在架独立应用却不显示 —— 恢复路径被挡住了'
  )
})

test('数据异常时按"不显示"处理，不能抛错', () => {
  // 显隐逻辑跑在界面初始化路径上，这里抛错会让整个底部栏渲染不出来。
  assert.equal(footerDownloadVisible('android', undefined), false)
  assert.equal(footerDownloadVisible('android', null), false)
  assert.equal(footerDownloadVisible('android', {}), false)
  assert.equal(footerDownloadVisible('', {}), false)
})

test('用排除法而非白名单：新加入口默认按 URL 判断（不会又冒出死按钮）', () => {
  // 这是这个修法的关键性质。若改成白名单（只对 windows/macos 生效），
  // 以后新增的下载入口会默认可见 —— 同样的"点下去没反应"会再来一次。
  assert.equal(footerDownloadVisible('某个未来新增的入口', {}), false,
    '未知下载入口在无地址时被判定为显示 —— 说明用了白名单，新入口会重现死按钮')
  assert.equal(footerDownloadVisible('某个未来新增的入口', { 某个未来新增的入口: 'https://x' }), true)
})

// ------------------------------------------------------------ 接线

test('★ applySupport 必须调用显隐同步（否则逻辑存在但不生效）', () => {
  const at = appSource.indexOf('function applySupport(')
  assert.ok(at > 0, '找不到 applySupport')
  const body = appSource.slice(at, appSource.indexOf('\n}', at))
  assert.match(body, /syncFooterDownloads\(/, 'applySupport 没有调用 syncFooterDownloads —— 按钮仍然恒显')
})

test('syncFooterDownloads 遍历的正是底部的下载按钮', () => {
  const body = extractFunction(appSource, 'syncFooterDownloads')
  assert.match(body, /data-footer-action="download"/, '选择器没对上底部的下载按钮')
  assert.match(body, /dataset\.downloadKey/, '没有读取按钮的 downloadKey')
})

test('index.html 里移动端入口仍以 data-download-key 标注（才能被自动显隐）', () => {
  // 若哪天有人把 android/ios 按钮改成不带 data-download-key 的普通按钮，
  // 显隐逻辑就管不到它了 —— 死按钮会绕开守卫重新出现。
  for (const key of ['android', 'ios']) {
    assert.match(
      htmlSource,
      new RegExp(`data-footer-action="download"[^>]*data-download-key="${key}"`),
      `${key} 入口缺少 data-download-key，无法被自动显隐`
    )
  }
})

test('⚠️ 空 URL 的下载入口在 runFooterAction 里是静默返回（本缺陷的根因）', () => {
  // 这条不是要求改 runFooterAction，而是把"为什么必须靠显隐兜住"钉在测试里：
  // 只要它还是静默 return，任何没有地址的入口出现在界面上就一定是死按钮。
  const at = appSource.indexOf('async function runFooterAction(')
  assert.ok(at > 0, '找不到 runFooterAction')
  const body = appSource.slice(at, appSource.indexOf('\n}', at))
  assert.match(body, /if \(downloadKey !== 'app'\) return/,
    'runFooterAction 的空 URL 处理变了 —— 请重新确认"死按钮"这个结论是否还成立')
})
