/**
 * 登录态落盘：「重启软件掉号」的回归测试。
 *
 * ## 背景
 *
 * Chromium 的 Cookie 是**异步批量写盘**的 —— `cookies.set()` 之后内存里立刻生效，
 * 磁盘上要等它自己找时机落盘。进程若在这之前消失（强杀 / 崩溃 / `app.exit()`），
 * 这批 Cookie 就全丢。各大平台的登录态正挂在 Cookie 上，于是用户看到"重启掉号"。
 *
 * 三个必须守住的契约：
 *
 *   1. **退出前逐个分区 `flushStore()`** —— 包括当前没有窗口的分区（用户可能关了窗口
 *      只留托盘，也可能只是打开软件的瞬间就退出）。
 *   2. **不能用 `cookies.get()` 冒充落盘** —— 它只读，不写。
 *   3. **`relaunchAndExit` 不能调 `app.exit()`** —— 那会跳过 `before-quit`，
 *      把落盘（连同 open-apps 落盘）一起绕过去。反过来，改成 `app.quit()`
 *      若忘了 `preventDefault` / 重入保护，就会陷入"退出→拦→再退出→再拦"的死循环。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')

/** 按花括号配平截出完整函数体（函数里有 if/for/回调，不能停在第一个 `}`）。 */
function extract(src, name) {
  const at = src.indexOf('async function ' + name + '(') >= 0
    ? src.indexOf('async function ' + name + '(')
    : src.indexOf('function ' + name + '(')
  assert.ok(at >= 0, '找不到 ' + name)
  let depth = 0
  const start = src.indexOf('{', at)
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(at, i + 1)
    }
  }
  throw new Error('未闭合：' + name)
}

/**
 * 造一个能跑 flushAllCookies 的最小环境。
 *
 * @param {object} opts
 * @param {string[]} opts.partitions 磁盘上已有的分区目录名
 * @param {object[]} opts.tabs       内存里活着的标签页
 */
function buildFlushEnv(opts) {
  const calls = []
  const throwOn = new Set(opts.throwOn || [])
  const mkSession = (name) => ({
    name,
    cookies: {
      flushStore: async () => {
        calls.push(name)
        if (throwOn.has(name)) throw new Error('flush failed')
      },
      // 只要有人误用 get 就当失败：它不是落盘操作。
      get: () => { throw new Error('flushAllCookies 不该调用 cookies.get()') }
    }
  })
  const fromPartition = (p) => mkSession(p.replace(/^persist:/, ''))
  const visited = []
  const deps = {
    app: { getPath: () => opts.userData || '/tmp/pix-userdata' },
    fs: {
      readdirSync: () => {
        if (opts.noPartitionsDir) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return opts.partitions || []
      }
    },
    path,
    session: { fromPartition: (p) => { visited.push(p); return fromPartition(p) } },
    tabs: opts.tabs || [],
    log: () => {}
  }
  return { deps, calls, visited }
}

function runFlush(env) {
  const fn = extract(mainSrc, 'flushAllCookies')
  // 把源码里的裸标识符换成本地注入的依赖。
  const rebound = fn
    .replace(/^async function flushAllCookies/, 'async function flushAllCookies')
  const factory = new Function(
    'app', 'fs', 'path', 'session', 'tabs', 'console',
    rebound + '\nreturn flushAllCookies;'
  )
  return factory(
    env.deps.app, env.deps.fs, env.deps.path, env.deps.session, env.deps.tabs,
    { error: env.deps.log }
  )
}

test('退出落盘：对每个 pix- 分区都调 flushStore，而不是 cookies.get', async () => {
  const env = buildFlushEnv({ partitions: ['pix-alice-telegram-z-1', 'pix-alice-whatsapp-green-1'] })
  const result = await runFlush(env)({ includeIdle: true })
  assert.equal(result.flushed, 2)
  assert.equal(result.failed, 0)
  // 顺序无关，但集合必须一致
  assert.deepEqual(env.calls.sort(), ['pix-alice-telegram-z-1', 'pix-alice-whatsapp-green-1'])
})

test('退出落盘：不碰别人的分区目录（只认 pix- 前缀）', async () => {
  const env = buildFlushEnv({
    partitions: ['pix-alice-telegram-z-1', 'SomeOtherApp', 'pix', 'temp-cache']
  })
  await runFlush(env)({ includeIdle: true })
  // 'pix' 本身不以 'pix-' 开头，不算我们的
  assert.deepEqual(env.calls, ['pix-alice-telegram-z-1'])
})

test('退出落盘：没有窗口的分区也要刷（关窗口只留托盘的情况）', async () => {
  const env = buildFlushEnv({ partitions: ['pix-alice-telegram-z-1'] })
  const result = await runFlush(env)({ includeIdle: true })
  assert.equal(result.flushed, 1)
})

test('退出落盘：活着的标签页分区同样覆盖（含非 pix- 命名的历史分区）', async () => {
  const env = buildFlushEnv({
    partitions: [],
    tabs: [{
      view: {
        webContents: {
          isDestroyed: () => false,
          session: {
            name: 'live-tab',
            cookies: { flushStore: async () => env.calls.push('live-tab') }
          }
        }
      }
    }]
  })
  const result = await runFlush(env)({ includeIdle: true })
  assert.equal(result.flushed, 1)
  assert.deepEqual(env.calls, ['live-tab'])
})

test('退出落盘：单个分区失败不能影响其它分区', async () => {
  const env = buildFlushEnv({
    partitions: ['pix-a-1', 'pix-b-1'],
    throwOn: ['pix-a-1']
  })
  const result = await runFlush(env)({ includeIdle: true })
  assert.equal(result.failed, 1)
  assert.equal(result.flushed, 1)
})

test('退出落盘：Partitions 目录还不存在时不抛异常（首次启动）', async () => {
  const env = buildFlushEnv({ noPartitionsDir: true })
  const result = await runFlush(env)({ includeIdle: true })
  assert.equal(result.flushed, 0)
  assert.equal(result.failed, 0)
})

test('退出落盘：已销毁的标签页被跳过，不会抛', async () => {
  const env = buildFlushEnv({
    partitions: [],
    tabs: [{ view: { webContents: { isDestroyed: () => true, session: null } } }]
  })
  const result = await runFlush(env)({ includeIdle: true })
  assert.equal(result.flushed, 0)
})

test('before-quit 真的调用了落盘，且带重入保护 + 超时兜底', () => {
  const quitBody = extract(mainSrc, 'flushCookiesBeforeQuit')
  assert.ok(/flushAllCookies\(/.test(quitBody), '必须真的调 flushAllCookies')
  assert.ok(/event\.preventDefault\(\)/.test(quitBody), '必须先拦住退出等落盘')
  assert.ok(/cookieFlushPending/.test(quitBody), '必须有重入保护，否则死循环')
  assert.ok(/setTimeout/.test(quitBody), '必须有超时兜底，否则卡死退出')
  // 关键：用 app.quit() 重新发起退出，让第二次进来时放行
  assert.ok(/app\.quit\(\)/.test(quitBody))

  // 必须挂在 before-quit 的事件参数上
  assert.ok(/app\.on\('before-quit',\s*\(event\)/.test(mainSrc), "before-quit 必须接收 event")
  assert.ok(/flushCookiesBeforeQuit\(event\)/.test(mainSrc))
})

test('启动早期补刷一次（上次被强杀的兜底）', () => {
  const readyAt = mainSrc.indexOf('app.whenReady()')
  assert.ok(readyAt >= 0)
  const readyBlock = mainSrc.slice(readyAt, readyAt + 2000)
  assert.ok(/flushAllCookies\(/.test(readyBlock), 'whenReady 里必须有兜底刷新')
})

test('「重启生效」不能走 app.exit() —— 它会跳过 before-quit', () => {
  const at = mainSrc.indexOf('relaunchAndExit:')
  assert.ok(at >= 0)
  const block = mainSrc.slice(at, at + 400)
  assert.ok(/app\.relaunch\(\)/.test(block), '必须保留 relaunch')
  assert.ok(/app\.quit\(\)/.test(block), '必须走 quit，让退出流程跑完')
  assert.ok(!/app\.exit\(/.test(block), '绝不能 app.exit()，那会丢掉所有未落盘的 Cookie')
})
