'use strict'

/**
 * 「隐藏窗口」的保活策略。
 *
 * ## 这个功能为什么不能简单地 destroy 掉 webContents
 *
 * 用户对隐藏的期望是原话：**不掉号、不丢设置、后台挂着但不占资源**。
 * 这三条其实互相拉扯：
 *
 *   - 想省资源 → 最省的是销毁渲染进程。但网页版的登录态有相当一部分
 *     活在页面内存里（WhatsApp Web 的 Signal 会话、部分站点的 in-memory token），
 *     进程一销毁就得重新扫码 —— 那是**掉号**，直接违背需求。
 *   - 想不掉号 → 只能保留进程。进程还在就必然占内存，只是占用可以压到很低。
 *
 * 所以这里的选择是：**保留进程，把它的活跃度压到地板**。具体做了三件事：
 *
 *   1. 从原生视图树上摘下来（detach）。摘下来之后这个 view 不再参与合成，
 *      不产生上屏绘制 —— 这是"看不见"之外真正省下 GPU/CPU 的那一步。
 *   2. 静音。隐藏的窗口再有任何音视频都只会在后台白烧 CPU，而且用户看不到画面，
 *      声音突然冒出来反而吓人。
 *   3. 停止上报未读。标题里的未读数是"提醒"的来源，隐藏后必须不再触发
 *      角标/红点 —— 否则"隐藏了还在提醒"就是这个功能最直接的反效果。
 *
 * 明确**不做**的事：不销毁、不 reload、不清 session、不动 partition。
 * 这四条任何一条都会把用户从网页版踢下来。
 */

/**
 * 隐藏后要不要继续把未读计入角标。
 *
 * @returns {boolean} 永远是 false —— 隐藏的定义就是"不提醒"。
 *
 * 单独抽成函数是为了让"隐藏 = 静默"这条规则可被测试锁住：
 * 一旦有人为了"隐藏后也想知道有没有消息"把它改成 true，
 * 用户看到的就是隐藏没用、角标照样跳。
 */
function shouldNotifyWhenHidden() {
  return false
}

/**
 * 隐藏一个 tab 时需要施加的"降活"动作清单。
 *
 * 返回一组**幂等**的动作名，由 main.js 依次执行。幂等很重要：
 * 重复点隐藏（或恢复失败后再点一次隐藏）不能把状态搞乱。
 *
 * ## 其中最值钱的是 `throttle`
 *
 * 实测（desktop/scripts/probe-*.js）：
 *   - 摘视图树只省 15MB 内存，但帧率 60 → 1，**CPU 大幅下降**；
 *   - 真正把后台活动压下去的是 `backgroundThrottling: true`：
 *     隐藏后定时器从 2 秒 20 次降到 2 次，**降低 90%**。
 *
 * 所以这两步要一起做，只做摘视图会留下"进程在后台空转"的尾巴。
 *
 * @param {object} tab
 * @returns {string[]}
 */
function hidePlan(tab) {
  const plan = ['detach', 'throttle', 'mute', 'stopUnread']
  // 已经不在加载中的窗口不必再停转 —— 停一个空闲窗口没有收益，
  // 反而多一次状态写入。
  if (tab && tab.loading) plan.push('stopLoading')
  return plan
}

/**
 * 恢复展示一个 tab 时要做的事。
 *
 * 注意 `resumeSound` 只在**用户原本没静音**时才该关掉静音：
 * `muteAll` 是用户在设置里主动开的白名单，隐藏功能不能替他改回来。
 *
 * @param {object} tab
 * @returns {string[]}
 */
function showPlan(tab) {
  const plan = ['attach', 'resumeUnread', 'clearHidden']
  const muted = !!(tab && tab.settings && tab.settings.muteAll)
  if (!muted) plan.push('unmute')
  return plan
}

/**
 * 用户能否隐藏这个 tab。
 *
 * @param {object} tab
 * @param {number} visibleCount 当前**未被隐藏**的窗口数
 */
function canHide(tab, visibleCount) {
  if (!tab) return { ok: false, msg: '应用不存在' }
  if (tab.hidden) return { ok: false, msg: '该窗口已在后台运行' }
  // 至少留一个可见窗口：全藏起来后标签栏会变成空的，
  // 用户会以为应用崩了 —— 而且没有任何视觉线索告诉他"窗口在后台"。
  if (visibleCount <= 1) return { ok: false, msg: '至少保留一个窗口' }
  return { ok: true }
}

/**
 * 隐藏后如果当前激活窗口被藏了，应该切到哪一个。
 *
 * 优先选原位置右边最近的一个（用户视觉上最自然），没有就选左边。
 *
 * @param {object[]} tabs       按显示顺序排列的全部 tab
 * @param {string} hiddenId     被隐藏的 id
 * @returns {string} 下一个应激活的 id，没有可选则返回空串
 */
function nextActiveAfterHide(tabs, hiddenId) {
  const list = Array.isArray(tabs) ? tabs : []
  const index = list.findIndex(t => t && t.id === hiddenId)
  if (index < 0) return ''
  const visible = id => {
    const t = list.find(x => x && x.id === id)
    return t && !t.hidden
  }
  for (let i = index + 1; i < list.length; i++) {
    if (visible(list[i].id)) return list[i].id
  }
  for (let i = index - 1; i >= 0; i--) {
    if (visible(list[i].id)) return list[i].id
  }
  return ''
}

module.exports = { shouldNotifyWhenHidden, hidePlan, showPlan, canHide, nextActiveAfterHide }
