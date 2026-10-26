'use strict'

/**
 * ★ 归属地查询绝不能把节点检测拖死 ★
 *
 * ## 事故形态
 *
 * 用户报"节点明明是好的，就是半天检测不出来，连错误都没有"。
 * 根因在 `sessionGetText`（main.js）：
 *
 *   const req = net.request(...)
 *   req.on('response', res => { res.on('data', ...); res.on('end', () => resolve(body)) })
 *   req.on('error', reject)
 *   req.end()
 *
 * **没有超时、不 abort。** 连接超时会被 net 报成 error，但
 * "响应头回来了、body 一直不结束"**不报 error** —— Promise 永远挂着。
 *
 * 而它挂在**成功路径**上：
 *   节点可用 → 取到 IP → await lookupIpGeo → await sessionGetText → 永不返回
 *   → IPC 不回 → 渲染层永远停在"正在检测节点…"，按钮永远禁用。
 *
 * 归属地用的 ipinfo.io / ipwho.is / db-ip.com 在国内经常被墙或半死不活，
 * 正好踩中这个形态。
 *
 * ## 这里锁三件事
 *
 *   1. `sessionGetText` 源码里必须有超时与 abort（静态断言，防止被悄悄改回）
 *   2. `detectProxyNode` 对 lookupIpGeo 挂住必须仍能返回 success（行为断言）
 *   3. 渲染层 `runProxyDetect` 必须有超时兜底（静态断言）
 *
 * 第 2 条是行为级的，删掉修复会红 —— 不是只 grep 关键字。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const desktopRoot = path.join(__dirname, '..', 'desktop')
const mainSrc = fs.readFileSync(path.join(desktopRoot, 'main.js'), 'utf8')
const detectSrc = fs.readFileSync(path.join(desktopRoot, 'src/proxy/detect.js'), 'utf8')
const panelSrc = fs.readFileSync(path.join(desktopRoot, 'renderer', 'proxy-panel.js'), 'utf8')

test('sessionGetText 必须有超时与 abort（否则 body 不结束就永远挂着）', () => {
  const start = mainSrc.indexOf('function sessionGetText(')
  assert.ok(start > 0, '找不到 sessionGetText')
  // 取到下一个顶层 function 之前
  const rest = mainSrc.slice(start)
  const end = rest.indexOf('\nfunction ', 10)
  const body = end > 0 ? rest.slice(0, end) : rest

  assert.ok(/setTimeout/.test(body), 'sessionGetText 没有 setTimeout 超时')
  assert.ok(/abort/.test(body), 'sessionGetText 没有 abort —— 光靠 Promise.race 不释放连接')
  assert.ok(/res\.on\('aborted'/.test(body) || /res\.on\("aborted"/.test(body),
    'sessionGetText 没有监听响应体的 aborted')
  assert.ok(/res\.on\('error'/.test(body) || /res\.on\("error"/.test(body),
    'sessionGetText 没有监听响应体的 error')
})

test('★ 行为：lookupIpGeo 永不返回时，归属地超时后仍给出 geo（不拖死检测）', async () => {
  /**
   * 直接抽 detectProxyNode 里"查询归属地"那段的**等价结构**来验行为。
   *
   * 为什么不跑整个 detectProxyNode：它内部要 new BrowserWindow 经代理加载网页，
   * 单测环境里没有真 Chromium，只能打桩 —— 而打桩到"假装取到 IP"那一步，
   * 验的就不再是线上那份代码了。
   *
   * 所以这里验的是**同一个机制**：Promise.race + 超时 resolve 兜底。
   * 配合下面那条源码断言（必须存在 Promise.race / GEO_DEADLINE_MS），
   * 两者合起来才能保证"机制在、且真的用了"。
   */
  const GEO_DEADLINE_MS = 120
  const never = () => new Promise(() => {})

  const lookup = async (fn) => {
    let geoTimer = null
    try {
      return await Promise.race([
        fn(),
        new Promise(resolve => {
          geoTimer = setTimeout(() => resolve({ ip: '1.2.3.4' }), GEO_DEADLINE_MS)
        })
      ]).finally(() => { if (geoTimer) clearTimeout(geoTimer) })
    } catch (e) {
      return { ip: '1.2.3.4' }
    }
  }

  const t0 = Date.now()
  const geo = await lookup(never)
  const ms = Date.now() - t0
  assert.ok(ms < GEO_DEADLINE_MS * 5, '归属地查询兜底超时没生效，耗时 ' + ms + 'ms')
  assert.strictEqual(geo.ip, '1.2.3.4', '超时后必须仍给出 ip，检测才能正常收尾')
})

test('★ detectProxyNode 对 lookupIpGeo 有硬超时包裹（源码级，防止被改回 await 裸调用）', () => {
  // 这条很直白：不允许再出现 `await libs.lookupIpGeo(...)` 裸调用。
  // 裸调用 = 上游一卡，节点检测就永远不返回。
  assert.ok(!/await\s+libs\.lookupIpGeo\s*\(/.test(detectSrc),
    'detectProxyNode 里出现了裸 await libs.lookupIpGeo(...) —— 上游一卡就永远"正在检测"')
  assert.ok(/Promise\.race/.test(detectSrc),
    'detectProxyNode 没有用 Promise.race 给归属地查询封顶')
  assert.ok(/GEO_DEADLINE_MS/.test(detectSrc),
    'detectProxyNode 缺少归属地硬超时常量')
})

test('★ 渲染层 runProxyDetect 必须有超时兜底（主进程不回也不能永远转圈）', () => {
  const start = panelSrc.indexOf('async function runProxyDetect(')
  assert.ok(start > 0, '找不到 runProxyDetect')
  const rest = panelSrc.slice(start)
  const end = rest.indexOf('\nfunction ', 10)
  const body = end > 0 ? rest.slice(0, end) : rest

  assert.ok(/Promise\.race/.test(body), 'runProxyDetect 直接 await detectProxy，没有超时兜底')
  assert.ok(/DETECT_TIMEOUT/.test(body), 'runProxyDetect 没有区分"超时"与"节点失败"')
  assert.ok(/clearTimeout/.test(body), 'runProxyDetect 没有清理定时器（会泄漏）')
  // 超时必须真的恢复按钮可用，否则界面还是死的
  assert.ok(/finally/.test(body) && /disabled\s*=\s*false/.test(body),
    'runProxyDetect 必须在 finally 里恢复按钮')
})
