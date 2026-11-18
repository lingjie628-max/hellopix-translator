/**
 * 翻译健康状态横幅。
 *
 * ## 这个文件解决的事故（2026-11-02）
 *
 * 用户报「1.3.5 不翻译了」。查下来服务端、额度、通道全部正常 ——
 * 真正原因是客户端在 5 分钟内崩了 5 次，触发了崩溃循环保护，
 * `health-guard.policy().disableBridge = true`，翻译桥（guest-inject.js）
 * 作为 preload **根本没被注入**。
 *
 * 那个设计本身是对的：先保证软件能开起来，再谈功能。
 * 错的是**摘掉之后界面一个字都没变** —— 点「译」没反应，用户只能
 * 认为软件坏了，而实际上他只要等 5 分钟重启一次就好。
 *
 * 所以这里补上"知情权"：主进程说翻译被停了，就挂横幅告诉用户为什么、
 * 怎么恢复。用户不需要理解"崩溃循环保护"是什么。
 *
 * ## 为什么按钮是「重新开启翻译」而不是「重启软件」
 *
 * 用户已经重启过好几次了（正是重启太频繁才触发的保护），
 * 再叫他重启只会加重困惑。这里直接给他一键恢复的路径：
 * 调主进程清掉崩溃计数并重载实例，翻译桥就会重新注入。
 *
 * ## 检测时机
 *
 * - 挂载时查一次（上次留下的安全模式状态会在启动时就生效）
 * - 每次开新实例前后各查一次（新窗口如果光秃秃没有翻译，用户立刻就发现了）
 * - 页签切回来时查一次（幂等，成本只有一次 IPC）
 */

/** 防止并发重复请求：轮询/切换页签可能连续触发。 */
let transStatusInFlight = false

/**
 * 把 `{limited, startsInWindow}` 翻译成用户能看懂的一句话。
 *
 * 刻意不提"安全模式""崩溃循环"这些词 —— 用户不关心内部机制，
 * 只关心「怎么回事」和「我要做什么」。
 */
function transBannerMessage(status) {
  const n = Number(status && status.startsInWindow) || 0
  // 有具体启动次数就说出来：比"检测到异常"可信得多，也解释了为什么要他恢复
  if (n >= 2) {
    return '翻译已暂停：软件启动有点频繁，自动保护把它关掉了（不影响聊天）。点右边恢复即可。'
  }
  return '翻译已暂停：软件自动保护把它关掉了（不影响聊天）。点右边恢复即可。'
}

function showTransBanner(status) {
  const box = document.getElementById('pixTransBanner')
  const text = document.getElementById('pixTransBannerText')
  const btn = document.getElementById('pixTransBannerBtn')
  if (!box) return
  if (text) text.textContent = transBannerMessage(status)
  box.classList.remove('hidden')
  // 按钮可能还在"恢复中"的禁用态；横幅重新出现时重置回可点
  if (btn) { btn.disabled = false; btn.textContent = '重新开启翻译' }
}

function hideTransBanner() {
  const box = document.getElementById('pixTransBanner')
  if (box) box.classList.add('hidden')
}

/**
 * 查一次翻译状态并同步横幅。
 *
 * 任何异常都按"正常"处理：这是个提示功能，它自己出错不能变成
 * 一条永远挂着的假警报 —— 那比不提示更糟。
 */
async function refreshTransStatus() {
  if (!window.pix || typeof window.pix.translateStatus !== 'function') return
  if (transStatusInFlight) return
  transStatusInFlight = true
  try {
    const status = await window.pix.translateStatus()
    if (status && status.limited) showTransBanner(status)
    else hideTransBanner()
  } catch (e) {
    // 查询失败不弹任何东西
  } finally {
    transStatusInFlight = false
  }
}

/**
 * 「重新开启翻译」。
 *
 * 恢复动作在主进程（清崩溃计数 + 重建实例的翻译桥），这里只负责
 * 给按钮一个"正在恢复"的反馈，避免用户连点。
 *
 * 失败时必须把按钮**恢复可点**并把原因说出来 —— 否则按钮永久变灰，
 * 用户彻底没救了。宁可让他多试几次。
 */
async function onTransBannerRestore() {
  const btn = document.getElementById('pixTransBannerBtn')
  if (!btn || btn.disabled) return
  btn.disabled = true
  btn.textContent = '正在恢复…'
  let ok = false
  try {
    if (window.pix && typeof window.pix.translateRestore === 'function') {
      const r = await window.pix.translateRestore()
      ok = !!(r && r.ok)
    }
  } catch (e) {
    ok = false
  }
  if (ok) {
    // 恢复成功：主进程会重新注入翻译桥，横幅使命结束。
    // 不立刻 hide —— 先让用户看到"已恢复"再收起，否则点了没反应会以为没用。
    btn.textContent = '已恢复 ✓'
    setTimeout(() => {
      hideTransBanner()
      // 再查一次兜底：万一主进程那边没真的恢复，横幅会重新出现
      refreshTransStatus()
    }, 1200)
  } else {
    btn.disabled = false
    btn.textContent = '重试'
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('pixTransBannerBtn')
  if (btn) btn.addEventListener('click', onTransBannerRestore)
  // 启动时查一次：上次崩溃留下的安全模式在本次启动就已生效
  refreshTransStatus()
})

// 页面重新可见时再查（用户长时间挂后台，期间可能崩过）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshTransStatus()
})
