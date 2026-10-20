'use strict'

/**
 * 客户端诊断：日志文件、崩溃上报、内存水位采样。
 *
 * ## 这一块的由来
 *
 * 以前客户端一条日志都不写：主进程抛异常、渲染进程被杀、翻译静默失败
 * 全都没有痕迹，排查只能靠用户截图。加上这三件事之后，"软件凭空消失"
 * 才有得查。
 *
 * ## 为什么拆出来
 *
 * 这三段都是「拿到一个 logger 就能自己工作」的装配型代码，不碰窗口、
 * 不碰标签、不碰业务状态。以前和 149 个函数挤在 main.js 里，
 * 启动路径上有三块诊断代码缠在一起，看启动流程时找不到重点。
 *
 * ## 三条硬约束（都会在下面各自的函数里再讲一遍）
 *
 *   1. **绝不阻塞启动**：上报在 setImmediate 里跑，首次采样是 1 秒后的
 *      setTimeout。启动速度是用户能直接感知的。
 *   2. **失败完全静默**：线路不通是常态，不能变成用户看到的新问题。
 *   3. **采样必须异步**：macOS 上摸内存要 execSync 调 vm_stat，
 *      系统繁忙时最长卡 3 秒。
 */

const path = require('path')

/**
 * 建 logger 并把 console / 未捕获异常 / 子进程崩溃全部接进来。
 *
 * @param {object} env
 * @param {object} env.app      Electron app（要 getPath / exit / on）
 * @param {object} env.logFile  src/stability/log-file
 * @param {(msg: string) => void} [env.onFatalError] 日志写入失败时的出口
 * @returns {object|null} logger；连日志目录都建不出来时返回 null
 */
function createClientLog ({ app, logFile, onFatalError }) {
  let dir
  try {
    dir = path.join(app.getPath('userData'), 'logs')
  } catch (e) {
    try {
      dir = path.join(app.getPath('temp'), 'hello-pix-logs')
    } catch (e2) {
      return null
    }
  }

  const log = logFile.createLogger(dir, {
    // 刻意走 stderr 而不是 console.error：console 已被下面桥接到本 logger，
    // 用它上报"日志写入失败"会和自身形成回环。
    onError: error => {
      try {
        if (onFatalError) onFatalError(error)
        else process.stderr.write('[hello-pix] 日志写入失败：' + (error && error.message) + '\n')
      } catch (e) {}
    }
  })

  // 1. 把已有的 console.* 输出接进日志文件（不必逐条改写调用点）
  logFile.installConsoleBridge(console, log)

  // 2. 未捕获异常 / 未处理拒绝
  logFile.attachProcessHandlers(process, log, {
    flush: () => log.flush(),
    exit: code => app.exit(code)
  })

  return log
}

/**
 * 挂「子进程崩溃」监听。
 *
 * ## ★ 为什么必须单独挂 ★
 *
 * 用户反馈"开很多窗口时闪退"。以往只挂了主窗口的 render-process-gone，
 * **GPU 进程、utility 进程崩溃在日志里完全看不到**。而这类崩溃正是
 * "界面突然白屏 / 软件整个消失、连个错误提示都没有"的常见成因。
 *
 * 只记 error 级别、事件很短，不会把日志写大。type 要记清楚：
 * gpu 崩了 → 渲染/合成问题；utility 崩了 → 网络或杂活进程问题。
 *
 * @param {object} env
 * @param {object} env.app
 * @param {() => object|null} env.getLog
 */
function attachChildProcessWatch ({ app, getLog }) {
  app.on('child-process-gone', (_event, details) => {
    try {
      const log = getLog()
      if (!log) return
      const reason = (details && details.reason) || '?'
      log.error('crash', '子进程退出：type=' + ((details && details.type) || '?') +
        ' name=' + ((details && details.name) || '?') +
        ' reason=' + reason +
        ' exitCode=' + ((details && details.exitCode) == null ? '?' : details.exitCode) +
        (reason === 'oom' ? ' ★内存不足' : ''))
    } catch (ignore) {}
  })
}

/**
 * 崩溃日志上报 —— 把**上次异常退出**留下的证据自动送回来。
 *
 * ## 为什么要有这一步
 *
 * 0.1.36 起 `[crash]` / `[memory]` 已经能记录了，但日志只躺在用户本机。
 * 用户不主动发，我们永远看不到 —— 等于加了取证却没有收回证据的通道。
 * 这个函数在启动时把上次的痕迹送到服务器，用户无感。
 *
 * ## 设计约束（都很硬）
 *
 *   · **绝不阻塞启动**：先返回，网络请求在后台跑。
 *   · **失败完全静默**：不写日志、不弹窗。服务器连不上、线路不通都是常态，
 *     这不该变成用户看到的新问题。
 *   · **只传 crash / memory 行**：过滤在 crash-report.js 里，服务端还会再滤一次。
 *   · **传完就写标记**：防止同一次崩溃在下一次启动时重复上报。
 *
 * @param {object} env
 * @param {object} env.app
 * @param {object} env.crashReport  src/stability/crash-report
 * @param {(path: string, opts: object) => Promise<any>} env.api
 * @param {object|null} log
 */
function reportCrashIfNeeded ({ app, crashReport, api }, log) {
  if (!log || !log.dir) return
  let found
  try {
    found = crashReport.detectAbnormalExit(log.dir)
  } catch (e) {
    return
  }
  // 正常退出、首次安装、没有任何日志 —— 都不上报。
  if (!found) return
  const picked = found.picked
  if (!picked || !picked.lines.length) return

  const payload = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    lines: picked.lines
  }
  const summary = crashReport.summarize(picked.lines)

  // 不 await：调用方继续往下走，启动不受影响。
  setImmediate(() => {
    api('/client/crash-report', {
      method: 'POST',
      // 用 form 而不是 JSON：api() 只实现了 urlencoded 提交，
      // lines 作为 JSON 字符串放进单个字段，服务端再 parse。
      form: {
        version: payload.version,
        platform: payload.platform,
        arch: payload.arch,
        lines: JSON.stringify(payload.lines)
      },
      // 诊断流量不该和用户操作抢带宽，超时也给短一点。
      totalTimeoutMs: 20000
    }).then(() => {
      // 传成功 → 写标记，避免重复上报。
      crashReport.writeMarker(log.dir)
      try {
        log.info('crash', '崩溃日志已上报：' + summary.crashCount + ' 条崩溃' +
          (summary.memoryPeak == null ? '' : '，内存峰值 ' + summary.memoryPeak + '%'))
      } catch (e) {}
    }).catch(() => {
      // 失败就什么都不做：下次启动会再试。
      // 刻意不写 WARN —— 线路不通时每个用户都会看到这条，纯属噪音。
    })
  })
}

/**
 * 周期性记录内存水位 —— **崩溃之前那一刻的内存，是事后唯一能看到的证据**。
 *
 * ## 为什么必须有
 *
 * 用户反馈"开着很多窗口时闪退"。崩溃记录只能告诉我们"进程因为内存不足被杀了"
 * （reason=oom），但**回答不了最关键的问题：当时整机还有多少内存？窗口开了几个？**
 * 没有这两个数字，改阈值、改策略全是拍脑袋。
 *
 * ## 为什么不是每分钟一条
 *
 * 那样日志会被刷爆（一天 1440 行噪音），真出事时反而不好找。
 * 只在**水位发生变化**时写：跨过 70% / 80% / 90% 的档位才记一条。
 * 平时安静，一旦开始吃紧，日志里就有一串爬升曲线。
 *
 * @param {object} env
 * @param {(args: any) => object} [env.memoryPressure] 默认走 tab-budget
 * @param {() => number} [env.tabCount] 当前实例数
 * @param {object} log
 * @returns {object|null} interval 句柄
 */
function startMemorySampling ({ memoryPressure, tabCount }, log) {
  if (!log || !memoryPressure) return null
  const MB = 1024 * 1024
  let lastBucket = -1
  let lastAt = 0

  const tick = () => {
    try {
      // 节流：距上次记录不足 30 秒就跳过，避免窗口抖动导致重复写。
      if (Date.now() - lastAt < 30000) return
      const mem = memoryPressure()
      if (!mem || !Number.isFinite(mem.ratio) || mem.total <= 0) return
      const pct = Math.round(mem.ratio * 100)
      // 70% 以下每 10 个百分点一档；70% 以上每 5 个一档（越接近上限越要密）。
      const bucket = pct >= 90 ? 90 + Math.floor((pct - 90) / 2) * 2
        : pct >= 70 ? 70 + Math.floor((pct - 70) / 5) * 5
          : Math.floor(pct / 10) * 10
      if (bucket === lastBucket) return
      lastBucket = bucket
      lastAt = Date.now()
      // 同时记实例数与本进程 RSS：后者能看出"是不是我们自己在涨"。
      const rss = Math.round(process.memoryUsage().rss / MB)
      const count = typeof tabCount === 'function' ? tabCount() : '?'
      log.info('memory', '整机已用 ' + pct + '%（' +
        Math.round(mem.used / MB) + '/' + Math.round(mem.total / MB) + 'MB，口径 ' + mem.source +
        '）  实例 ' + count + ' 个  主进程 RSS ' + rss + 'MB')
    } catch (ignore) {}
  }

  // ★ 首次采样必须异步，不能在这里同步跑 ★
  //
  // tick() 在 macOS 上会走 tab-budget 的 vm_stat 分支，那是 execSync ——
  // 平时 5ms，但系统繁忙时最长卡 3 秒（timeout: 3000）。而本函数在
  // app.whenReady 的启动路径上被同步调用，卡住的就是用户眼里的
  // "双击了没反应"。采样是诊断，绝不能拖慢启动。
  const primed = setTimeout(tick, 1000)
  if (primed && typeof primed.unref === 'function') primed.unref()
  const timer = setInterval(tick, 15000)
  if (timer && typeof timer.unref === 'function') timer.unref()
  return timer
}

module.exports = {
  createClientLog,
  attachChildProcessWatch,
  reportCrashIfNeeded,
  startMemorySampling
}
