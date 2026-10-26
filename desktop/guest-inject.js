const { ipcRenderer } = require('electron')

const pixBridge = {
  getPrefs: () => ipcRenderer.invoke('translate:guestPrefs'),
  translate: payload => {
    const text = String(payload && payload.text || '')
    if (!text || text.length > 5000) return Promise.resolve({ success: false, msg: '翻译文本长度无效' })
    return ipcRenderer.invoke('translate:run', {
      text,
      incoming: !!(payload && payload.incoming),
      // 调用来源。计费审计靠它区分"用户点了译"与"扫描时自动翻"，
      // 出异常字符消耗时能一眼看出是谁触发的。
      trigger: String(payload && payload.trigger || '')
    })
  },
  onPrefs: callback => {
    ipcRenderer.removeAllListeners('translate:prefs')
    ipcRenderer.on('translate:prefs', (_event, data) => callback(data))
  },
  // 客户身份与消息上报。失败**不抛错**：采集是尽力而为，
  // 不能因为它出错就影响用户正常聊天（翻译才是主线功能）。
  reportCustomer: payload => {
    try { return ipcRenderer.invoke('customer:ingest', payload).catch(() => null) } catch (e) { return Promise.resolve(null) }
  },
  // ---------------------------------------------------------------------
  // composer 的**原生输入**通道（0.1.19）。
  //
  // 真机证据（0.1.18）：expected=29 字符的英文译文 vs actual=6 字符的中文原文 ——
  // 页面内 `execCommand` 写进去的东西**从未进入** WhatsApp 编辑器的输入管线
  // （它拦掉 `isTrusted:false` 的 beforeinput）。所以改由**主进程**用 Chromium
  // 编辑命令发起真实输入；产生的是可信事件，编辑器必须按正常输入处理。
  //
  // 这两步只做键盘/输入动作，**不改 DOM、不读 DOM**：读 DOM 由 guest 自己做，
  // 好在两步之间留下 COMPOSER_CLEARED / NATIVE_TEXT_INSERTED 的证据。
  // ---------------------------------------------------------------------
  nativeComposerClear: () => ipcRenderer.invoke('translate:composerSelectAllDelete'),
  nativeComposerInsertText: (text, linewise) => ipcRenderer.invoke('translate:composerInsertText', {
    text: String(text == null ? '' : text),
    linewise: !!linewise
  }),
  // ---------------------------------------------------------------------
  // 图片翻译。
  //
  // 只传"翻成什么语言"，**图片本身不从这里传** —— 图片在客页里，
  // 由主进程自己回来取（见 src/translate/preview-image.js）。
  // 这样图片字节在进程间只搬一次（客页 → 主进程），不用再经过渲染层。
  // ---------------------------------------------------------------------
  translateImage: payload => ipcRenderer.invoke('translate:image', {
    to: String((payload && payload.to) || 'zh')
  })
}

/**
 * 上报"焦点是否在可编辑区域"。
 *
 * ## 为什么需要这个
 *
 * 主进程的 `before-input-event` 是**同步**回调，来不及 `executeJavaScript`
 * 去问页面"现在光标在哪"。而 Ctrl+Z 到底该谁处理，恰恰取决于这个：
 *
 *   · 光标在输入框 → 必须放行给页面。Slack / Discord / WhatsApp 的撤销栈
 *     比 Chromium 默认的更懂上下文（能撤回一次"引用回复"、一次粘贴的多行），
 *     被我们拦下就废了。
 *   · 光标在普通区域 → 页面没得撤销，我们接管，否则按键毫无反应。
 *
 * 所以用 capture 阶段监听 focusin/focusout 维护一个布尔值，变化时通过
 * `reportEditableFocus` 推给主进程缓存。监听器挂在 window 上，
 * **capture: true** 才能在被页面 stopPropagation 之前拿到。
 *
 * ## 为什么不用 input 事件
 *
 * contenteditable 的 div 不触发 focus 时的 `isContentEditable` 变化，
 * 有些页面（WhatsApp 的聊天列表）用 tabindex 做键盘导航，
 * 那些地方 focus 了但不可编辑 —— 必须真的检查 isContentEditable / tagName。
 */
function isEditableTarget (el) {
  if (!el || !el.nodeType || el.nodeType !== 1) return false
  try {
    if (el.isContentEditable) return true
    const tag = String(el.tagName || '').toUpperCase()
    if (tag === 'TEXTAREA') return true
    if (tag === 'INPUT') {
      // input 里也有不可编辑的类型：勾选框、按钮、颜色选择器
      const type = String(el.type || 'text').toLowerCase()
      return !/^(button|checkbox|radio|file|submit|reset|image|range|color)$/.test(type)
    }
  } catch (e) {}
  return false
}

function installEditableReporter () {
  let last = null
  const report = editable => {
    if (editable === last) return
    last = editable
    try { ipcRenderer.send('edit:editableFocus', editable) } catch (e) {}
  }
  // focusin 冒泡，capture 阶段最先收到 —— 页面想拦也拦不住
  window.addEventListener('focusin', event => report(isEditableTarget(event.target)), true)
  // focusout 时 target 已经不可靠（可能已 remove），用 relatedTarget 或直接查 activeElement
  window.addEventListener('focusout', () => {
    // 延迟一拍：focusout 之后焦点会立刻落到新元素，那一刻才是真实状态
    setTimeout(() => report(isEditableTarget(document.activeElement)), 0)
  }, true)
  // 页面切换（WhatsApp 在会话间跳转时整个挂在 #app 下重建）
  window.addEventListener('hashchange', () => {
    setTimeout(() => report(isEditableTarget(document.activeElement)), 0)
  }, true)
}

;(() => {
  if (window.__helloPixChat) return true
  window.__helloPixChat = true

  // 焦点上报：主进程判断 Ctrl+Z 该不该拦，全靠它（见 installEditableReporter）。
  // 出错不能拖垮翻译主线，所以单独 try。
  try { installEditableReporter() } catch (e) {}

  const cache = new Map()
  const pending = new Map()
  const BUSY_MARK = '[正在翻译中...]'

  // ---------------------------------------------------------------------------
  // 发送状态机的结构化 trace
  //
  // 真机上"对方到底收到了什么"只能靠肉眼，而事故复盘需要的是**事件顺序**。
  // 这里给每一次发送动作分配一个 sendActionId，并把状态机的每一步打成一行
  // 结构化日志（走 console.info → 主进程转发进客户端日志，真机可直接采集）。
  //
  // 判定规则（写死的，不靠人看）：
  //   PROGRAMMATIC_SEND_BEGIN 之前**必须**出现过 TRANSLATE_SUCCEEDED 与
  //   INPUT_REPLACED，否则直接判 FAIL 并放弃发送。
  //
  // 只记长度、不记正文 —— trace 会进日志，不能把用户消息内容重复落盘。
  // ---------------------------------------------------------------------------
  let sendActionSeq = 0
  let sendActionId = ''
  let sendActionPhase = 'idle'   // idle | captured | translating | succeeded | replaced | sending
  // 最近一次发送链失败的真实原因。**不许用统一的"状态异常/重试失败"盖住它** ——
  // 提示框与 trace 都要把它显示出来，否则真机取证只能看到"失败了"三个字。
  let lastSendFail = null
  // 最近一次向输入框写入的取证信息（写入方式 / 是否触发 input/beforeinput）——
  // BODY_MISMATCH 时必须能回答"到底怎么写进去的"。由 writeComposer 维护。
  let lastWriteInfo = null
  // 原生输入后的**漂移采样点**（毫秒）：用户要求逐点留证"写进去之后正文有没有变"。
  const NATIVE_SAMPLE_MARKS = [0, 100, 300, 500]
  // 观察窗的上限 = 下限 + 余量（保证下限调到 500 的取证模式也能跑到最后一个采样点）。
  const NATIVE_SETTLE_SLACK_MS = 400
  // 沉降判据（0.1.19 性能专项）：
  //   下限 —— 给编辑器留一拍再确认，默认 60ms（原实现无条件等 500ms，实测占满
  //          整条链的客户端开销）；
  //   上限 —— 到这个点还不稳定就换插入方式重试，再不行 fail-closed；
  //   连续一致次数 / 轮询间隔 —— 用来区分"真的收口了"与"在两次 render 之间取到的瞬态"。
  const NATIVE_SETTLE_FLOOR_DEFAULT_MS = 60
  const NATIVE_SETTLE_CEILING_DEFAULT_MS = 400
  const NATIVE_STABLE_STREAK = 3
  const NATIVE_SETTLE_POLL_MS = 15

  function newSendActionId() {
    sendActionSeq++
    return 'sa-' + Date.now().toString(36) + '-' + sendActionSeq
  }

  function trace(event, extra) {
    try {
      const payload = Object.assign({ sendActionId: sendActionId || '-', phase: sendActionPhase }, extra || {})
      console.info('[PIX_TRACE] ' + event + ' ' + JSON.stringify(payload))
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // 端到端性能计时（同一次 sendActionId 内的分段耗时）
  //
  // 客服高频使用时，"按了回车之后到底要等多久、时间花在哪一段"是唯一能指导
  // 优化的信息。只报一个总耗时等于没测 —— 你不知道该动网络、动沉降，还是动 UI。
  //
  // 分段（与验收要求一一对应）：
  //   intercept   用户点击发送 → 原生发送被拦截
  //   translate   翻译请求开始 → API 返回
  //   handoff     API 返回 → 原生输入开始
  //   nativeInput 原生输入开始 → 编辑器稳定（LEXICAL_SETTLED）
  //   validate    正文校验 → 触发发送
  //   send        触发发送 → 发送确认
  //   uiClose     发送确认 → 状态提示关闭
  //
  // 每个时间戳都落在**同一个 sendActionId** 上；一次动作结束打一行 SEND_PERF。
  // 只记毫秒数，不记正文（trace 会进日志）。
  // ---------------------------------------------------------------------------
  let perfOrigin = 0
  let perfStamps = Object.create(null)
  const PERF_STAGES = [
    ['intercept', 'start', 'blocked'],
    ['translate', 'translateStart', 'translateDone'],
    ['handoff', 'translateDone', 'nativeBegin'],
    ['nativeInput', 'nativeBegin', 'settled'],
    ['validate', 'settled', 'sendBegin'],
    ['send', 'sendBegin', 'sendDone'],
    ['uiClose', 'sendDone', 'uiClosed']
  ]
  function perfStart() {
    perfOrigin = Date.now()
    perfStamps = Object.create(null)
  }
  function perfMark(name) {
    const now = Date.now()
    if (!perfOrigin) perfOrigin = now
    perfStamps[name] = now
    return now
  }
  /**
   * 打一行完整的分段耗时。
   *
   * @param {string} outcome  ok | fail_closed | aborted
   * @param {object} extra    额外字段（失败码 / 引擎 / 字符数）
   */
  function perfEmit(outcome, extra) {
    if (!perfOrigin) return
    const stages = {}
    for (const row of PERF_STAGES) {
      const a = perfStamps[row[1]]
      const b = perfStamps[row[2]]
      // 只有两端都采到才算这一段（缺一段就说明这条链没走到那儿）。
      if (a == null || b == null) continue
      stages[row[0]] = b - a
    }
    // 总耗时：从"用户按下发送"到"界面收口"。这才是用户感知的那个数。
    const from = perfStamps.start
    const to = perfStamps.uiClosed || perfStamps.sendDone || Date.now()
    const total = from == null ? null : to - from
    trace('SEND_PERF', Object.assign({
      chain: 'send',
      outcome: outcome || 'ok',
      total: total,
      stages: stages
    }, extra || {}))
    perfOrigin = 0
    perfStamps = Object.create(null)
  }

  const EMOJI_RE = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\uFE0F\u200D\u20E3])/gu
  let prefs = {
    transRecv: true,
    transSend: true,
    transGroup: false,
    langMine: 'zh',
    langOther: 'auto',
    sendTo: 'en',
    includeZh: false,
    antiRevoke: false,
    // 原生输入的**沉降确认窗**（毫秒）。
    //
    // 0.1.19 性能专项把语义从"无条件等这么久"改成"**最短确认窗**"：
    // 只要连续确认正文已稳定且等于译文，就立刻进入校验 + 发送；等不到才等到上限。
    // 实测（bench-send-timing）原实现 500ms 固定窗占满整条链 100% 的客户端开销。
    // 想恢复"完整 0/100/300/500 漂移时间线"的取证模式：把 sendSettleMs 调到 500 即可。
    sendSettleMs: 60,
    // 沉降等待的**上限**：到点仍不稳定 → 换插入方式重试 → 仍不行就 fail-closed。
    sendSettleCeilingMs: 400
  }
  let scanTimer = 0
  let sendBusy = false
  // 上一次"会话类型"结论的指纹。chatKind() 直接决定计费与自动翻译，
  // 但此前**没有任何日志**能看出它判了什么、凭哪条证据 —— 0.1.23 真机
  // "私聊也要手动翻" 排查时只能靠猜。现在结论或证据一变就打一行 CHAT_KIND。
  let lastChatKindKey = ''
  // 翻译期间被换掉的用户原文。发送前若发现占位符还在输入框里，用它还原。
  let pendingSend = null

  // ---------------------------------------------------------------------------
  // 群聊「手动 / 自动」（计费保护）
  //
  // 语义（用户裁定，2026-10-11）：
  //
  //   | 会话类型 | 自动翻译 |
  //   |---|---|
  //   | 私聊 | **始终自动**（与「群聊自动翻译」开关无关） |
  //   | 群聊 = 手动 | 一条都不自动翻，只给「译」按钮（0 自动扣费） |
  //   | 群聊 = 自动 | 会话里出现的消息**全部自动翻**，**不再出现「译」按钮** |
  //
  // ## 被删掉的那条闸门（0.1.24 及以前）
  //
  // 0.1.24 还有第三条：「群聊 = 自动 **且** 历史消息 → 只给按钮」。
  // 它是为了防"一进群就翻满屏历史扣费"加的，出发点是省钱，但它把「自动」
  // 变成了**半自动**：打开群聊时页面上的那批消息永远只有按钮，只有之后新到的
  // 才自动翻。真机证据（2026-10-11 11:30，同一个群、同一分钟）：
  //
  //   MANUAL_CHIP_RENDERED × 43   ← 打开会话时那批（只给按钮）
  //   [translate] … auto_receive × 26  ← 之后新到的（自动翻）
  //
  // 用户看到的正是"一部分翻译，还有一部分没有翻译"。已删除。
  //
  // ## 删掉它为什么**不会**造成重复扣费（这是允许删的前提）
  //
  // 关键：**同一条消息翻多少次都只计一次费**，所以"全部自动翻"的代价上限是
  // "从没翻过的正文"，而不是"翻了多少次"：
  //   · 服务端按 `Idempotency-Key` 幂等；客户端这个号是
  //     `desktop:<device>:md5(用户|engine|from|to|正文):<代>` —— 同一段正文、
  //     同一通道**永远同一个号**，重放直接命中已有预留，不再扣字符
  //     （server/services/core-service.js: existing → return existing）；
  //   · 服务端还有一层 translationCache（tenant+engine+from+to+text）；
  //   · 客户端主进程还有一层 transCache，连 IPC 都不会走。
  //
  // ## 代价（写清楚，别让下一个人以为删闸门是免费的）
  //
  // 打开群聊时 WhatsApp 渲染出来的那批消息会**一次性**计费（实测约 30~40 条）。
  // 之后重开、重启都不再扣（幂等 + 缓存）。往上滚动加载更早的历史同理。
  //
  // 判定逻辑本身放在 MessageParser 里（messageAction），是纯逻辑、能用真 DOM
  // 用例锁住 —— 计费闸门不该藏在异步扫描循环里没法测。
  // ---------------------------------------------------------------------------

  /**
   * 各平台的消息结构。接收翻译（扫描 / 挂「译」按钮 / 画译文 / 点击后重定位）
   * 只通过这一份配置认识页面，不再在各处写死 WhatsApp 的 `#main` / `[data-id]`。
   *
   *   scope     当前会话容器。拿不到就不扫描、不绘制（绝不退回整个 document）
   *   row       一条消息的行。消息的唯一身份挂在它上面
   *   keyAttr   行上的稳定 id 属性（点「译」后跨重绘重新定位用）
   *   text      行内正文节点。译文画在它所在的块级容器里
   *   nodes     扫描入口
   *   chatKindVerified  群聊/私聊判定是否经过真机验证。未验证的平台一律只给
   *             「译」按钮、不自动翻译 —— 判不准群聊就可能整群自动扣费
   *
   * 认不出的站点沿用 WhatsApp 配置：选择器在别的站点上命中不了任何节点，
   * 行为与没有接收翻译一致。
   */
  // ==== SITE ADAPTERS BEGIN ====
  const SITE_ADAPTERS = {
    whatsapp: {
      id: 'whatsapp',
      scope: '#main',
      row: '[data-id]',
      keyAttr: 'data-id',
      text: '.selectable-text',
      nodes: '.message-list-item .text-content, .Message .text-content, div.message-in span.selectable-text, div.message-out span.selectable-text, div.copyable-text span.selectable-text',
      chatKindVerified: true
    },
    telegram: {
      id: 'telegram',
      scope: '#MiddleColumn',
      row: '.Message[data-message-id]',
      keyAttr: 'data-message-id',
      text: '.text-content',
      nodes: '.Message[data-message-id] .text-content',
      chatKindVerified: true
    }
  }

  function detectSite() {
    let host = ''
    try { host = String((location && location.hostname) || '').toLowerCase() } catch (e) {}
    if (/(^|\.)web\.telegram\.org$/.test(host)) return SITE_ADAPTERS.telegram
    return SITE_ADAPTERS.whatsapp
  }
  const SITE = detectSite()

  function matchesSite(el, selector) {
    if (!el || typeof el.matches !== 'function') return false
    try { return el.matches(selector) } catch (e) { return false }
  }
  // ==== SITE ADAPTERS END ====

  /**
   * 当前会话的容器（WhatsApp 是 `#main`，Telegram 是 `#MiddleColumn`）。
   *
   * 拿不到就返回 null —— **绝不退回整个 document**：左侧会话列表的行也在
   * document 里，且带 `[data-id]`。退回 document 等于把别的会话当成当前会话。
   */
  function conversationScope() {
    return document && typeof document.querySelector === 'function'
      ? document.querySelector(SITE.scope)
      : null
  }

  /**
   * 当前 **WhatsApp 会话**的 id。只看 `#main`，绝不看整个 document。
   *
   * 私聊 → `手机号@c.us`；群聊 → `群id@g.us`。两者都只属于当前会话，
   * 且在同一会话内保持稳定 —— 这正是历史基线需要的性质。
   */
  function whatsappConversationKey() {
    const scope = conversationScope()
    if (!scope) return ''
    const rows = scope.querySelectorAll('[data-id]')
    for (let i = 0; i < rows.length && i < 200; i++) {
      const raw = String(rows[i].getAttribute('data-id') || '')
      if (raw.indexOf('@c.us') < 0 && raw.indexOf('@g.us') < 0) continue
      const parts = raw.split('_')
      if (parts.length < 3) continue
      const chatId = parts[1] || ''
      if (chatId.indexOf('@c.us') >= 0 || chatId.indexOf('@g.us') >= 0) return chatId
    }
    return ''
  }

  /**
   * 会话身份。用来识别"换会话了"，换会话要清掉自动翻译的排队与失败冷却。
   *
   * ## 真机 P0 根因（0.1.11 复现，见 test/group-conversation-identity.test.js）
   *
   * 老实现**先取 `currentPeer()`**，而 `whatsappPeer()` 扫的是**整个 document**
   * 的 `[data-id]`。WhatsApp 左侧会话列表的行也带 `[data-id]`（`@c.us`），
   * 而且排在 `#main` 之前 —— 群聊里身份因此取到"左侧列表里某个私聊"，
   * 根本不是当前会话。列表每来一条消息就会重排，身份跟着变
   * → 每轮扫描都被判成"换会话了"
   * → 群聊的自动翻译状态每轮被清空重来 → **「群组翻译 = 自动」永不生效**
   *   （手动「译」按钮还在，所以只表现为"自动不翻"）。
   *
   * 这条教训在 0.1.25 依然适用：身份现在是用来"清自动翻译排队/失败冷却"的，
   * 身份抖一下就会把刚开始翻的那批任务全丢掉，同样表现为"自动不翻"。
   *
   * 所以身份必须**只认当前会话**。拿不到就退回头部标题/URL ——
   * 宁可多清几次队列（重扫会把它们重新排上），也不能取到别的会话的身份。
   */
  function chatIdentity() {
    const conversation = whatsappConversationKey()
    if (conversation) return 'wa:' + conversation
    const peer = currentPeer()
    if (peer) return peer.peerKey
    const title = chatDisplayName()
    if (title) return 'title:' + title
    return String(location.hash || location.pathname || '')
  }

  /** 消息身份。拿不到稳定 id（Telegram 常见）就用正文哈希兜底。 */
  function messageIdentity(root, parsed) {
    const key = messageKey(root)
    if (key) return key
    return 'h:' + textHash(String((parsed && parsed.messageText) || '').slice(0, 400))
  }
  /**
   * suppression —— 我们自己发起那一次原生发送的抑制标记。
   *
   * `fireSend()` 触发原生发送时置真，让拦截器**放过这一次**（否则会自己拦自己）。
   * 注意：它只抑制"翻译拦截"，**不抑制占位符硬闸** —— 老实现把两者混在一起，
   * 于是我们发起的那一次发送恰好绕过了唯一能拦住占位符的闸（真机占位符出网）。
   */
  let suppression = false

  const style = document.createElement('style')
  style.textContent = `
    #pix-h-btn { display: none !important; }
    .pix-trans {
      display: block;
      clear: both;
      margin: 6px 0 2px;
      padding-top: 6px;
      border-top: 1px solid currentColor;
      border-top-color: rgba(255,255,255,.16);
      font-size: var(--pix-font-size, 15px);
      color: var(--pix-font-color, inherit);
      line-height: 1.45;
      opacity: 0.9;
      white-space: pre-wrap;
      /* ------------------------------------------------------------------
         译文必须能被选中、复制。
         真机现象：译文看得见却选不中 / 复制不出来。
         根因：译文框是宿主（WhatsApp / LINE / Telegram）气泡的后代，而这些宿主
         会在气泡容器上打 user-select: none（很多构建用的是**带前缀**的
         -webkit-user-select: none）。我们原来只声明了不带前缀、也不带
         !important 的 user-select: text，特异性/层叠上压不过宿主 →
         整个子树被禁选，译文跟着一起选不中。
         改法：两种写法都写、都加 !important 把选择权抢回来；同时挡住宿主
         在译文上重新开禁选的可能（用 -webkit-user-drag 关掉拖拽干扰）。
         这里的 !important 与下面 .pix-click 的 pointer-events 同理 ——
         与宿主争夺控件自身的交互能力，必须显式压过。
         ------------------------------------------------------------------ */
      user-select: text !important;
      -webkit-user-select: text !important;
      -webkit-user-drag: none;
      pointer-events: auto;
    }
    /* 宿主常把「按住拖动 = 选中整条消息」绑在气泡上；译文在气泡内，这会让
       在译文上按下时被宿主接管、选不中。放大可点/可选区域，别被父级吞掉。 */
    .pix-trans::selection,
    .pix-trans *::selection {
      background: rgba(96, 165, 250, .35);
    }
    .message-in .pix-trans, .message-list-item:not(.own) .pix-trans {
      border-top-color: rgba(255,255,255,.12);
    }
    /* ------------------------------------------------------------------
       混合路由标记：这句译文实际是**哪条通道**翻的。

       服务端开了混合路由后，短句走专用翻译 API、长句走 LLM。
       用户选的是 LLM 通道 —— 若不在界面上标出来，就成了"静默切换供应商"。

       只在 data-pix-routed 存在时显示（= 路由真的发生了），
       没路由的译文完全不受影响，保持原样。
       用 ::after + content: attr() 而不是往 DOM 里塞节点：
       多一个元素就多一次 MutationObserver 回调，容易把扫描器带进自激。
       ------------------------------------------------------------------ */
    .pix-trans[data-pix-routed]::after {
      content: "· 快速通道";
      display: inline-block;
      margin-left: 6px;
      font-size: 10px;
      line-height: 1;
      vertical-align: middle;
      padding: 2px 5px;
      border-radius: 8px;
      opacity: 0.55;
      border: 1px solid currentColor;
      pointer-events: none;
      user-select: none;
    }
    /* ------------------------------------------------------------------
       翻译操作行（P0-3：入口被 WhatsApp 时间/勾遮挡）
       真机现象：单行/短消息时，"译"和 WhatsApp 的时间 / 单勾 / 双勾挤在气泡
       右下角，按钮被盖住、点不动。
       根因：入口是**内联**贴在正文后面，而 WhatsApp 的 metadata（时间/勾）是
       贴在气泡右下角的（绝对定位 / 右对齐）。正文一短，两者就叠在同一块区域。
       改法：入口不再贴正文尾部，也不再抢右下角 ——
         用一个**正常文档流**的独立行 .pix-trans-action-row，占满整行、
         强制单独成行、位于正文下方，让气泡自然增高。
       该行**不用绝对定位、不用负 margin、不用 z-index** 去覆盖 metadata；
       按钮左对齐，远离右下角的时间/勾，从结构上不可能互相遮挡。
       ------------------------------------------------------------------ */
    .pix-trans-action-row {
      display: block;
      clear: both;
      width: 100%;
      flex-basis: 100%;
      position: static;
      margin: 6px 0 0;
      text-align: left;
      line-height: 1.2;
    }
    .pix-click {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin: 0;
      padding: 3px 9px;
      border-radius: 8px;
      background: rgba(255,255,255,.12);
      font-size: 12px;
      line-height: 1.2;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      /* 真机可点击性：WhatsApp 的消息层在若干状态下会关掉 pointer-events，
         继承下来按钮就"看得见、点不动"。这里显式打开。
         注意：**不靠叠加层级 / 绝对定位**去压 metadata —— 位置问题由上面的
         文档流布局解决，这里只负责"可点"。 */
      pointer-events: auto !important;
      position: static;
      opacity: 0.85;
    }
    /* 翻译中：只存在于 Hello Pix 自己的控件上，绝不进输入框/消息正文。 */
    .pix-click[data-pix-state="busy"] {
      opacity: 1;
      cursor: progress;
    }
    .pix-click[data-pix-state="fail"] {
      opacity: 1;
      color: #f87171;
      background: rgba(248,113,113,.16);
    }
    .pix-kept {
      display: block;
      clear: both;
      margin-top: 6px;
      white-space: pre-wrap;
      line-height: 1.45;
    }
    .pix-revoked {
      display: block;
      margin-top: 4px;
      font-size: 11px;
      color: #d97706;
      opacity: 0.95;
    }
  `
  function mountStyle() {
    if (document.documentElement && !style.isConnected) document.documentElement.appendChild(style)
  }
  mountStyle()
  if (!document.documentElement) document.addEventListener('DOMContentLoaded', mountStyle, { once: true })

  /* ------------------------------------------------------------------
     译文可选中的第二道保险（事件层）。
     CSS 只能解决"宿主用 user-select: none 禁选"。有一类宿主用的是**事件**：
     在气泡 / 消息列表上挂 selectstart / mousedown / copy 并 preventDefault，
     于是即便 CSS 允许选中，按下拖动 / 复制那一刻也会被宿主取消。
     这里在 **document 捕获阶段**监听：document 捕获是最外层，比宿主挂在
     气泡 / #main 上的任何监听都先收到事件；对落在译文框里的目标直接
     stopPropagation —— 宿主**根本收不到**这一下，它的 preventDefault 无从生效。
     只对 .pix-trans 生效，其它区域照旧向上传，绝不影响宿主自己的禁选逻辑。
     ------------------------------------------------------------------ */
  function inPixTrans(target) {
    if (!target || typeof target.closest !== 'function') return false
    try { return !!target.closest('.pix-trans') } catch (e) { return false }
  }
  ;['selectstart', 'copy'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      if (!inPixTrans(event.target)) return
      const box = (typeof event.target.closest === 'function') ? event.target.closest('.pix-trans') : null
      // 掐断向宿主的传播：宿主挂在气泡 / #main 上的捕获监听收不到这一下。
      // 注意 —— stopPropagation 不阻止**同一个 document 节点**上的其它监听；
      // 若真有宿主把监听挂在 document 且比我们更早注册，那已经超出我们能救的
      // 范围（它先执行并取消）。真机宿主都挂在气泡层，这里覆盖得住。
      event.stopPropagation()
      // 兜底：极少数宿主在更内层、更早的阶段已经取消过（defaultPrevented 为真），
      // 我们无法"撤销"一次 preventDefault。此时直接把译文整段选中，
      // 让用户至少能立刻 Cmd/Ctrl+C 复制走 —— 好过"选不中"。
      if (event.type === 'selectstart' && event.defaultPrevented) {
        try {
          const sel = window.getSelection()
          if (sel && sel.rangeCount === 0) {
            const range = document.createRange()
            range.selectNodeContents(box)
            sel.removeAllRanges()
            sel.addRange(range)
          }
        } catch (e) {}
      }
    }, true)
  })

  function api() {
    return pixBridge
  }

  function applyPrefs(next) {
    if (!next) return
    prefs = {
      transRecv: next.transRecv !== 0 && next.transRecv !== false,
      transSend: next.transSend !== 0 && next.transSend !== false,
      transGroup: !!(next.transGroup && next.transGroup !== '0'),
      langMine: next.langMine || 'zh',
      langOther: next.langOther || 'auto',
      sendTo: next.sendTo && next.sendTo !== 'auto' ? next.sendTo : 'en',
      includeZh: next.includeZh === 1 || next.includeZh === true || next.includeZh === 'true',
      antiRevoke: !!(next.antiRevoke && next.antiRevoke !== '0'),
      // 取证用：真机 trace 里必须能看出是哪个窗口 / 哪条通道
      tabId: next.tabId || '',
      partition: next.partition || '',
      engine: next.engine || '',
      // 沉降确认窗（下限）与上限：只接受数字，负数按 0 处理（测试会把它调到很小）。
      // 未提供时**保持当前值** —— 局部 prefs 推送不应该把它重置回默认。
      sendSettleMs: Number.isFinite(Number(next.sendSettleMs))
        ? Math.max(0, Number(next.sendSettleMs))
        : prefs.sendSettleMs,
      sendSettleCeilingMs: Number.isFinite(Number(next.sendSettleCeilingMs))
        ? Math.max(0, Number(next.sendSettleCeilingMs))
        : prefs.sendSettleCeilingMs
    }
    const root = document.documentElement
    root.style.setProperty('--pix-font-size', (Number(next.fontSize) || 15) + 'px')
    if (next.fontColor) root.style.setProperty('--pix-font-color', next.fontColor)
    schedule()
  }
  window.__helloPixApplyPrefs = applyPrefs

  // ==== MESSAGE PARSER BEGIN ====
  //
  // 消息解析器：把「一条消息的 DOM」解析成结构化字段，只让正文进翻译。
  //
  // ## 为什么需要它
  //
  // 老实现是把消息容器的 innerText 整个拿去翻译：
  //
  //     const clone = host.cloneNode(true)
  //     clone.querySelectorAll('.MessageMeta, .message-time, ...').forEach(el => el.remove())
  //     return clone.innerText
  //
  // 那份排除名单是**按 Telegram 的类名**写的。WhatsApp 的类名完全不同，于是
  // WhatsApp 的时间、已读勾（`wds-ic-read`）、链接预览卡片（站点域名 / 标题 /
  // 描述 / URL）和 "View group" 按钮全部被当成正文送进了翻译接口 ——
  // 真机上就表现为「译文里混进 3:25 PM、wds-ic-read、查看群组」。
  //
  // ## 铁律
  //
  // 绝不能把 messageBubble.innerText / textContent / parentElement.textContent
  // 直接当翻译输入。WhatsApp 的用户正文只有 `span.selectable-text` 里那一段，
  // 其余（时间、勾、预览卡片、按钮）都在它外面。所以这里**只做正向提取**：
  // 找不到正文就返回空串（宁可不翻译），**绝不**回退成"把整个气泡的文字都拿来"。
  //
  // ## 链接预览
  //
  // 预览卡片是 UI metadata，不是用户正文 —— 用户实际发出的可能只有那个 URL。
  // 因此：卡片按祖先容器整体排除；正文里的 URL 抽出来单独放 `urls[]`，
  // 翻译时用占位符顶替；抽掉 URL 后没有可翻译内容（纯 URL 消息）→ 不调翻译接口。
  //
  // ## 测试约定
  //
  // 这一段必须**自包含**（除标准 DOM 外不引用任何外部变量）。
  // test/message-parser.test.js 会把 BEGIN/END 之间的源码原样抽出来塞进 jsdom
  // 跑真 DOM 用例；一旦引用了外面的东西，抽出去就跑不起来。
  // ====
  var MessageParser = (function () {
    'use strict'

    // 发送中占位符。任何一份都不允许离开输入框 —— 翻译链路出任何差错，
    // 都不能让 [正在翻译中...] 变成一条真实消息（线上出现过）。
    var BUSY_MARKS = ['[正在翻译中...]', '|翻译中...', '[翻译中...]', '翻译中...']

    // 用户正文里的 URL。抽出来单独保管，翻译时用占位符顶替，译文里原样放回。
    //
    // 最后那个负向先行断言是必须的：真机上预览卡片的 URL 和正文的 URL 会被
    // innerText 粘成 `...mVhttps://...mV` 一条。少了它就变成一个吞掉两段的长 URL，
    // 两个网址谁都点不开。加上之后第一个 URL 会在第二个 scheme 前停下。
    var URL_RE = /\b(?:https?:\/\/|www\.)(?:(?!https?:\/\/|www\.)[^\s<>"'`])+/gi
    var URL_HINT_RE = /\b(?:https?:\/\/|www\.)/i
    // 占位符回填。容忍模型把 [[1]] 写成 [[ 1 ]] 或 [ [1] ]。
    var PLACEHOLDER_RE = /\[\[\s*(\d+)\s*\]\]/g
    /**
     * emoji 占位符。**刻意与 URL 用不同的括号形态**。
     *
     * ## 为什么不能复用 [[n]]
     *
     * 同一个 `[[1]]` 在模型眼里分不出"这是网址"还是"这是表情"。一旦编号
     * 撞上，回填就会把表情塞到网址的位置、或反过来 —— 那比丢表情更糟，
     * 因为它会**发错内容**。
     *
     * `{{e1}}` 是独立的命名空间：两套占位符永远不会互相匹配。
     *
     * ## 为什么用"字母 + 数字"而不是纯数字
     *
     * 模型偶尔会把 `[[1]]` 里的数字算进去（比如自作主张改成 [[2]]）。
     * `{{e1}}` 带个 `e` 前缀，被模型当成"某种标记"而不是"序号"的概率更高，
     * 回填失败的几率也就更低；且回填失败时有下面的兜底。
     */
    var EMOJI_SLOT_RE = /\{\{\s*e\s*(\d+)\s*\}\}/gi
    /**
     * 一个 emoji 的完整范围。
     *
     * ## 为什么这么长
     *
     * "一个 emoji"远不是一个码点：
     *   · 😂            → Extended_Pictographic，1 个码点
     *   · 👍🏽           → 基础字符 + 肤色修饰符（Emoji_Modifier）
     *   · ❤️            → 基础字符 + 变体选择符 U+FE0F（少了它就成了黑白符号）
     *   · 1️⃣            → 数字 + FE0F + 组合用键帽 U+20E3
     *   · 👨‍👩‍👧          → 三个 emoji 用零宽连接符 U+200D 串起来
     *   · 🇧🇷            → 两个 Regional Indicator 组成一面旗
     *
     * 只匹配 Extended_Pictographic 会把 👍🏽 拆成"👍 + 🏽"，回填时贴出一堆
     * 零散修饰符。所以这里按"整个序列"匹配，一次吃干净。
     */
    var EMOJI_SEQ_RE = new RegExp(
      '(?:' +
        // 国旗：两个 Regional Indicator
        '[\\u{1F1E6}-\\u{1F1FF}]{2}' +
        '|' +
        // 通用 emoji 序列：基础字符 (+ 变体选择符)? (+ 肤色)? (ZWJ + 后续)*
        '(?:\\p{Extended_Pictographic}|\\p{Emoji_Presentation})' +
        '(?:[\\uFE0F\\uFE0E])?' +
        '(?:[\\u{1F3FB}-\\u{1F3FF}])?' +
        '(?:(?:\\u200D)(?:\\p{Extended_Pictographic})(?:[\\uFE0F])?(?:[\\u{1F3FB}-\\u{1F3FF}])?)*' +
        '|' +
        // 键帽序列：数字/#/* + FE0F? + 组合用键帽
        '[0-9#*][\\uFE0F]?\\u20E3' +
      ')',
      'gu'
    )

    // 图标字体类名。WhatsApp 新设计系统把 read/delivered 勾渲染成
    // class/data-icon="wds-ic-read" 的元素，某些构建下这段类名会作为文本被带出来
    // （真机截图里出现过）。真实用户正文不会长这样，可以安全丢弃。
    var ICON_TOKEN_RE = /^(?:wds-ic-|wds-|ic-)[a-z0-9_-]+$/i

    // 时间 / 送达状态。**只在非首个候选节点上过滤** —— 既挡掉元信息行，
    // 又保留"用户真的只发了一句 3:25 PM"的可能。
    var TIME_ONLY_RE = /^(?:\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM|am|pm))?|\d{1,2}\s*(?:AM|PM|am|pm))$/
    var DELIVERY_ONLY_RE = /^(?:read|delivered|sent|pending|已读|已读回执|已送达|已发送|发送中|未读)$/i

    // WhatsApp 的正文标记。只有它里面那一段是用户正文。
    var SELECTABLE_SEL = '.selectable-text'
    var COPYABLE_SEL = '.copyable-text'
    var PRE_PLAIN_ATTR = 'data-pre-plain-text'

    // 预览卡片 / 引用块 / 系统提示的容器标记。命中即整块不当正文。
    var PREVIEW_SEL = [
      '[data-testid*="preview" i]',
      '[data-testid*="link-preview" i]',
      '[class*="link-preview" i]',
      '[class*="linkpreview" i]',
      '[class*="preview-box" i]',
      '[data-link-preview]'
    ].join(', ')
    var QUOTED_SEL = [
      '[data-testid*="quoted" i]',
      '[data-testid*="quote" i]',
      '.quoted-mention',
      '[class*="quoted-" i]',
      '[aria-label*="quoted" i]'
    ].join(', ')

    // Telegram 里属于 UI 的节点。老实现只删了前四个，发信人名字、按钮、
    // 图标全都会漏进正文，这里补齐。
    var TELEGRAM_UI_SEL = [
      '.MessageMeta', '.message-time', 'time', '.Reactions', '.message-views',
      '.message-author-title', '.sender-title', '.peer-title', '.time',
      'button', '[role="button"]', '[data-icon]', 'svg', 'img',
      // 我们自己的界面（译文框、译按钮、提示条）。`[data-pix-ui]` 是统一标记，
      // 任何新加的控件只要带上它，就会被解析/采集自动跳过。
      '[data-pix-ui]',
      '.pix-trans', '.pix-click', '.pix-trans-action-row', '.pix-kept', '.pix-revoked'
    ].join(', ')

    // WhatsApp 兜底提取时，"这个容器里含有 UI/媒体元信息"的判据。
    // 命中即整块不当正文 —— 挡住时间、已读勾、图标、按钮、图片、预览缩略图。
    var MEDIA_UI_DESC_SEL = [
      'img', 'canvas', 'svg', 'video', '[data-icon]',
      'time', '.message-time', '.time', 'button', '[role="button"]',
      '.MessageMeta', '.pix-trans', '.pix-click', '.pix-trans-action-row', '.pix-kept', '.pix-revoked'
    ].join(', ')

    // -------------------------------------------------------------------
    // 文本工具
    // -------------------------------------------------------------------

    function dedupe(list) {
      var out = []
      for (var i = 0; i < list.length; i++) if (out.indexOf(list[i]) === -1) out.push(list[i])
      return out
    }

    function collapse(text) {
      return String(text == null ? '' : text)
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\s*\n\s*/g, '\n')
        .trim()
    }

    function hasBusy(text) {
      var s = String(text == null ? '' : text)
      for (var i = 0; i < BUSY_MARKS.length; i++) {
        if (s.indexOf(BUSY_MARKS[i]) !== -1) return true
      }
      return false
    }

    /**
     * 摘掉发送中占位符。
     *
     * 这是最后一道防线：译文写回输入框之后、真正点发送之前，必须用它过一遍。
     * 写回失败（execCommand 没替换成功、被页面脚本插了一脚、异步被打断）
     * 都可能把占位符留在框里，然后被当成用户消息发出去。
     */
    function stripBusy(text) {
      var s = String(text == null ? '' : text)
      for (var i = 0; i < BUSY_MARKS.length; i++) s = s.split(BUSY_MARKS[i]).join('')
      return collapse(s)
    }

    function isIconNoise(line) {
      return ICON_TOKEN_RE.test(String(line || '').trim())
    }

    function isTimeOnly(line) {
      return TIME_ONLY_RE.test(String(line || '').trim())
    }

    function isDeliveryOnly(line) {
      return DELIVERY_ONLY_RE.test(String(line || '').trim())
    }

    /**
     * 逐行清理：丢空行、丢图标类名，按需丢时间/送达状态行，合并相邻重复行。
     *
     * dropMeta 只在"非首个候选节点"上开：首个候选是真正的正文，哪怕它长得
     * 像时间也照留；后面的候选都是元信息，时间/已读就该被丢掉。
     */
    function cleanLines(lines, dropMeta) {
      var out = []
      for (var i = 0; i < lines.length; i++) {
        var t = String(lines[i] == null ? '' : lines[i]).trim()
        if (!t) continue
        if (isIconNoise(t)) continue
        if (dropMeta && (isTimeOnly(t) || isDeliveryOnly(t))) continue
        if (out[out.length - 1] === t) continue
        out.push(t)
      }
      return out
    }

    // -------------------------------------------------------------------
    // URL：抽离 / 占位 / 回填
    // -------------------------------------------------------------------

    function trimUrlTail(match) {
      // 句尾标点不属于 URL，别把它吞进占位符（否则标点会跟着 URL 一起"原样保留"，
      // 位置还可能被模型挪走）。尾部标点留在正文里参与翻译。
      return String(match).replace(/[.,;:!?)\]}>'"]+$/, '')
    }

    /**
     * 把正文里的 URL 换成 [[n]] 占位符。
     *
     * 相同 URL 复用同一个占位符：真机上出现过预览卡片与正文各出一个 URL、
     * innerText 把它们粘在一起的情况，去重后只保留一份。
     */
    function maskUrls(text) {
      var urls = []
      var index = {}
      var masked = String(text == null ? '' : text).replace(URL_RE, function (match) {
        var url = trimUrlTail(match)
        if (!url) return match
        var tail = match.slice(url.length)
        var slot = index[url]
        if (slot === undefined) {
          urls.push(url)
          slot = urls.length - 1
          index[url] = slot
        }
        return '[[' + (slot + 1) + ']]' + tail
      })
      return { masked: masked, urls: urls }
    }

    /**
     * 把译文里的占位符换回原 URL。
     *
     * 模型偶尔会把占位符弄丢。丢了也不能让 URL 消失（那是用户真正要发出去的东西），
     * 所以缺失的一律追加到末尾 —— 保 URL 不丢、不被翻译，比修辞好看重要。
     */
    function restoreUrls(translated, urls) {
      var list = urls || []
      var text = String(translated == null ? '' : translated)
      if (!list.length) return text
      var used = {}
      var out = text.replace(PLACEHOLDER_RE, function (all, n) {
        var i = Number(n) - 1
        if (!(i >= 0 && i < list.length)) return all
        used[i] = true
        return list[i]
      })
      var missing = []
      for (var i = 0; i < list.length; i++) if (!used[i]) missing.push(list[i])
      if (!missing.length) return out
      return (out.replace(/\s+$/, '') + '\n' + missing.join('\n')).trim()
    }

    /**
     * 把正文里的 emoji 换成 `{{e1}}` 占位符，返回 { masked, emojis }。
     *
     * ## 为什么不是"直接删掉"（这正是要修的 bug）
     *
     * 老实现是 `stripEmoji(text)` —— 送去翻译**之前**就把表情删了。
     * 表情没进接口，自然也没进译文，发出去的整句话里表情就没了。
     * 用户看到的是"翻译不错，但吃掉了我的 emoji"。
     *
     * ## 为什么也不让模型自己保留
     *
     * 把 😂 原样送进模型，等于赌它"原样吐回来"。实测不可靠：
     * 有的模型会换成 😆，有的会在中文译文中把它挪到句首，有的直接省掉。
     * 而表情是**用户亲手选的语气**，不许任何人改写 —— 所以必须由我们
     * 自己保管、自己回填，模型连看都别看到。
     *
     * ## 与 URL 的关系
     *
     * 调用顺序是 `maskUrls` 之后再 `maskEmoji`。两者占位符形态不同
     * （[[n]] vs {{en}}），互不干扰，回填顺序也不敏感。
     */
    function maskEmoji(text) {
      var emojis = []
      var masked = String(text == null ? '' : text).replace(EMOJI_SEQ_RE, function (match) {
        emojis.push(match)
        return '{{e' + emojis.length + '}}'
      })
      return { masked: masked, emojis: emojis }
    }

    /**
     * 把译文里的 `{{en}}` 换回原始 emoji。
     *
     * ## 模型把占位符弄丢了怎么办
     *
     * 这种情况必须兜住，否则又回到"吃表情"。策略按顺序：
     *
     *   1. 占位符还在原位 → 换回，位置最准确；
     *   2. 占位符还在但顺序乱了（模型重排句子）→ 按编号逐个换回，
     *      位置跟着占位符走 —— 至少表情还在；
     *   3. 占位符整个没了 → **按原顺序追加到末尾**。
     *
     * 第 3 条刻意不猜位置：表情插错地方比追加到末尾更容易造成误解
     * （例如把 😂 插进"我很生气"后面）。追加到末尾虽然位置不完美，
     * 但语义不会反过来。
     *
     * 与 restoreUrls 的取舍一致：宁可位置不完美，也不能让用户的内容消失。
     */
    function restoreEmoji(translated, emojis) {
      var list = emojis || []
      var text = String(translated == null ? '' : translated)
      if (!list.length) return text
      var used = {}
      var out = text.replace(EMOJI_SLOT_RE, function (all, n) {
        var i = Number(n) - 1
        if (!(i >= 0 && i < list.length)) return all
        used[i] = true
        return list[i]
      })
      // 兜底：模型没吐回来的表情，按原顺序补在末尾
      var missing = []
      for (var i = 0; i < list.length; i++) if (!used[i]) missing.push(list[i])
      if (!missing.length) return out
      return (out.replace(/\s+$/, '') + ' ' + missing.join('')).trim()
    }

    /**
     * 一句话里有没有"可翻译的正文"（去掉 emoji / URL / 占位符之后还有东西）。
     *
     * 纯表情消息不该触发翻译：既没有可翻的字，又会白花一次额度。
     * 老实现靠 stripEmoji 判空，现在 emoji 变成占位符了，判据要跟着改。
     */
    function hasEmojiOnly(text) {
      var raw = String(text == null ? '' : text).trim()
      if (!raw) return false
      return !raw.replace(EMOJI_SEQ_RE, '').trim()
    }

    function extractUrls(text) {
      var found = String(text == null ? '' : text).match(URL_RE) || []
      var out = []
      for (var i = 0; i < found.length; i++) {
        var url = trimUrlTail(found[i])
        if (url && out.indexOf(url) === -1) out.push(url)
      }
      return out
    }

    /**
     * 抽掉 URL 之后还剩不剩可翻译的内容？
     *
     * 纯 URL 消息（用户只发了个群邀请链接）必须判为 false ——
     * 用户明确要求：不调用翻译接口，URL 原样保留。
     */
    function hasTranslatableText(masked) {
      var left = String(masked == null ? '' : masked).replace(PLACEHOLDER_RE, ' ')
      return /[\p{L}\p{N}]/u.test(left)
    }

    // -------------------------------------------------------------------
    // DOM 取值
    // -------------------------------------------------------------------

    function classNameOf(el) {
      if (!el) return ''
      var cls = el.className
      if (typeof cls === 'string') return cls
      if (cls && typeof cls.baseVal === 'string') return cls.baseVal
      return String(cls || '')
    }

    /**
     * 取元素的可读文本。
     *
     * 优先 innerText（浏览器里它会按块级边界插换行，多行消息才不会被粘成一行）；
     * jsdom 没有实现 innerText，就退回 textContent 并手工把 <br> 换成换行，
     * 尽量贴近浏览器行为，免得测试和真机两套结果。
     */
    function nodeText(el) {
      if (!el) return ''
      if (typeof el.innerText === 'string') return collapse(el.innerText)
      var clone = el.cloneNode(true)
      var brs = clone.querySelectorAll ? clone.querySelectorAll('br') : []
      for (var i = 0; i < brs.length; i++) brs[i].replaceWith('\n')
      return collapse(clone.textContent || '')
    }

    function hasAncestorAttr(el, name, stopAt) {
      var cur = el
      while (cur) {
        if (cur.getAttribute && cur.getAttribute(name) !== null) return true
        if (cur === stopAt) break
        cur = cur.parentElement
      }
      return false
    }

    function matchesAny(el, selector) {
      if (!el || !el.matches) return false
      try { return el.matches(selector) } catch (e) { return false }
    }

    function insideOf(el, selector, stopAt) {
      var cur = el
      while (cur) {
        if (matchesAny(cur, selector)) return true
        if (cur === stopAt) break
        cur = cur.parentElement
      }
      return false
    }

    /** 纯 UI 节点：图标、按钮、时间戳。结构上就不可能是用户正文。 */
    function isUiNode(el) {
      if (!el) return true
      if (el.getAttribute && el.getAttribute('data-icon') !== null) return true
      var tag = String(el.tagName || '').toLowerCase()
      if (tag === 'button' || tag === 'svg' || tag === 'time' || tag === 'img') return true
      if (el.getAttribute && String(el.getAttribute('role') || '').toLowerCase() === 'button') return true
      return false
    }

    /**
     * 链接预览卡片的结构特征：同时有缩略图（img/canvas）和按钮。
     * 用来兜底那些没有 data-testid / class 标记的构建版本。
     */
    function looksLikePreviewCard(el) {
      if (!el || !el.querySelector) return false
      if (matchesAny(el, PREVIEW_SEL)) return true
      var thumb = el.querySelector('img[src], canvas')
      var button = el.querySelector('button, [role="button"]')
      return !!(thumb && button)
    }

    function detectPlatform(root) {
      if (!root) return 'telegram'
      var probe = root.querySelector ? root : (root.parentElement || null)
      if (probe && probe.querySelector) {
        if (hasAncestorAttr(root, PRE_PLAIN_ATTR, null)) return 'whatsapp'
        if (probe.querySelector(COPYABLE_SEL)) return 'whatsapp'
        if (matchesAny(root, COPYABLE_SEL)) return 'whatsapp'
        if (probe.querySelector('.translatable-message')) return 'telegram'
        if (probe.querySelector('.MessageMeta, .message-time, .message-list-item')) return 'telegram'
      }
      // WhatsApp 的行用数字 peer id 作 data-id，个人号带 @c.us / @g.us
      var id = root.getAttribute ? String(root.getAttribute('data-id') || '') : ''
      if (id.indexOf('@c.us') >= 0 || id.indexOf('@g.us') >= 0) return 'whatsapp'
      return 'telegram'
    }

    // -------------------------------------------------------------------
    // WhatsApp
    // -------------------------------------------------------------------

    /**
     * 收集真正的正文候选。
     *
     * ## 第一优先：`.selectable-text`（WhatsApp 给"用户可选中文字"打的正规标记）
     *
     * 时间、勾、卡片文案、按钮都没有这个标记，所以它是最可靠的正文信号。
     * 外层若已收录，内层直接跳过（外层 textContent 已含内层）。
     *
     * ## 为什么还要兜底（0.1.28 修的真机缺陷）
     *
     * 用户报障：「图文一起发送的时候，不翻译」。真机「图片 + 文字」消息有二类形态：
     *
     *   ① caption **没有** `span.selectable-text`（直接在 `.copyable-text` 容器里，
     *      或在 `[data-testid="msg-container"]` 的 caption 子容器里）。
     *      → `.selectable-text` 命中 0 → 正文取空 → translatable=false → hide。
     *
     * ## 为什么是"非此即彼"而不是两路合并（这是本修复的关键取舍）
     *
     * 曾经试过把兜底候选与 `.selectable-text` **合并**，结果立刻回归：
     * 兜底会把文件名（`invoice-2026.pdf`）、图片占位（`photo.jpg`）这类
     * "不在 selectable-text 里但我们不该翻"的 UI 文字一并收进来 ——
     * 用例 8「文件名不能进正文」当场变红。
     *
     * `.selectable-text` 一旦存在就说明它有权威性：WhatsApp 只给"用户可选中
     * 的文字"打这个标记，文件名/占位/时间/按钮都没有。此时再掺入启发式候选
     * 只会引入噪音。所以：**只在 selectable 命中 0 个时才启用兜底** ——
     * 既修好"文字没有标记"的图文消息，又不动任何既有行为。
     *
     * 待确认（需要真机 DOM 证据）：若真机上图片**自身**带 `.selectable-text`
     * 而 caption 在它旁边没有标记，本方案会取到图片占位而不是 caption。
     * 这种情况必须靠真机证据决定怎么处理，不能靠猜 —— 因为在没有真机结构时
     * 每加一条启发式规则，都会先打破一个已通过的用例。
     */
    function whatsappCandidates(root) {
      var out = []
      var consider = function (el) {
        if (!el || !el.textContent) return
        if (out.indexOf(el) !== -1) return
        if (isUiNode(el)) return
        if (insideOf(el, PREVIEW_SEL, root)) return
        if (insideOf(el, QUOTED_SEL, root)) return
        if (looksLikePreviewCard(el)) return
        for (var i = 0; i < out.length; i++) {
          if (out[i] !== el && out[i].contains && out[i].contains(el)) return
        }
        out.push(el)
      }
      if (matchesAny(root, SELECTABLE_SEL)) consider(root)
      var found = root.querySelectorAll ? root.querySelectorAll(SELECTABLE_SEL) : []
      for (var i = 0; i < found.length; i++) consider(found[i])
      if (out.length) return out
      return whatsappCaptionCandidates(root)
    }

    /**
     * 兜底：从消息行里提取 caption 正文候选。
     *
     * 判定"这是正文容器"的充分条件（全部满足才算）：
     *   1. 自身有可读文字（字母/数字/表意文字），不是纯图片/图标/时间；
     *   2. 不在预览卡片、引用块、自有 UI（data-pix-ui / .pix-*）里；
     *   3. 不是按钮 / 图标 / 时间戳 / 送达状态（isUiNode + 逐行清洗）；
     *   4. **自身不含任何 UI 元信息后代**：`img` / `canvas` / `svg` /
     *      `[data-icon]` / `time` / `button` / `[role=button]` / `.message-time`。
     *      这一条是硬闸门 —— 没有它，兜底会选到 `.copyable-text` 这类外层容器，
     *      把时间（3:25 PM）与已读图标（wds-ic-read）的 textContent 一起带进翻译，
     *      正是 `message-parser.test.js` 的 FORBIDDEN 列表严防的 P0 回归。
     *   5. 不含 `<img>` / `<canvas>`：媒体容器本身不当正文 —— 但它的**兄弟**
     *      caption 容器可以。这样"图片 + 文字"里只把文字收进来。
     *
     * 收"最内层"：若某候选的祖先也是候选，只留离文字最近的那层；
     * 同一段文字被多层容器（div > span）包住时按 textContent 去重。
     */
    function whatsappCaptionCandidates(root) {
      var out = []
      if (!root || !root.querySelectorAll) return out
      var all = root.querySelectorAll('div, span, p, section')
      for (var i = 0; i < all.length; i++) {
        var el = all[i]
        if (isUiNode(el)) continue
        if (insideOf(el, PREVIEW_SEL, root)) continue
        if (insideOf(el, QUOTED_SEL, root)) continue
        if (insideOf(el, '[data-pix-ui]', root)) continue
        if (looksLikePreviewCard(el)) continue
        // 媒体/UI 后代一律剔除：含 img/canvas 的容器，或含时间/图标/按钮的容器
        if (el.querySelector && el.querySelector(MEDIA_UI_DESC_SEL)) continue
        var text = nodeText(el)
        if (!text) continue
        if (!/[\p{L}\p{N}]/u.test(text)) continue
        if (hasBusy(text)) continue
        out.push(el)
      }
      // 只留"最内层"：任何被另一个候选包含的候选，丢掉外层（保留离文字最近的那层）
      var leaves = []
      for (var j = 0; j < out.length; j++) {
        var contained = false
        for (var k = 0; k < out.length; k++) {
          if (j === k) continue
          if (out[k].contains && out[k].contains(out[j]) && out[k] !== out[j]) { contained = true; break }
        }
        if (!contained) leaves.push(out[j])
      }
      // 同一个文字块可能被多个叶子包着（div > span），去重：清理后的正文相同只留一个
      var picked = []
      var seen = {}
      for (var m = 0; m < leaves.length; m++) {
        var key = cleanLines(nodeText(leaves[m]).split('\n'), true).join('\n')
        if (!key || seen[key]) continue
        seen[key] = true
        picked.push(leaves[m])
      }
      return picked
    }

    function whatsappBody(root) {
      var cands = whatsappCandidates(root)
      var lines = []
      for (var i = 0; i < cands.length; i++) {
        var part = nodeText(cands[i])
        if (!part) continue
        var chunk = cleanLines(part.split('\n'), i > 0)
        for (var j = 0; j < chunk.length; j++) lines.push(chunk[j])
      }
      return dedupe(lines).join('\n')
    }

    /** data-pre-plain-text="[3:25 PM, 9/25/2026] 名字: " —— 时间和发信人都在这。 */
    function whatsappPrePlain(root) {
      var holder = null
      if (root && root.getAttribute && root.getAttribute(PRE_PLAIN_ATTR) !== null) holder = root
      else if (root && root.querySelector) holder = root.querySelector('[' + PRE_PLAIN_ATTR + ']')
      var raw = holder ? String(holder.getAttribute(PRE_PLAIN_ATTR) || '') : ''
      var match = /^\[([^\]]*)\]\s*([\s\S]*?):\s*$/.exec(raw)
      if (!match) return { raw: raw, time: '', date: '', sender: '' }
      var stamp = match[1].split(',').map(function (s) { return s.trim() }).filter(Boolean)
      return { raw: raw, time: stamp[0] || '', date: stamp[1] || '', sender: (match[2] || '').trim() }
    }

    function whatsappDeliveryState(root) {
      var icons = root && root.querySelectorAll ? root.querySelectorAll('[data-icon]') : []
      for (var i = 0; i < icons.length; i++) {
        var icon = String(icons[i].getAttribute('data-icon') || '')
        if (!icon || !/check|read|deliver|sent|status|time/i.test(icon)) continue
        if (/dbl|double|read|2/i.test(icon)) return 'read'
        if (/check|deliver|sent/i.test(icon)) return 'delivered'
      }
      return ''
    }

    /** 消息里 WhatsApp 自己的按钮文案（View group / Download / Open / Forward ...）。 */
    function whatsappSystemLabels(root) {
      var els = root && root.querySelectorAll ? root.querySelectorAll('button, [role="button"]') : []
      var out = []
      for (var i = 0; i < els.length && out.length < 12; i++) {
        var t = nodeText(els[i])
        if (t && t.length <= 60 && out.indexOf(t) === -1) out.push(t)
      }
      return out
    }

    function whatsappPreview(root) {
      if (!root || !root.querySelector) return { title: '', description: '', url: '' }
      var card = root.querySelector(PREVIEW_SEL)
      if (!card) {
        var divs = root.querySelectorAll('div')
        for (var i = 0; i < divs.length && i < 80; i++) {
          if (divs[i].querySelector('img[src], canvas') && divs[i].querySelector('button, [role="button"]')) {
            card = divs[i]
            break
          }
        }
      }
      if (!card) return { title: '', description: '', url: '' }
      var lines = cleanLines(nodeText(card).split('\n'), false)
      var url = ''
      var rest = []
      for (var j = 0; j < lines.length; j++) {
        if (!url && URL_HINT_RE.test(lines[j])) url = trimUrlTail(lines[j])
        else rest.push(lines[j])
      }
      return { title: rest[0] || '', description: rest[1] || '', url: url }
    }

    function whatsappQuoted(root) {
      if (!root || !root.querySelector) return ''
      var el = root.querySelector(QUOTED_SEL)
      return el ? nodeText(el) : ''
    }

    function parseWhatsApp(root) {
      var body = whatsappBody(root)
      var stamp = whatsappPrePlain(root)
      var preview = whatsappPreview(root)
      return {
        platform: 'whatsapp',
        messageText: body,
        urls: extractUrls(body),
        timestamp: stamp.time,
        date: stamp.date,
        sender: stamp.sender,
        quotedText: whatsappQuoted(root),
        previewTitle: preview.title,
        previewDescription: preview.description,
        previewUrl: preview.url,
        systemLabels: whatsappSystemLabels(root),
        deliveryState: whatsappDeliveryState(root)
      }
    }

    // -------------------------------------------------------------------
    // Telegram
    // -------------------------------------------------------------------

    function telegramBody(root) {
      var node = null
      if (matchesAny(root, '.translatable-message')) node = root
      else if (root.querySelector) node = root.querySelector('.translatable-message')
      var raw
      if (node) {
        raw = nodeText(node)
      } else {
        var clone = root.cloneNode(true)
        var junk = clone.querySelectorAll ? clone.querySelectorAll(TELEGRAM_UI_SEL) : []
        for (var i = 0; i < junk.length; i++) junk[i].remove()
        raw = collapse(clone.innerText === undefined ? clone.textContent : clone.innerText)
      }
      var lines = cleanLines(String(raw).split('\n'), true)
      // Telegram 不用 .selectable-text 划正文范围，清洗过度就会把内容弄没。
      // 真清空了就退回清洗前的原文 —— 宁可带点噪音，也不能什么都不翻译。
      if (!lines.length) return collapse(raw)
      return lines.join('\n')
    }

    function parseTelegram(root) {
      var body = telegramBody(root)
      return {
        platform: 'telegram',
        messageText: body,
        urls: extractUrls(body),
        timestamp: '',
        date: '',
        sender: '',
        quotedText: '',
        previewTitle: '',
        previewDescription: '',
        previewUrl: '',
        systemLabels: [],
        deliveryState: ''
      }
    }

    function parseMessage(root) {
      // 拿不到节点就返回空结构，绝不去猜一段"看起来像正文"的文字。
      if (!root) {
        return {
          platform: '',
          messageText: '',
          urls: [],
          timestamp: '',
          date: '',
          sender: '',
          quotedText: '',
          previewTitle: '',
          previewDescription: '',
          previewUrl: '',
          systemLabels: [],
          deliveryState: ''
        }
      }
      return detectPlatform(root) === 'whatsapp' ? parseWhatsApp(root) : parseTelegram(root)
    }

    /**
     * 翻译链路的唯一入口。
     *
     * 返回值里只有 `sourceText` 允许发给翻译接口，其余字段仅供排查与 UI 使用。
     * `translatable === false` 表示"不该调翻译接口"：没有正文（纯图片 / 系统消息），
     * 或正文只有 URL（用户明确要求纯 URL 不翻译）。调用方必须尊重这个标记。
     */
    function parseForTranslation(root) {
      var parsed = parseMessage(root)
      // ★ 先保管 emoji，再保管 URL ★
      //
      // 表情必须和网址一样"抽出来、占个位、原样放回"：直接送进模型
      // 就等于赌它不改写。用户亲手选的语气符号，不许被翻译改写。
      // 两者占位符形态不同（{{en}} / [[n]]），互不干扰。
      var emojiMasked = maskEmoji(parsed.messageText)
      var masked = maskUrls(emojiMasked.masked)
      var out = {}
      for (var key in parsed) if (Object.prototype.hasOwnProperty.call(parsed, key)) out[key] = parsed[key]
      out.urls = masked.urls
      out.emojis = emojiMasked.emojis
      out.sourceText = masked.masked
      out.translatable = hasTranslatableText(masked.masked)
      return out
    }

    // -------------------------------------------------------------------
    // 计费决策
    // -------------------------------------------------------------------

    /**
     * 这条消息该怎么处理？**纯逻辑**，不碰 DOM 也不发请求，便于用真 DOM 用例锁死。
     *
     * 返回值就是调用方唯一允许做的动作：
     *   'auto'  —— 自动调翻译接口（会产生字符消耗）
     *   'chip'  —— 只给「译」按钮，用户点了才调接口
     *   'hide'  —— 清掉译文/按钮，什么都不做
     *
     * 之所以把它单独拎出来，是因为「群聊手动模式失效」这类缺陷一旦发生就是
     * **非预期扣费**，必须有一处能一眼看清、能被测试直接锁住的判断。
     *
     * ## 判定顺序：先看功能与内容（该不该有译文），再看模式（能不能自动翻）
     *
     * ## 「历史消息只给按钮」已删除 —— 为什么这不叫"放开计费"
     *
     * 0.1.24 这里还有一行「群聊 + 历史消息 → 只给按钮」，把群聊
     * 「自动」降级成"只有新到的自动翻、打开会话时那批只给按钮"。真机上它表现成
     * 「一部分翻译、一部分没有」，用户明确判定不对：「自动」就该是自动。
     *
     * 删它不增加"重复扣费"风险，因为**同一条消息翻多少次都只计一次费**：
     * 客户端 requestId 对同一段正文+同一通道是**恒定**的，服务端按它幂等，
     * 重放直接返回已有预留，不再扣字符。代价只发生在"从没翻过的正文"上。
     * 详见文件上方「群聊『手动 / 自动』」那段注释。
     */
    function messageAction(state) {
      var s = state || {}
      // 接收翻译关着：连按钮都不给
      if (!s.receiveEnabled) return 'hide'
      // 没有可翻译的正文（纯 URL 群邀请 / 纯图片 / 系统提示）：按钮点了也是空请求
      if (!s.translatable) return 'hide'
      if (s.emojiOnly) return 'hide'
      if (s.hasChinese && !s.includeZh) return 'hide'
      if (s.sameLang && !(s.includeZh && s.hasChinese)) return 'hide'
      // 这个平台的群聊/私聊判定还没经过真机验证：判不准群聊，就可能把整群当私聊
      // 自动翻译扣费。一律只给按钮，用户点了才翻。
      if (s.chatKindUnverified) return 'chip'
      // 群聊 + 手动：一条都不自动翻，只给按钮。这是**唯一**剩下的计费闸门，别动它。
      if (s.group && !s.transGroup) return 'chip'
      // 群聊 + 自动 / 私聊（私聊与开关无关，始终自动）：
      // 会话里出现的消息**全部自动翻**，包括打开会话时已经在页面上的那批。
      return 'auto'
    }

    /**
     * 群聊「历史 / 新消息」判定闸 —— **0.1.25 已删除**。
     *
     * 它曾经是「群聊=自动 但历史消息只给按钮」那条闸门的判据。真机证明那条闸门
     * 把「自动」变成了半自动（"一部分翻、一部分不翻"），用户裁定删除；
     * 判据没有别的调用方，一并删掉 —— 留着一段不再影响任何决策的"计费闸门"
     * 比没有更危险，下一个人会以为它还在保护什么。
     *
     * 如果将来又要做"历史隔离"，请**新写一个能被真 DOM 用例锁住的判据**，
     * 并先想清楚它与"自动就该自动"这条例的矛盾 —— 而不是把这段原样捞回来。
     */

    return {
      BUSY_MARKS: BUSY_MARKS,
      hasBusy: hasBusy,
      stripBusy: stripBusy,
      collapse: collapse,
      isIconNoise: isIconNoise,
      isTimeOnly: isTimeOnly,
      isDeliveryOnly: isDeliveryOnly,
      maskUrls: maskUrls,
      restoreUrls: restoreUrls,
      maskEmoji: maskEmoji,
      restoreEmoji: restoreEmoji,
      extractUrls: extractUrls,
      hasTranslatableText: hasTranslatableText,
      detectPlatform: detectPlatform,
      parseMessage: parseMessage,
      parseForTranslation: parseForTranslation,
      messageAction: messageAction
    }
  })()
  // ==== MESSAGE PARSER END ====

  function stripEmoji(text) {
    return String(text || '').replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim()
  }

  function isEmojiOnly(text) {
    const raw = String(text || '').trim()
    return !!raw && !stripEmoji(raw)
  }

  function isBusyText(text) {
    return MessageParser.hasBusy(text)
  }

  /**
   * 这条消息是不是**中文**（用来决定"母语消息不翻 / includeZh 关着就 hide"）。
   *
   * 不能只看 `[\u4e00-\u9fff]` —— 那个区间是 **CJK 统一汉字**，日语、韩语
   * 里的汉字（漢字）全都落在里面。原来这么写，导致：
   *
   *     こんにちは、会議は3時です
   *
   * 被判定成 hasChinese=true，而 includeZh 默认关闭 →
   * messageAction 直接返回 'hide'，**日语消息连「译」按钮都不给**。
   * 用户看到的就是"换成其他语言就完全没反应"。
   *
   * 现在多加一条：只要出现了假名，就不是中文。
   * 纯汉字句子（日本人也写的那些）仍按中文处理 —— 因为从字符上无法区分，
   * 而按中文处理的最坏结果是"不翻"，成本可控；反过来把中文判成外语，
   * 会拿用户的母语消息去扣费翻译。
   */
  function hasChinese(text) {
    const s = String(text || '')
    if (!/[\u4e00-\u9fff]/.test(s)) return false
    // 有假名 → 日语，不是中文
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(s)) return false
    // 有谚文 → 韩语（韩汉混写），不是中文
    if (/[\uac00-\ud7af]/.test(s)) return false
    return true
  }

  /**
   * 解析一条消息，返回结构化字段。
   *
   * scope 用**消息根**而不是 .text-content / .copyable-text：
   * WhatsApp 的链接预览卡片、时间、已读勾全都在 .copyable-text 里面，
   * 只有从消息行往下解析，才谈得上"把它们排除掉"。
   */
  function parseScope(node, host) {
    let root = host || node
    if (node && typeof node.closest === 'function') {
      const candidate = messageRoot(node)
      if (candidate) root = candidate
    }
    try {
      return MessageParser.parseForTranslation(root)
    } catch (e) {
      // 解析器自己出错时宁可"不翻译"，也绝不退回 innerText ——
      // 那正是 UI 文本混进翻译的老毛病。渲染/上报仍走原来那条路。
      return { platform: '', messageText: '', urls: [], sourceText: '', translatable: false, failed: true }
    }
  }

  // 调用来源。手动模式只放行 manual_click，auto_receive 一律在客户端跳过。
  // 发送翻译是**用户按了发送**才发生的，所以必须与「点了译按钮」区分开 ——
  // 否则事后审计分不清"这条是用户主动发的"和"这条只是点了下译"。
  const TRIGGER_MANUAL = 'manual_click'
  const TRIGGER_AUTO = 'auto_receive'
  const TRIGGER_SEND = 'manual_send'

  /**
   * 完整走一遍「纯净正文 → 翻译 → URL 回填」。
   *
   * translatable === false 时直接返回空串：纯 URL 消息、纯图片消息、
   * 系统提示都不该调翻译接口，调用方拿到空串就不会画译文框。
   */
  async function translateParsed(parsed, incoming, trigger) {
    if (!parsed || !parsed.translatable) return null
    const res = await translateTextDetailed(parsed.sourceText, incoming, trigger)
    if (!res || !res.out) return null
    // 保留引擎元数据：调用方要把它标在译文框上（见 markTransEngine）。
    return {
      out: MessageParser.restoreEmoji(MessageParser.restoreUrls(res.out, parsed.urls), parsed.emojis),
      engine: res.engine || '',
      engineName: res.engineName || '',
      routed: res.routed || null
    }
  }

  /**
   * 展示用原文。只用来判断"译文和原文是否相同"，不参与翻译输入。
   * 解析失败时返回原文兜底，避免把已有译文误判成"和原文一样"而清掉。
   */
  function displayText(parsed, fallback) {
    if (parsed && typeof parsed.messageText === 'string') return parsed.messageText
    return String(fallback || '')
  }

  function messageNodes() {
    return Array.from(document.querySelectorAll(SITE.nodes))
  }

  function isOwn(node) {
    return !!(node.closest('.own') || node.closest('.message-out'))
  }

  /**
   * 当前会话是不是群聊 —— 连同「凭哪条证据判的」一起返回。
   *
   * 这个判定直接决定**计费与体验**：
   *   群里 + 手动 → 只给「译」按钮；私聊 → 自动翻译。
   * 所以判成"群"就等于把私聊的自动翻译**整个关掉**。
   *
   * ## 被修的真机缺陷（0.1.23 → 0.1.24）
   *
   * 0.1.23 的判据第 1、2 条**在真机上从未成立过**，逐条实测记录：
   *
   *  · 第 1 条 `data-id` 含 `@c.us`/`@g.us` —— **假设错误**。
   *    真机 `data-id` 是**纯消息哈希**（如 `3EB0F866490405692F3C`），
   *    真机实测：整个 document 里 `@c.us`/`@g.us` 出现 **0 次**
   *    （真机探针 `_probe-wa-dom2.js` 的实测输出，`jidHitCount=0`；探针已随
   *    调试期结束移除，结论保留在这里作为依据）。
   *    左侧会话列表的行也没有 `data-id`（`sidebarDataId.count=0`）。
   *    → 这一条永远不会命中。
   *  · 第 2 条 header 文案含 `群组/成员` —— 真机是**英文界面**，永不命中。
   *  · 第 3 条 `[data-testid*="group" i], [aria-label*="group" i]` 扫的是**整个
   *    `#main`**，而 `#main` 里还装着**消息**。真机实测：一条 WhatsApp
   *    **群邀请链接**会渲染出链接预览卡片，内含
   *      `button[data-testid="group-invite-link-action"]`（`title="Join group"`）
   *    → 该判据**恒为真** → **只要会话里有一条群邀请链接，私聊就被判成群**，
   *    自动翻译被关掉、只剩手动「译」——用户看到的就是"私聊也要手点"。
   *
   * ## 现在的判据：★消息区一律不参与判定★
   *
   * 会话类型只从**会话头部**（`#main header`）读，且按证据强度排序：
   *
   * 1. `@g.us` / `@c.us`（老构建的硬证据；新构建通常取不到，取到就最强）。
   * 2. 头部文案命中成员/群组词（多语言）。
   * 3. 头部内的群专用标记（`[data-icon="default-group"]`、头部 data-testid /
   *    aria-label / title 里的 group）。
   * 4. **头部副标题的形状**：群聊的副标题是**成员名单**（`You, Alice, Bob` /
   *    `你、张三、李四`，逗号分隔），私聊的副标题是**在线状态**（`online` /
   *    `last seen ...`，无逗号）。这是群/私聊在头部的**结构差异**。
   *
   * ## Telegram（页面里**没有** `#main`，另走一条分支）
   *
   * 上面四条判据全部挂在 `#main` 上，而 `#main` 是 WhatsApp 专有 —— 拿不到就
   * 早返回"私聊"。于是 Telegram 的**群聊**一律被判成私聊，「群聊翻译」开关
   * 在 Telegram 上**完全失效**（`messageAction` 里 `s.group` 恒为 false，那条
   * 唯一的计费闸门永不命中，用户设成「手动」也照样自动翻、照样扣字符）。
   *
   * Telegram 分支的证据（同样**只认结构与头部文案，消息区一律不参与**）：
   *
   * T1. **URL hash 里 peer id 的符号**：Telegram 的群 / 超级群 / 频道 id
   *     **一律为负**（`#-1001234567890`），个人为正（`#123456789`）。这是
   *     结构性硬证据，等价于 WhatsApp 的 `@g.us`，页面文案伪造不了。
   * T2. `.ChatInfo` 里的**成员数文案，且必须同时含数字**
   *     （`1 234 members` / `123 位成员` / `1 234 subscribers`）。要求数字是
   *     为了不再犯"一个叫 Members 的私聊被判成群"的同款错误。公开会话的 URL
   *     是 `#@username`（符号不可知），只能落到这条。
   *
   * 两条都拿不到 → 判"私聊"（与 WhatsApp 分支同一条原则：不拿别的会话猜）。
   *
   * ★两种错的代价不对等★：把群误判成私聊 → 打开群聊自动翻满屏历史 → **扣费 P0**；
   * 把私聊误判成群 → 用户以为"自动翻译坏了"。所以只要头部证据成立就判群，
   * 且 `@g.us` 一旦出现绝不因同时看到 `@c.us` 而改判。
   *
   * ⚠ 证据强度备注：第 1、2、3 条在真机上均**未验证**（探针没抓到真群样本），
   * 第 4 条是按 WhatsApp 头部语义设计的**待验证启发式**。所以 `scan()` 把
   * 每条证据的**形状**都记进 `CHAT_KIND`（只记词长/标点骨架，不记人名），
   * 下次真机跑一次群聊 + 私聊即可确认或推翻 —— 不再靠猜。
   */
  function chatKind() {
    const evidence = {
      platform: '', inMain: false, sawCUs: false, sawGUs: false,
      negativePeer: false,
      headerText: false, headerMarker: false, headerMarkers: 0,
      memberList: false, subtitleShape: '', headerShape: '', source: 'none'
    }

    // 只记"形状"（词长序列 + 标点骨架），不记人名 —— 日志可以留档。
    const shape = function (v) {
      const s = String(v == null ? '' : v).trim()
      if (!s) return ''
      const words = s.split(/\s+/)
      return words.map(function (w) { return w.length }).join('-') +
        '|' + s.replace(/[A-Za-z0-9\u4e00-\u9fa5]/g, '').slice(0, 16)
    }

    // -------------------------------------------------------------------
    // Telegram Web A —— **页面上没有 `#main`**
    // -------------------------------------------------------------------
    // chatKind() 曾经只认 WhatsApp 的 `#main`，拿不到就恒返回"私聊"。于是
    // Telegram 上「群聊翻译」开关**完全失效**：用户把群聊设成「手动」，群消息
    // 照样全自动翻译、照样扣字符（`messageAction` 里 `s.group` 永远是 false，
    // 那条唯一的计费闸门永不命中）。
    //
    // Telegram Web A 的会话类型有两条独立证据，按强度排序：
    //
    //  1. **peer id 的符号**（结构性硬证据，不依赖任何 class 名）。
    //     Telegram 的**群 / 超级群 / 频道 id 一律是负数**，URL hash 形如
    //     `#-1001234567890`；个人 id 是正数 `#123456789`；公开会话是
    //     `#@username`（符号不可知，落到判据 2）。这与 WhatsApp 的 `@g.us`
    //     是同一类证据，且同样**不可能被页面文案伪造**。
    //  2. 会话信息块 `.ChatInfo` 里的成员数文案（`1 234 members` /
    //     `123 位成员` / `1 234 subscribers`）。**必须同时出现数字**才算命中：
    //     否则一个恰好叫 "Members" 的私聊就会被判成群 —— 那是 0.1.23 那次
    //     "左栏筛选标签把私聊判成群" P0 的同类错误。
    //     `.ChatInfo` 是 Telegram 的会话信息块，左侧会话列表**不是**它，
    //     所以不会重蹈覆辙。
    //
    // ★消息区（`.message-list-item` / `.text-content`）一律不参与判定★
    // ★判不出来就从宽判"私聊"★ —— 与 WhatsApp 分支同一条原则：不拿别的
    //   会话去猜，宁可少一次自动翻译，也不能凭空关掉用户的自动翻译。
    const main = document.querySelector('#main')
    if (!main) {
      let hash = ''
      try {
        const loc = (typeof location !== 'undefined' && location) ||
          (document && document.location) || null
        hash = String((loc && loc.hash) || '').replace(/^#\/?/, '').trim()
      } catch (e) {}
      const peerId = /^-\d{4,}$/.test(hash)
        ? 'group'
        : (/^\d{4,}$/.test(hash) ? 'private' : '')
      const info = document.querySelector('.ChatInfo')

      // 既没有 #main、也没有 Telegram 的会话信息块、hash 也不是 peer id
      // → 不是我们能判的平台。维持"私聊"（自动翻译优先）。
      if (!peerId && !info) return { group: false, evidence: evidence }

      evidence.platform = 'telegram'
      if (peerId === 'group') {
        evidence.negativePeer = true
        evidence.source = 'peer:negative'
        return { group: true, evidence: evidence }
      }
      if (peerId === 'private') {
        evidence.source = 'peer:positive'
        return { group: false, evidence: evidence }
      }

      // 用户名形式的会话：只能看会话信息块的成员数文案，且必须有数字。
      const infoText = String(
        (info && (info.innerText || info.textContent)) || ''
      ).slice(0, 300)
      evidence.headerShape = shape(infoText)
      evidence.headerText =
        /(members?|participants?|subscribers?|участник\w*|miembros?|miembro|mitglieder|abonnenten|subscriber|成员|订阅者)/i.test(infoText) &&
        /\d/.test(infoText)
      if (evidence.headerText) {
        evidence.source = 'header-members'
        return { group: true, evidence: evidence }
      }
      return { group: false, evidence: evidence }
    }

    evidence.platform = 'whatsapp'
    evidence.inMain = true

    // 判据 1：data-id 里的 JID。老构建有，新构建 data-id 只剩消息哈希。
    const rows = main.querySelectorAll('[data-id]')
    for (let i = 0; i < rows.length && i < 200; i++) {
      const raw = String(rows[i].getAttribute('data-id') || '')
      if (raw.indexOf('@g.us') >= 0) { evidence.sawGUs = true; break }
      if (raw.indexOf('@c.us') >= 0) evidence.sawCUs = true
    }

    // 判据 2/3/4：**只看会话头部**。消息区（链接预览卡片等）绝不参与。
    const header = main.querySelector('header')
    if (header) {
      const text = String(header.innerText || header.textContent || '').slice(0, 300)
      evidence.headerShape = shape(text)
      evidence.headerText = /(members?|participants?|subscribers?)|位成员|位订阅|成员|群组|群聊|gruppe|mitglieder|miembros|участник/i.test(text)

      const markers = header.querySelectorAll(
        '[data-icon="default-group"], [data-icon="group"], [data-testid*="group" i], [aria-label*="group" i], [title*="group" i]'
      )
      evidence.headerMarkers = markers.length
      evidence.headerMarker = markers.length > 0

      // 判据 4：副标题形状。群=成员名单（逗号分隔，常以"You,"/"你、"开头）；私聊=在线状态。
      const sub = header.querySelector('[data-testid="chat-subtitle"]')
      if (sub) {
        const subText = String(sub.textContent || '').trim()
        evidence.subtitleShape = shape(subText)
        const commas = (subText.match(/[,，、]/g) || []).length
        evidence.memberList =
          /^(you|你)\s*[,，、]/i.test(subText) ||
          commas >= 2 ||
          /(^|[,，、\s])\d+\s*(位)?(members?|participants?|成员|人)/i.test(subText)
      }
    }

    if (evidence.sawGUs) { evidence.source = 'dataid:g.us'; return { group: true, evidence: evidence } }
    if (evidence.sawCUs) { evidence.source = 'dataid:c.us'; return { group: false, evidence: evidence } }
    if (evidence.headerText) { evidence.source = 'header-text'; return { group: true, evidence: evidence } }
    if (evidence.headerMarker) { evidence.source = 'header-marker'; return { group: true, evidence: evidence } }
    if (evidence.memberList) { evidence.source = 'header-member-list'; return { group: true, evidence: evidence } }
    return { group: false, evidence: evidence }
  }

  function isGroupChat() { return chatKind().group }

  /** 一个节点所在的消息行（WhatsApp 是 `[data-id]`）。这是消息的**唯一身份**。 */
  function rowOf(el) {
    return (el && typeof el.closest === 'function') ? el.closest(SITE.row) : null
  }

  /**
   * 从消息行**向下**精确推导"译文该落进去的气泡容器"。
   *
   * ## 为什么必须是"向下"，且必须限定在行内
   *
   * 真机 P0：点「译」后消息显示「已翻译」，但中文译文出现在**整个聊天区域底部**。
   * 根因是老 `hostOf()` 是"**向上**兜底"的：
   *
   *     node.closest('.text-content') || node.closest('div.copyable-text')
   *       || node.closest('[data-testid="msg-container"]') || node
   *
   * 而且它在**两处用不同的入参**调用，解析结果根本不是同一个元素：
   *   · 扫描挂按钮时传的是 `span.selectable-text` → 落到内层 `.text-content`；
   *   · 渲染译文时传的是**消息行**（`[data-id]`），而行自己不在 `.copyable-text`
   *     里面，于是 `closest` 一路向上 → 命中 `[data-testid="msg-container"]`
   *     （在许多构建里它就是**整个消息列表容器**）→ 译文被 append 到聊天底部。
   *   最后一档 `|| node` 更是**无边界兜底**：任何节点都能当宿主。
   *
   * 现在改成"从**消息行**往下找正文 span，取它在行内的块级容器"：
   * 结果**一定是 `[data-id]` 行的后代**，因此**不可能**是 #main / 列表根 /
   * footer / 聊天根节点。找不到就返回 null（调用方必须 fail-closed，不许兜底）。
   */
  function bubbleFromSpan(span, row) {
    if (!span || !row) return null
    let el = span.parentElement
    while (el && el !== row && row.contains(el)) {
      if (String(el.tagName || '').toLowerCase() === 'div') return el
      el = el.parentElement
    }
    // 没有块级容器时，退到**消息行本身** —— 这一档仍然是被点的那条消息，
    // 不属于被禁用的兜底（#main / 列表根 / footer / overlay / last child）。
    // 绝不再向上越过消息行。
    return row.contains(span) ? row : null
  }

  /**
   * 消息行 → 精确气泡宿主。**没有任何兜底**：取不到就返回 null。
   *
   * 这里刻意不再回退到 `.text-content` / `msg-container` / 节点自身 ——
   * 那几档兜底正是"译文跑到聊天底部"的来源，本轮按收口要求**全部禁止**。
   */
  function hostOf(node) {
    const row = rowOf(node)
    if (!row) return null
    // 优先用调用方明确给的那个正文 span（扫描时就是它），保证与点击时一致。
    const span = matchesSite(node, SITE.text)
      ? node
      : row.querySelector(SITE.text)
    return bubbleFromSpan(span, row)
  }

  /** 相对路径：从 `from` 走子节点索引到 `to`。用于跨异步精确重定位。 */
  function indexPath(from, to) {
    const path = []
    let el = to
    while (el && el !== from) {
      const parent = el.parentElement
      if (!parent) return null
      const idx = Array.prototype.indexOf.call(parent.children, el)
      if (idx < 0) return null
      path.unshift(idx)
      el = parent
    }
    return el === from ? path : null
  }

  /** 按路径取节点；任一层对不上就返回 null（绝不猜）。 */
  function nodeAtPath(from, path) {
    if (!from || !path || !path.length) return null
    let el = from
    for (let i = 0; i < path.length; i++) {
      const kids = el && el.children
      if (!kids || !kids[path[i]]) return null
      el = kids[path[i]]
    }
    return el
  }

  // ---------------------------------------------------------------------
  // 客户身份采集
  //
  // 目标：让服务端知道「哪个员工、通过哪个账号、正在跟哪个客户」，
  // 从而做跨账号/跨平台的客户识别与撞单检测。
  //
  // 采集是**尽力而为**：拿不到就跳过，绝不影响翻译主流程。
  // 身份标识来源只有 URL hash 一个可信渠道；拿不到就**不上报**，
  // 宁可漏采集，也不要制造一个错误的客户身份。
  // ---------------------------------------------------------------------

  var lastPeerKey = ''

  function telegramPeer() {
    var hash = String(location.hash || '').replace(/^#\/?/, '').trim()
    // Telegram Web A：纯数字是 peer id（群组带前导 -），@ 开头是用户名
    if (/^-?\d{5,}$/.test(hash)) {
      return { peerKey: hash.replace(/^-/, ''), platformUid: hash, kind: 'peer_id' }
    }
    if (/^@?[A-Za-z0-9_]{4,64}$/.test(hash)) {
      return { peerKey: '@' + hash.replace(/^@/, ''), platformUid: hash, kind: 'username' }
    }
    return null
  }

  /**
   * WhatsApp Web 没有可用的 URL 标识，但消息元素的 data-id 里有更好的东西：
   *
   *   data-id="false_8613800138000@c.us_3EB0ABC123"
   *            ↑      ↑                  ↑
   *          是否本人  chatId            消息 ID
   *
   * chatId 就是**手机号**（个人）或群标识 —— 手机号是跨平台识别最强的线索，
   * 比 Telegram 的 peer id 还有用：同一个人的 WhatsApp 与 Telegram
   * 只要有手机号就能合并成同一个客户。
   *
   * 群聊（@g.us）**不作为客户身份**：群里没有单一"客户"，
   * 把它当客户会把整个群的人混成一个人。
   */
  function whatsappPeer() {
    // **只看 #main（当前会话）**。老实现扫的是整个 document，而左侧会话列表
    // 的行同样带 [data-id]（@c.us）且排在 #main 之前，于是一进群/一切会话，
    // 取到的就是"左侧列表里某个私聊"——既是错误的历史基线身份（见 chatIdentity），
    // 也会把客户线索报到**别的会话**头上。群聊（@g.us）依旧不作为客户身份。
    const scope = conversationScope()
    if (!scope) return null
    var nodes = scope.querySelectorAll('[data-id]')
    for (var i = 0; i < nodes.length && i < 400; i++) {
      var raw = String(nodes[i].getAttribute('data-id') || '')
      if (raw.indexOf('@c.us') < 0 && raw.indexOf('@g.us') < 0) continue
      var parts = raw.split('_')
      if (parts.length < 3) continue
      var chatId = parts[1] || ''
      if (chatId.indexOf('@g.us') >= 0) return null   // 群聊不算客户
      var digits = chatId.split('@')[0]
      if (!/^\d{7,15}$/.test(digits)) return null
      return {
        peerKey: chatId,
        platformUid: chatId,
        // 手机号以 + 开头交给服务端按 E.164 归一 —— WhatsApp 的 chatId
        // 一定含国家码，所以不存在"猜国家码"的歧义
        phone: '+' + digits,
        sourceMsgId: parts.slice(2).join('_'),
        kind: 'phone'
      }
    }
    return null
  }

  function currentPeer() {
    return telegramPeer() || whatsappPeer()
  }

  function chatDisplayName() {
    var el = document.querySelector('.ChatInfo .title, .ChatInfo h3, .peer-title, header .title')
    var text = el ? String(el.innerText || '').trim().split('\n')[0] : ''
    return text.slice(0, 80)
  }

  /**
   * 上报一条线索。body 为空表示"只是打开了会话"——
   * 服务端据此建立跟进关系，这正是撞单检测的触发点。
   */
  function reportClue(body, direction, sentAt) {
    var pix = api()
    if (!pix || !pix.reportCustomer) return
    var peer = currentPeer()
    if (!peer) return
    if (document.hidden) return

    try {
      pix.reportCustomer({
        // platform 与 accountKey **刻意不在这里填**：
        // 主进程会按 webContents 反查到可信的 tab 再补上。
        // 渲染进程在网页上下文里，理论上可被页面脚本影响，
        // 让它自报"我是哪个账号"等于把归属权交给不可信的一侧。
        peerKey: peer.peerKey,
        platformUid: peer.platformUid,
        displayName: chatDisplayName(),
        body: body ? String(body).slice(0, 4000) : '',
        direction: direction || 'in',
        sourceConvId: peer.peerKey,
        // WhatsApp 能从 data-id 里拿到平台原始消息 ID；Telegram 拿不到，
        // 此时靠服务端按「同会话+同时间+同内容」去重兜底
        sourceMsgId: peer.sourceMsgId || '',
        // 手机号是跨平台合并的关键线索，能拿到就一定要带上
        phone: peer.phone || '',
        // 历史消息的发送时间是"过去"，用 now() 会把三个月的旧消息记成刚刚发生。
        // 能从 DOM 解析出来就用真实时间，解析不出才退回 now()。
        sentAt: sentAt || new Date().toISOString()
      })
    } catch (e) {}
    lastPeerKey = peer.peerKey
  }

  /**
   * 尽量从 DOM 里解析出这条消息的真实发送时间。
   *
   * 解析不出来就返回 null，由调用方退回 now()。**刻意不做更复杂的推断** ——
   * 猜错时间比没有时间更糟：消息归档里一条时间错乱记录，会让"什么时候聊的"
   * 这个最基本的判断失真，而且很难事后发现。
   */
  function messageTime(node) {
    // WhatsApp：`data-pre-plain-text="[4:32 PM, 9/25/2026] 名字: "`。
    // 这个属性在真机上挂在 **`.copyable-text` 上，也就是 [data-id] 行的后代**，
    // 所以只用 closest（向上找）会永远找不到 —— 时间戳恒为 null，
    // 于是"滚动补加载出来的历史消息"没有一条能被认出来，自动模式会把它们全翻了（扣费）。
    // 因此三个方向都要找：自身 → 后代 → 祖先。
    var holder = null
    if (node.getAttribute && node.getAttribute('data-pre-plain-text') !== null) holder = node
    if (!holder && node.querySelector) holder = node.querySelector('[data-pre-plain-text]')
    if (!holder && node.closest) holder = node.closest('[data-pre-plain-text]')
    if (holder) {
      var raw = holder.getAttribute('data-pre-plain-text') || ''
      var m = /\[([^\]]+)\]/.exec(raw)
      if (m) {
        // 窄空格（U+202F）是 WhatsApp 用的，Safari/部分环境 Date.parse 不认
        var t = Date.parse(m[1].replace(/[\u202f\u00a0]/g, ' '))
        if (!isNaN(t)) return new Date(t).toISOString()
      }
    }
    // Telegram Web A / K：消息里有 <time datetime="..."> 或带 title 的 .time
    var timeEl = node.querySelector ? node.querySelector('time[datetime]') : null
    if (!timeEl && node.tagName && String(node.tagName).toLowerCase() === 'time') timeEl = node
    if (timeEl) {
      var dt = timeEl.getAttribute('datetime')
      var t2 = dt ? Date.parse(dt) : NaN
      if (!isNaN(t2)) return new Date(t2).toISOString()
      var title = timeEl.getAttribute('title')
      var t3 = title ? Date.parse(title) : NaN
      if (!isNaN(t3)) return new Date(t3).toISOString()
    }
    return null
  }

  /**
   * 消息归档去重。
   *
   * scan() 由 MutationObserver 驱动，页面稍有变化就会重扫全部已渲染的消息 ——
   * 没有去重的话同一条消息会被反复上报。这里用「会话 + 方向 + 正文哈希」做键：
   * Telegram 拿不到稳定的消息 ID，而同一会话里同方向同内容的消息本来就极少，
   * 偶尔把两条一模一样的消息并成一条，也比把一条消息存十遍要好。
   */
  var reportedKeys = Object.create(null)
  var reportedCount = 0
  var REPORTED_CAP = 4000

  function textHash(s) {
    var h = 5381
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return (h >>> 0).toString(36)
  }

  /**
   * 上报一条真实消息正文。
   *
   * 与此前的 `reportIfPeerChanged()` 的区别：那个只上报"我打开了这个会话"
   * （body 为空），服务端据此建 conversations/customers，但**不写 messages**；
   * 服务端的写入条件是 `if (payload.body)`，而 body 恒为空，
   * 于是 messages 表永远是空的 —— 消息归档能力等于没接上。
   */
  function reportMessage(node, direction, text) {
    var peer = currentPeer()
    if (!peer) return
    if (document.hidden) return
    // 发送中占位符是我们自己的状态，不是往来内容，永远不进归档。
    // 安全闸已经保证它发不出去，这里是第二道 —— 归档是对客户的承诺，不能脏。
    text = MessageParser.stripBusy(text)
    if (!text) return
    var key = peer.peerKey + '|' + direction + '|' + textHash(text)
    if (reportedKeys[key]) return
    // 键表满了就整体清空而不是拒绝新消息：宁可让最早那批有机会被重报一次
    // （服务端还有唯一索引兜底），也不要让归档从此停止工作。
    if (reportedCount >= REPORTED_CAP) {
      reportedKeys = Object.create(null)
      reportedCount = 0
    }
    reportedKeys[key] = 1
    reportedCount++
    reportClue(text, direction, messageTime(node))
  }

  /** 会话切换时上报一次 —— 打开新客户就是撞单检测的触发时机 */
  function reportIfPeerChanged() {
    var peer = currentPeer()
    if (!peer) return
    if (peer.peerKey === lastPeerKey) return
    reportClue('', 'in')
  }

  /**
   * 文本是不是**确定无疑**属于某种语言。
   *
   * ## 为什么不用 detectLang()
   *
   * detectLang 是"猜"：它只有几个正则，猜不出来就返回 'en'。
   * 拿它做"要不要翻译"的闸门，等于**把所有认不出的语言当成英语**放行 ——
   * 德语、俄语、阿拉伯语、印地语、印尼语等全都在这里被静默跳过。
   *
   * ## 这里的判据：按书写系统（Unicode script），而不是按语言
   *
   * 只有当目标语言有**专属且唯一的书写系统**时，才能确定地判断：
   *   · 日语 → 平假名/片假名（但不含纯汉字，那是中文）
   *   · 韩语 → 谚文
   *   · 泰语 / 希腊语 / 希伯来语 / 阿拉伯语 / 亚美尼亚语 / 格鲁吉亚语 …
   *
   * 拉丁字母区（en/de/fr/es/pt/it/id/tr/vi…）**一律返回 false**：
   * 它们共用同一套字母，凭字符无法区分，必须交给上游 auto 检测。
   *
   * 返回 false 的代价只是"多翻一次"（上游译文等于原文时消耗也很小），
   * 返回 true 错了的代价是"该翻的没翻"—— 后者用户直接看得见。
   */
  function isDefinitelyLang(text, lang) {
    const s = String(text || '')
    if (!s || !lang) return false
    const target = String(lang).toLowerCase()
    const base = target.split('-')[0]

    // 去掉数字、标点、空白、emoji 后剩下的"实义字符"
    const letters = s.replace(/[\s\d\p{P}\p{S}\p{Emoji_Presentation}]/gu, '')
    if (!letters) return false

    const all = re => {
      const hits = letters.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))
      return !!hits && hits.length === letters.length
    }

    switch (base) {
      // 日语必须有假名。纯汉字那句是中文，不是日语 —— 这正是原来
      // "日语被当成中文、接收方向直接 hide"的原因。
      case 'ja': return /[\u3040-\u30ff]/.test(letters) && /^[\u3040-\u30ff\u30fc\u4e00-\u9fff]*$/.test(letters)
      case 'ko': return all(/[\uac00-\ud7af\u1100-\u11ff]/)
      case 'th': return all(/[\u0e00-\u0e7f]/)
      case 'zh': return all(/[\u4e00-\u9fff]/)
      case 'ru': case 'uk': case 'bg': case 'sr': case 'mk': case 'be':
        return all(/[\u0400-\u04ff]/)
      case 'ar': case 'fa': case 'ur': case 'ps': case 'ckb':
        return all(/[\u0600-\u06ff\u0750-\u077f]/)
      case 'he': return all(/[\u0590-\u05ff]/)
      case 'el': return all(/[\u0370-\u03ff]/)
      case 'hy': return all(/[\u0530-\u058f]/)
      case 'ka': return all(/[\u10a0-\u10ff]/)
      case 'hi': case 'mr': case 'ne': case 'sa': case 'bn': case 'gu': case 'pa':
      case 'or': case 'ta': case 'te': case 'kn': case 'ml': case 'si':
        return all(/[\u0900-\u0dff]/)
      // 拉丁字母区（en/de/fr/es/pt/it/id/tr/vi… 共用同一套字母）：
      // **无法凭字符确定**，一律返回 false → 照常送翻。
      //
      // ## 为什么连英语也不在本地跳过
      //
      // 曾经想用"纯 ASCII = 英语"省一次接口调用，但纯 ASCII 的德语
      // （`Guten Tag, Besprechung um 15 Uhr`）、意大利语、荷兰语、土耳其语
      // 全都不带变音符 —— 这条捷径等于把"所有非拉丁语言"的 bug 换个壳
      // 又引回来。而漏翻是用户直接看得见的错误，多翻一次只是几个字符。
      //
      // 重复发送同一段的成本由 translation-cache 兜住：相同文本第二次
      // 直接命中缓存（translate:run 里 getTransCached 在请求之前）。
      default: return false
    }
  }

  /**
   * 这条消息是不是已经是我的母语 —— 是的话接收方向不翻。
   *
   * ## 原来的实现是 detectLang(text) === langMine，有两个方向的错
   *
   * 1. **日语被判成中文**：`こんにちは、会議は3時です` 里的汉字先命中
   *    `[\u4e00-\u9fff]`，于是 langMine='zh' 时 sameLang=true →
   *    messageAction 返回 'hide' —— 日语消息**连「译」按钮都不给**。
   * 2. **法语/西语/葡语被判成越南语**：`à`/`é`/`ó` 命中了越南语字符集，
   *    本来不是母语却被判成"同语种"（虽然结果恰好也是翻译，但逻辑是错的）。
   *
   * 现在改用 isDefinitelyLang：**只有确定是母语书写系统时才 hide**。
   * 拿不准的一律翻译 —— 接收方向多翻一次只是多花一点字符，
   * 而漏翻是用户完全看不到消息内容。
   */
  function sameLang(text) {
    return isDefinitelyLang(text, prefs.langMine || 'zh')
  }

  function clearExtras(host) {
    host.querySelectorAll(':scope > .pix-trans, :scope > .pix-trans-action-row, .pix-click').forEach(el => el.remove())
  }

  /** 只清译文框，**保留「译」按钮与操作行** —— 没有可画的译文时不该把入口一起删掉。 */
  function clearTransBox(host) {
    host.querySelectorAll(':scope > .pix-trans').forEach(el => el.remove())
  }

  /**
   * 气泡里的**翻译操作行** —— P0-3：所有状态（译 / 翻译中… / 已翻译 / 翻译失败）
   * 都住在这**同一个**容器里，位置固定、互不跳位。
   */
  function actionRowOf(host) {
    return host ? host.querySelector(':scope > .pix-trans-action-row') : null
  }

  /**
   * 取（或建）操作行。它是**正常文档流**里的一个整行块：占满宽度、单独成行，
   * 插在正文之后、metadata（时间/勾）之前，让气泡自然增高 ——
   * 绝不用绝对定位去抢右下角的 metadata 区域。
   */
  function ensureActionRow(host, meta) {
    let row = actionRowOf(host)
    if (row) return row
    row = document.createElement('div')
    row.className = 'pix-trans-action-row'
    // 统一标记：解析 / 采集 / 发送链都会自动跳过我们自己的界面。
    row.setAttribute('data-pix-ui', 'translate-action-row')
    if (meta) host.insertBefore(row, meta)
    else host.appendChild(row)
    return row
  }

  /** 译文框的插入位置：**操作行之后** —— 保证阅读顺序始终是「正文 → 操作行 → 译文」。 */
  function insertTransBox(host, box) {
    const row = actionRowOf(host)
    if (row) {
      if (row.nextSibling) host.insertBefore(box, row.nextSibling)
      else host.appendChild(box)
      return
    }
    const meta = host.querySelector(':scope > .MessageMeta, :scope > .message-time')
    if (meta) host.insertBefore(box, meta)
    else host.appendChild(box)
  }

  /**
   * 这个 DOM 节点是不是一个**真正的消息气泡宿主**。
   *
   * 为什么必须有这一道：译文渲染错位置（append 到聊天区域底部 / 消息气泡之外）
   * 在 Windows 与 Mac 真机都复现过。根因是 `hostOf()` 在结构不匹配时会**层层兜底
   * 到 node 本身**，而调用方拿到任何非空节点都会往里 append。
   * 真机上只要有一层匹配错，译文就跑到会话根节点里去了。
   *
   * 规矩：**认不出宿主就不画**（宁可不显示），绝不往聊天根/底部兜底。
   */
  const HOST_FORBIDDEN_IDS = ['main', 'msg-list', 'app', 'pane-side']
  function isMessageHost(el) {
    if (!el || el.nodeType !== 1) return false
    if (HOST_FORBIDDEN_IDS.indexOf(el.id) >= 0) return false
    const doc = typeof document === 'undefined' ? null : document
    if (doc && el === doc.body) return false
    // 必须在会话区（WhatsApp 的 #main）内 —— 左侧会话列表里的节点不是消息气泡。
    const main = conversationScope()
    if (main && !main.contains(el)) return false
    // 必须挂在某个消息行（[data-id]）上；可以是行**内部**的正文容器，
    // 也可以是行本身（被点的那条消息）。二者之外一律拒绝。
    const row = rowOf(el)
    if (!row) return false
    if (!row.contains(el)) return false
    // 宿主自身不能再包住别的消息行 —— 那是列表容器，不是气泡。
    if (el.querySelector && el.querySelector(SITE.row)) return false
    return true
  }

  // ==== TRANSLATE FAILURE NOTICE BEGIN ====
  /**
   * 翻译失败必须让用户**看见**。
   *
   * 老实现把 `resp.success === false` 当"没有译文"直接吞掉（`.catch` 也返回空串），
   * 于是"子账号字符余额不足"、"套餐不含该通道"这类**用户必须知道**的失败，
   * 在界面上表现成"翻译就是不出来" —— 真机验收时会被误判成"自动翻译失效"，
   * 而真实原因是余额或权限。失败静默是这一整类误判的温床。
   */
  const NOTICE_GAP_MS = 30000
  const NOTICE_MS = 9000
  const NOTICE_TEXT = {
    INSUFFICIENT_CHARS: '当前子账号字符余额不足，请联系主账号分配字符',
    ENGINE_NOT_ALLOWED: '当前套餐未包含所选翻译通道，请在通道列表里换一个',
    ENGINE_NOT_CONFIGURED: '当前账号没有可用的翻译通道，请联系客服',
    ENGINE_RETIRED: '翻译通道已下架，请在通道列表里换一个',
    TRANSLATE_FAILED: '翻译服务暂不可用，请稍后重试',
    // 网络传输层：与"翻译服务坏了"分开说，否则用户会一直以为是我们这边的问题。
    NETWORK_UNREACHABLE: '连不上服务器，请检查网络后重试',
    NETWORK_TIMEOUT: '服务器响应超时，请稍后重试',
    // 连续连不上时的退避窗口（见 src/net/api-net.js）。
    // 必须单独成一句：它**不是**"服务坏了"，而是"刚断过网，马上就好"。
    NETWORK_BACKOFF: '网络刚断开过，正在等待恢复，请稍后重试',
    SERVER_BAD_RESPONSE: '服务器返回异常，请稍后重试'
  }
  const noticeSeenAt = new Map()

  /**
   * 弹一条会自己消失的提示，返回实际展示的文案（被节流/无文案时返回空串）。
   *
   * 节流是必须的：余额为 0 时**每来一条新消息都会失败**，不节流会把界面刷满。
   * 提示挂到 `document.body` 而不是 WhatsApp 自己的容器里 —— 挂进 React 树
   * 会被它下一次渲染抹掉。
   */
  function notifyTranslateIssue(resp) {
    const code = String((resp && resp.code) || '')
    const text = NOTICE_TEXT[code] || String((resp && resp.msg) || '')
    if (!text) return ''
    const now = Date.now()
    const key = code + '|' + text
    if (now - (noticeSeenAt.get(key) || 0) < NOTICE_GAP_MS) return ''
    noticeSeenAt.set(key, now)
    try {
      const doc = typeof document === 'undefined' ? null : document
      if (!doc || !doc.body) return text
      const old = doc.getElementById('pix-translate-notice')
      if (old && old.parentNode) old.remove()
      const box = doc.createElement('div')
      box.id = 'pix-translate-notice'
      // 标记成"我们自己的界面"：任何采集/解析都必须跳过它。
      box.setAttribute('data-pix-ui', 'notice')
      box.textContent = text
      box.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'left:50%', 'top:16px',
        'transform:translateX(-50%)', 'max-width:min(92vw,420px)',
        'padding:10px 14px', 'border-radius:10px', 'box-sizing:border-box',
        'background:rgba(24,24,27,.95)', 'color:#fff', 'font-size:13px',
        'line-height:1.5', 'font-family:inherit', 'text-align:center',
        'box-shadow:0 8px 24px rgba(0,0,0,.28)', 'cursor:pointer'
      ].join(';')
      box.addEventListener('click', function () { if (box.parentNode) box.remove() })
      doc.body.appendChild(box)
      setTimeout(function () { if (box.parentNode) box.remove() }, NOTICE_MS)
    } catch (e) {}
    return text
  }
  // ==== TRANSLATE FAILURE NOTICE END ====

  // ==== SEND BUSY INDICATOR BEGIN ====
  /**
   * 「正在翻译」状态 —— **只能画在我们自己的 overlay 上**。
   *
   * ## 铁律（A）：loading 绝不写进 WhatsApp 输入框
   *
   * 老实现是 `writeComposer(box, raw + '[正在翻译中...]')`：把占位符写进真实输入框。
   * 问题是那个输入框由 React/Lexical 托管，`execCommand` 是在它背后改 DOM ——
   * **写进去了不代表还能清掉**，而且清写失败是**静默的**（`execCommand` 照样返回
   * true，调用方拿不到任何信号）。占位符于是留在编辑器正文里，被原样发出去。
   *
   * 真机 0.1.14 复现到的正是这一条：对方收到
   * 「lol，我认为我们可以相信我们的分析师团队[正在翻译中...]」。
   *
   * 所以 loading 状态改为挂在 `document.body` 下的独立浮层（打 `data-pix-ui`，
   * 采集/解析/拦截一律跳过它）。输入框里**从头到尾只有用户原文**。
   */
  const SEND_BUSY_ID = 'pix-send-busy'
  /**
   * 发送链的**四种状态**（0.1.19 体验修复）。
   *
   * 老实现只有一个「正在翻译…」，而且在翻译一回来就把它收掉 —— 于是
   * **原生输入 + 沉降 + 发送**这一整段（最长可达上限）界面上什么都没有，
   * 用户看到的是"提示没了，但消息还没出去"，会以为卡住或失败而反复按回车。
   *
   * 现在按真实阶段切换文案，并且**只有真的发出去了才显示「已发送」**：
   *   translating → 翻译中（原文还在输入框里，一个字节都没发）
   *   sending     → 译文已确认、正在触发发送
   *   sent        → 发送确认完成（短暂停留后自动消失）
   *   failed      → 不在这里显示，交给可操作的失败提示框（带真实错误码）
   */
  const SEND_STATUS_TEXT = {
    translating: '正在翻译…（翻译期间不会发送任何内容）',
    sending: '正在发送…',
    sent: '已发送'
  }
  const SEND_SENT_LINGER_MS = 800
  let sendStatusHideTimer = 0

  function sendStatusEl() {
    const doc = typeof document === 'undefined' ? null : document
    if (!doc || !doc.body) return null
    return doc.getElementById(SEND_BUSY_ID)
  }

  /**
   * 切换状态提示。`state` 为 null / 未知 → 直接收起。
   */
  function setSendStatus(state) {
    try {
      const text = SEND_STATUS_TEXT[state]
      if (!text) { hideSendBusy(); return }
      const doc = typeof document === 'undefined' ? null : document
      if (!doc || !doc.body) return
      if (sendStatusHideTimer) { clearTimeout(sendStatusHideTimer); sendStatusHideTimer = 0 }
      // 同一时刻只允许有一个"我们现在在干什么"的提示：进新状态时把失败提示收掉。
      hideSendFailureNotice()
      let el = doc.getElementById(SEND_BUSY_ID)
      if (!el) {
        el = doc.createElement('div')
        el.id = SEND_BUSY_ID
        // 和我们的其它 UI 一样打标记：绝不能进采集、解析、发送链。
        el.setAttribute('data-pix-ui', 'send-busy')
        el.setAttribute('data-pix-state', state)
        el.style.cssText = [
          'position:fixed', 'z-index:2147483647', 'left:50%', 'bottom:24px',
          'transform:translateX(-50%)', 'max-width:min(92vw,440px)',
          'padding:10px 14px', 'border-radius:10px', 'box-sizing:border-box',
          'background:rgba(24,24,27,.96)', 'color:#fff', 'font-size:13px',
          'line-height:1.5', 'font-family:inherit', 'text-align:center',
          'box-shadow:0 10px 30px rgba(0,0,0,.34)', 'pointer-events:none'
        ].join(';')
        doc.body.appendChild(el)
      }
      el.setAttribute('data-pix-state', state)
      el.textContent = text
      // 「已发送」只是告知，不该长期占屏。
      if (state === 'sent') {
        sendStatusHideTimer = setTimeout(function () {
          sendStatusHideTimer = 0
          hideSendBusy()
        }, SEND_SENT_LINGER_MS)
      }
    } catch (e) {}
  }

  function showSendBusy() {
    setSendStatus('translating')
  }

  function hideSendBusy() {
    try {
      if (sendStatusHideTimer) { clearTimeout(sendStatusHideTimer); sendStatusHideTimer = 0 }
      const doc = typeof document === 'undefined' ? null : document
      if (!doc) return
      const el = doc.getElementById(SEND_BUSY_ID)
      if (el && el.parentNode) el.parentNode.removeChild(el)
    } catch (e) {}
  }
  // ==== SEND BUSY INDICATOR END ====

  // ==== SEND FAILURE NOTICE BEGIN ====
  /**
   * 「翻译失败，消息尚未发送」—— 可操作提示。
   *
   * ## 为什么必须有按钮
   *
   * 这条提示对应的是"用户按了发送，但一个字节都没发出去"。只给一句文案，
   * 等于让用户自己猜下一步该干什么（再按一次？还是直接发中文？）。所以给两个
   * **必须明确点击**的出口：
   *
   *   重试翻译  再走一遍翻译，成功才发送
   *   发送原文  用户明确表示"我知道没翻译，就要发原文"，才发送
   *
   * 「发送原文」绝不能是静默降级 —— 那正是本次要修的 P0（翻译失败时把中文
   * 原文直接发了出去）。所以它必须是一次显式点击，且点击前后都有占位符复核。
   *
   * 提示自动隐藏（60s）时**只隐藏界面，不改输入框**：原文一直在输入框里，
   * 用户想手动发也随时可以（那时会重新走一遍翻译拦截，行为仍然正确）。
   */
  const SEND_FAIL_ID = 'pix-send-failure'
  const SEND_FAIL_TITLE = '翻译失败，消息尚未发送'
  const SEND_FAIL_HINT = '原文已退回输入框，对方没有收到任何内容。'
  const SEND_FAIL_AUTO_HIDE_MS = 60000

  function hideSendFailureNotice() {
    try {
      const old = document.getElementById(SEND_FAIL_ID)
      if (old && old.parentNode) old.remove()
    } catch (e) {}
  }

  function noticeButton(label, handler) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = label
    // 声明成"我们自己的控件"：采集/解析/发送拦截都必须让开。
    btn.setAttribute('data-pix-ui', 'send-failure-action')
    btn.style.cssText = [
      'appearance:none', 'border:0', 'border-radius:8px', 'padding:7px 14px',
      'font-size:13px', 'font-family:inherit', 'cursor:pointer', 'line-height:1.2'
    ].join(';')
    btn.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      handler()
    })
    return btn
  }

  function showSendFailureNotice(box, raw, masked, override) {
    hideSendFailureNotice()
    const ov = override || {}
    try {
      const doc = typeof document === 'undefined' ? null : document
      if (!doc || !doc.body) return
      const wrap = doc.createElement('div')
      wrap.id = SEND_FAIL_ID
      // 和我们自己的其它 UI 一样打标记：绝不能进采集、解析、发送链。
      wrap.setAttribute('data-pix-ui', 'send-failure')
      // 贴在底部（输入框附近）而不是顶部：顶部已经被"余额不足"那类说明性提示
      // 占用，两个叠在一起会互相盖住。这一条要离"下一步动作"最近。
      wrap.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'left:50%', 'bottom:24px',
        'transform:translateX(-50%)', 'max-width:min(92vw,440px)',
        'padding:12px 14px', 'border-radius:12px', 'box-sizing:border-box',
        'background:rgba(24,24,27,.97)', 'color:#fff', 'font-size:13px',
        'line-height:1.5', 'font-family:inherit',
        'box-shadow:0 10px 30px rgba(0,0,0,.34)'
      ].join(';')

      const title = doc.createElement('div')
      title.textContent = ov.title || SEND_FAIL_TITLE
      title.style.cssText = 'font-weight:600;margin-bottom:4px'

      const hint = doc.createElement('div')
      hint.textContent = ov.hint || SEND_FAIL_HINT
      hint.style.cssText = 'opacity:.72;margin-bottom:10px'

      // ★ 真实错误码必须露出来 ★
      // 用户明确要求：禁止再用统一的"状态异常/重试失败"掩盖真实错误。
      // 没有这一行，真机取证只能看到"失败了"，无法区分余额不足 / 断线 / 拦截。
      let codeEl = null
      if (ov.code) {
        codeEl = doc.createElement('div')
        codeEl.textContent = '错误码：' + String(ov.code)
        codeEl.style.cssText = 'opacity:.6;font-size:12px;margin:-6px 0 10px'
      }

      const acts = doc.createElement('div')
      acts.style.cssText = 'display:flex;gap:8px'

      const retry = noticeButton('重试翻译', function () {
        hideSendFailureNotice()
        // 用户可能在失败后又改了输入框：以**当前内容**为准重新走一遍。
        const now = readComposer(box).trim() || raw
        const again = MessageParser.maskUrls(MessageParser.maskEmoji(now).masked)
        // ★ 重试 = 一次**全新的发送动作** ★
        //   必须换新的 sendActionId、把 phase 归零、清掉上一轮所有残留。
        //   老实现直接复用同一个 sendActionId 和残留的 'translating' phase，
        //   于是重试经常在状态机里被判成"陈旧/异常"，表现成"点重试 → 重试失败"
        //   （真机 P0-1，本轮要修的正是这条链）。
        sendActionId = newSendActionId()
        sendActionPhase = 'idle'
        sendBusy = false
        pendingSend = null
        hideSendBusy()
        // 真机取证：把这次重试的完整上下文一次打全 —— 源文本、动作号、链路。
        trace('RETRY_TRANSLATE_CLICK', {
          chain: 'send',
          sourceChars: now.length,
          maskedChars: String((again && again.masked) || '').length,
          urls: (again && again.urls && again.urls.length) || 0,
          retryTrigger: TRIGGER_SEND
        })
        if (!again.masked || !MessageParser.hasTranslatableText(again.masked)) {
          // 内容已经变得不需要翻译了：不再自动发，交给用户自己按发送。
          trace('RETRY_TRANSLATE_SKIPPED', { chain: 'send', reason: 'not_translatable' })
          showSendFailureNotice(box, raw, masked, {
            title: '无需重试',
            hint: '当前内容已不需要翻译，请直接按发送',
            actions: false
          })
          return
        }
        // ★ 点下去必须**立刻有反馈** ★
        // 老实现点完什么都不显示（deliverSend 内部分支有时连浮层都还没画），
        // 用户看到的就是"重试翻译没有反应"，然后反复点 —— 真机就是这么报的。
        showSendFailureNotice(box, raw, masked, {
          title: '正在重试…',
          hint: '正在重新翻译，请稍候',
          actions: false,
          sticky: true
        })
        // 重试同样走兜底：再抛错也不能把原文放出去，只能回到"未发送 + 提示"。
        try {
          const retryJob = deliverSend(box, now, again)
          if (retryJob && typeof retryJob.then === 'function') {
            retryJob.then(function (ok) {
              if (ok) {
                // 重试成功：把「正在重试…」这块状态条收掉。
                trace('RETRY_TRANSLATE_RESULT', { chain: 'send', ok: true, code: '' })
                hideSendFailureNotice()
                return
              }
              // ★ 失败必须显示**真实原因**，不是一句笼统的「重试失败」★
              const code = (lastSendFail && lastSendFail.code) || 'UNKNOWN'
              trace('RETRY_TRANSLATE_RESULT', { chain: 'send', ok: false, code: code })
              showSendFailureNotice(box, raw, masked, {
                title: '重试失败',
                hint: SEND_FAIL_HINT,
                code: code
              })
            }, function (err) { onInterceptCrash(null, box, err) })
          }
        } catch (err) {
          onInterceptCrash(null, box, err)
        }
      })
      retry.style.cssText += ';background:#22c55e;color:#08130b;font-weight:600'

      const sendRaw = noticeButton('发送原文', function () {
        hideSendFailureNotice()
        // 用户明确点击才允许发未翻译的原文。同样要**原生写回 + 回读校验** ——
        // 真机上"发送原文"把占位符一并发出去过（用户从没同意发占位符）。
        //
        // 关键：先把上一次翻译留下的状态解掉。否则 fireSendUserAuthorized 之外
        // 的任何状态机残留都可能把这一下也当成 STALE_ACTION 拦掉。
        pendingSend = null
        sendBusy = false
        hideSendBusy()
        // 写入同样走原生输入（不允许再出现第二套写法）。
        nativeSetComposer(box, raw, 'send_raw').then(function (res) {
          if (!res || !res.ok) {
            blockSend('BODY_MISMATCH', box, raw, masked)
            return
          }
          return wait(50).then(function () {
            const fired = fireSendUserAuthorized(box, raw, 'send_raw')
            if (!fired.ok) blockSend(fired.reason, box, raw, masked)
          })
        }, function () {
          blockSend('BODY_MISMATCH', box, raw, masked)
        })
      })
      sendRaw.style.cssText += ';background:rgba(255,255,255,.14);color:#fff'

      acts.appendChild(retry)
      acts.appendChild(sendRaw)
      wrap.appendChild(title)
      wrap.appendChild(hint)
      if (codeEl) wrap.appendChild(codeEl)
      // `actions:false` = 只报状态的瞬态提示（如「正在重试…」），不给按钮。
      // 给了按钮反而会让人以为可以再点一次。
      if (ov.actions !== false) wrap.appendChild(acts)
      doc.body.appendChild(wrap)
      // `sticky:true` = 由调用方自己收口，不自动消失（重试进行中不能被定时器撤掉）。
      if (!ov.sticky) setTimeout(hideSendFailureNotice, SEND_FAIL_AUTO_HIDE_MS)
    } catch (e) {}
  }
  // ==== SEND FAILURE NOTICE END ====

  /**
   * 翻译请求的**带结果**版本 —— 错误码原样返回，不吞。
   *
   * `translateText()` 把失败统一压成空串，调用方只看到"没拿到译文"，无法区分
   * 余额不足 / 通道不在套餐 / 断线 / 空结果。发送链路只需要"有没有译文"，
   * 但手动点译必须把**真实错误码**回报到 trace 与界面（用户明确要求不许吞错）。
   */
  function translateTextDetailed(text, incoming, trigger) {
    // 先摘占位符再送：占位符是"我们自己的状态"，不是用户内容。
    // 万一它漏到这一步（写回失败 / 扫描竞态），绝不能进翻译接口。
    //
    // ★ emoji 不在这里剥 ★
    // 老实现顺手 stripEmoji 了，于是接收方向的翻译也丢表情。
    // 现在表情由 maskEmoji 换成 {{en}} 占位符，送进接口的是占位符而不是
    // 表情本身 —— 模型看不到它，也就改不动它。占位符是 ASCII，
    // 不影响 ESTIMATE/字符计费口径。
    const cleaned = MessageParser.maskEmoji(MessageParser.stripBusy(text)).masked
    if (!cleaned) return Promise.resolve({ ok: false, code: 'EMPTY_TEXT', out: '' })
    const key = (incoming ? 'in:' : 'out:') + cleaned
    if (cache.has(key)) return Promise.resolve({ ok: true, out: cache.get(key), code: '', cached: true })
    if (pending.has(key)) return pending.get(key)
    const pix = api()
    if (!pix || !pix.translate) return Promise.resolve({ ok: false, code: 'NO_BRIDGE', out: '' })
    const job = withTranslateTimeout(key, pix.translate({ text: cleaned, incoming: incoming, trigger: trigger || '' }).then(resp => {
      pending.delete(key)
      // 余额不足 / 通道不在套餐里之类：必须弹提示，不能表现成"没译文"。
      if (resp && resp.success === false) {
        notifyTranslateIssue(resp)
        return { ok: false, code: String((resp && resp.code) || 'TRANSLATE_FAILED'), out: '' }
      }
      const out = String((resp && (resp.translation || resp.text)) || '').trim()
      if (out) cache.set(key, out)
      // requestId 原样透传：真机取证要求能看到"这次重试用的是哪个幂等号"。
      // engine / routed 同理：服务端可能把短句分派到快速通道，
      // 每个调用方都要能拿到真实通道并标在译文上（见 markTransEngine）。
      return {
        ok: !!out,
        code: out ? '' : 'EMPTY_RESULT',
        out: out,
        requestId: (resp && resp.requestId) || '',
        engine: (resp && resp.engine) || '',
        engineName: (resp && resp.engineName) || '',
        routed: (resp && resp.routed) || null
      }
    }).catch(err => {
      pending.delete(key)
      // 走到这里说明 IPC / 线路层面就断了（服务端错误已在上面 return）。
      // 同样不能静默；也**不能丢掉错误类别** —— 否则界面又会把"连不上服务器"
      // 说成"翻译失败"，正是本次要修的那类误导。
      const cls = String((err && err.pix && err.pix.code) || '')
      const code = ['NETWORK_UNREACHABLE', 'NETWORK_TIMEOUT', 'NETWORK_BACKOFF', 'SERVER_BAD_RESPONSE'].indexOf(cls) >= 0
        ? cls : 'TRANSLATE_FAILED'
      notifyTranslateIssue({ code: code, msg: (err && err.message) || '' })
      return { ok: false, code: code, out: '' }
    }))
    pending.set(key, job)
    return job
  }

  /**
   * 给一次翻译挂看门狗。
   *
   * ## 为什么必须有
   *
   * `pix.translate` 是 `ipcRenderer.invoke`，它只在主进程**返回**时 resolve。
   * 只要主进程那一次 handler 因为任何原因不返回（宿主进程被拖死、
   * requestTranslate 里某个 await 挂住、tab 已被销毁但 handler 没走完），
   * 这个 Promise 就永远挂着。后果不是"慢了"，而是**永久**：
   *
   *   1. `pending` 里那条 job 再也不会 delete —— 同一个句子之后再翻，
   *      直接复用这个永不完成的 Promise，连重试都卡死；
   *   2. 发送链路里 `sendBusy` 永远是 true —— `guardBusySend()` 会拦下
   *      之后**每一次**发送，用户按回车毫无反应，也没有任何错误提示。
   *
   * 所以超时后必须做两件事：把 key 从 pending 里摘掉，并返回一个
   * 明确带错误码的失败结果，让上层走到"翻译失败 → 重试/发原文"的可操作分支。
   *
   * 超时值给得很宽（默认 90s）：网络层自己有 connect/backoff 预算，
   * 长句 LLM 生成也慢，这里只是兜"永不返回"这一种病，不是用来催正常请求。
   */
  const TRANSLATE_TIMEOUT_MS = 90 * 1000
  function withTranslateTimeout(key, promise) {
    return new Promise(function (resolve) {
      let settled = false
      const timer = setTimeout(function () {
        if (settled) return
        settled = true
        // 关键：摘掉 pending，否则"重试"会复用这条死 job。
        // 这里不判断 map 里是不是同一个对象 —— 同 key 同 job 是设计约束，
        // 判断反而会在 set() 之前/之后引入边界分歧。
        pending.delete(key)
        trace('TRANSLATE_TIMEOUT', { ms: TRANSLATE_TIMEOUT_MS })
        resolve({ ok: false, code: 'CLIENT_TIMEOUT', out: '' })
      }, TRANSLATE_TIMEOUT_MS)
      Promise.resolve(promise).then(function (value) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }, function (err) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, code: 'CLIENT_EXCEPTION', out: '', err: (err && err.message) || '' })
      })
    })
  }

  async function translateText(text, incoming, trigger) {
    const res = await translateTextDetailed(text, incoming, trigger)
    return (res && res.out) || ''
  }

  /**
   * 把译文画进消息宿主。**返回是否真的画出了译文**。
   *
   * 返回值是必须的：调用方要据此决定「译」按钮是变成「已翻译」还是「翻译失败」。
   * 老实现无返回值，且**先无条件删掉「译」按钮**再判断画不画 ——
   * 于是"译文和原文一样 / 结果是图标噪音"这类情况会让用户看到
   * 「点一下，按钮没了，什么也没发生」，与 0.1.14 报的 A1 症状完全一致。
   */
  /**
   * 在译文框上标注"这句是谁翻的"。
   *
   * ## 为什么必须标
   *
   * 服务端开了混合路由后，短句会走专用翻译 API（快），长句仍走 LLM（质量好）。
   * 用户选的是 LLM 通道，界面显示的也是它 —— 如果译文不标注真实来源，
   * 就成了 resolveEngineId 头部点名禁止的"静默切换供应商"。
   *
   * 所以：**只要路由发生了，就一定要留下可追溯的痕迹**。
   *
   * 用 data-* 而不是改 textContent —— 后者会触发 MutationObserver 自激
   * （见 paint() 里那段说明）。悬停提示由 CSS 的 ::after 读取这个属性渲染。
   *
   * @param {Element} box   .pix-trans 节点
   * @param {object}  meta  { routed?: {from,to,reason}, engine?, model? }
   */
  function markTransEngine(box, meta) {
    if (!box) return
    const m = meta || {}
    const routed = m.routed && m.routed.to ? m.routed : null
    // 没有路由信息（老服务端 / 路由没发生）：不写这些属性，
    // 免得给每条译文都挂一个空标记。
    if (!routed && !m.engine) {
      try { box.removeAttribute('data-pix-engine'); box.removeAttribute('data-pix-routed') } catch (e) {}
      return
    }
    try {
      if (m.engine) box.setAttribute('data-pix-engine', String(m.engine).slice(0, 32))
      if (routed) {
        box.setAttribute('data-pix-routed', String(routed.to || '').slice(0, 32))
        // 悬停能看到从哪条切到哪条 —— 出问题时用户能直接报给我们
        box.setAttribute('title', '此句由「' + String(routed.to || '')
          + '」快速通道翻译（你选择的是「' + String(routed.from || '') + '」）')
      } else {
        box.removeAttribute('data-pix-routed')
        box.removeAttribute('title')
      }
    } catch (e) {}
  }

  function paint(host, translated, original, meta) {
    if (!isMessageHost(host)) return false
    const before = String(original == null ? '' : original)
    // 译文和原文一致就不画：多一个和原文一模一样的框只会让人以为翻译坏了。
    // 另外译文本身是 UI 噪音（图标类名之类）时也一律不画。
    if (!translated || MessageParser.isIconNoise(translated) ||
      translated.replace(/\s+/g, '') === before.replace(/\s+/g, '')) {
      clearTransBox(host)      // 只清译文框，**保留按钮**
      return false
    }
    let box = host.querySelector(':scope > .pix-trans')
    if (box && box.textContent === translated) {
      // ★ 内容没变就**不写 DOM** ★
      //
      // 这不是省一次赋值那么简单：`textContent = ...` 会产生一次 childList 变更，
      // 而我们的扫描正是挂在 MutationObserver 上的 ——
      //   paint → 变更 → schedule → scan → 再次 paint → 变更 → …
      // 变成一台自激机器。真机日志里同一行消息的 TRANSLATION_RENDER_VERIFIED
      // 在一秒内出现 33 次、一条消息累计 45 次，就是这台机器在空转
      // （0.1.24 实测；白烧 CPU，还逼着 WhatsApp 的 React 反复处理变更）。
      //
      // 0.1.25 把「群聊=自动」扩到会话里全部消息之后，这个循环会被放大到
      // 整个会话，所以必须在这里掐断：**没变就是没事发生**。
      //
      // 但通道标记仍然要补：内容可能相同而路由结果不同（比如服务端开了混合路由）。
      // 只改 data-* 属性不进 textContent，不会触发上面那台自激机器。
      markTransEngine(box, meta)
      return true
    }
    if (!box) {
      box = document.createElement('div')
      box.className = 'pix-trans'
      insertTransBox(host, box)
    }
    box.textContent = translated
    markTransEngine(box, meta)
    // ★ 硬校验：译文节点必须**真的**挂在宿主下，且宿主仍在原消息行内 ★
    // 只看"函数有没有报错"是不够的 —— 真机上出现过"状态已翻译、节点却在聊天
    // 底部"。这里用 parentElement + 行归属双重确认，过不了就不许显示"已翻译"。
    const row = rowOf(host)
    const placed = box.parentElement === host && !!row && row.contains(box)
    if (!placed) {
      try { box.remove() } catch (e) {}
      trace('TRANSLATION_RENDER_UNVERIFIED', {
        chain: 'receive',
        parentIsHost: box.parentElement === host,
        rowFound: !!row
      })
      return false
    }
    trace('TRANSLATION_RENDER_VERIFIED', {
      chain: 'receive',
      rowId: String((row.getAttribute('data-id') || '')).slice(0, 64),
      hostTag: String(host.tagName || '').toLowerCase(),
      hostClass: String(host.className || '').slice(0, 80),
      parentTag: String((box.parentElement && box.parentElement.tagName) || '').toLowerCase()
    })
    // ★ 成功后**不移除**「译」按钮 ★
    //   P0-3 要求所有状态都住在同一个操作行里：正文 → [已翻译] → 译文。
    //   入口本身保留在行内、仅把文案切成「已翻译」（由 setChipState('done') 负责），
    //   这样状态位置永远一致，不会"点一下按钮就消失、看不出发生了什么"。
    return true
  }

  // ==== MANUAL CHIP BEGIN ====
  /**
   * 「译」按钮（手动翻译）—— 事件委托 + 稳定 key 重定位。
   *
   * ## 老实现的两个致命毛病
   *
   * 1. **逐 chip 绑 `onclick`**，并在扫描时把 `host` / `root` 两个**裸 DOM 引用**
   *    闭包捕获，跨越 `await` 再用。真机 WhatsApp 是 React 托管，列表重绘会把这些
   *    节点换掉 —— 拿一个已 detach 的节点去解析，只会得到空正文，然后**静默 return**：
   *    按钮没了、译文没有、什么提示都没有（真机表现就是"点了没反应"）。
   *
   * 2. **全程没有一行 trace**，失败也分不清是"点击没触发 / 正文为空 / 请求失败 /
   *    渲染丢了"。
   *
   * 现在：委托到 document 捕获阶段（重绘也丢不掉），点击时用 `data-id` 重新查
   * 当前气泡，翻译完成后再查一次再渲染。
   */
  function keyOf(root) {
    if (!root || !root.getAttribute) return null
    const id = root.getAttribute(SITE.keyAttr)
    if (id) return { attr: SITE.keyAttr, value: id }
    const pre = root.getAttribute('data-pre-plain-text')
    if (pre) return { attr: 'data-pre-plain-text', value: pre }
    return null
  }

  /**
   * 按稳定 key 重新查当前气泡 —— 绝不长期持有裸 DOM 引用。
   *
   * **只在 `#main`（当前会话）里查**：左侧会话列表里的行同样带 `[data-id]`，
   * 全文档查有命中的风险 —— 那会把译文绑到别的会话的消息上。
   */
  function findRowByKey(key) {
    if (!key || !key.attr || !key.value) return null
    const doc = typeof document === 'undefined' ? null : document
    if (!doc) return null
    const scope = conversationScope() || doc
    let nodes
    try { nodes = scope.querySelectorAll('[' + key.attr + ']') } catch (e) { return null }
    let fallback = null
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute(key.attr) !== key.value) continue
      // 优先返回**带正文 span 的那一行**（真正的消息气泡）。
      if (nodes[i].querySelector && nodes[i].querySelector(SITE.text)) return nodes[i]
      if (!fallback) fallback = nodes[i]
    }
    return fallback
  }

  function chipKey(chip) {
    let path = null
    try {
      const raw = chip.getAttribute('data-pix-path')
      if (raw) path = JSON.parse(raw)
    } catch (e) { path = null }
    return {
      attr: chip.getAttribute('data-pix-key-attr') || '',
      value: chip.getAttribute('data-pix-key') || '',
      path: (Array.isArray(path) && path.length) ? path : null
    }
  }

  /**
   * 失败态 chip 的文案：必须让用户看出**是哪一类问题**。
   *
   * 被修的缺陷（0.1.22 真机）：chip 原来写死 `翻译失败 · 点击重试`，于是
   * 底层明明是 `NETWORK_UNREACHABLE`（连不上服务器），用户看到的却是"翻译失败"，
   * 会一直以为是我们翻译坏了 —— 正是 0.1.20 报告里批评过的那类误导。
   * 只映射到"用户能据此行动"的短句；认不出的码一律退回默认文案。
   */
  const CHIP_FAIL_TEXT = {
    NETWORK_UNREACHABLE: '连不上服务器 · 点击重试',
    NETWORK_TIMEOUT: '服务器超时 · 点击重试',
    NETWORK_BACKOFF: '网络恢复中 · 点击重试',
    SERVER_BAD_RESPONSE: '服务器异常 · 点击重试',
    INSUFFICIENT_CHARS: '余额不足 · 点击重试',
    ENGINE_NOT_ALLOWED: '通道不可用 · 点击重试',
    ENGINE_NOT_CONFIGURED: '通道不可用 · 点击重试',
    ENGINE_RETIRED: '通道已下架 · 点击重试',
    NO_BRIDGE: '翻译桥未就绪 · 点击重试',
    MANUAL_ROW_LOST: '消息已滚动 · 点击重试',
    MANUAL_RENDER_MISSED: '译文未能显示 · 点击重试'
  }
  const CHIP_FAIL_DEFAULT = '翻译失败 · 点击重试'

  function chipFailText(code) {
    return CHIP_FAIL_TEXT[String(code || '').toUpperCase()] || CHIP_FAIL_DEFAULT
  }

  /** 把 chip 的可见状态改掉 —— 成功/失败都必须看得出来，绝不允许"什么都没发生"。 */
  function chipStateOf(chip) {
    return (chip && chip.getAttribute('data-pix-state')) || 'idle'
  }

  function setChipState(chip, state, code) {
    if (!chip) return
    if (state === 'busy') {
      chip.textContent = '翻译中…'
      // busy 期间不可再点：防"看到没反应就连点"造成的重复请求 / 重复扣费。
      chip.style.pointerEvents = 'none'
    } else if (state === 'done') {
      // 已经拿到译文：保留按钮（不删除），再点**不产生新请求、不再扣费**。
      chip.textContent = '已翻译'
      chip.style.pointerEvents = 'none'
    } else if (state === 'fail') {
      chip.textContent = chipFailText(code)
      // 真实错误码钉在 chip 上：事后取证、以及"重试前先看清上次为什么失败"都用它。
      chip.setAttribute('data-pix-fail-code', String(code || ''))
      chip.style.pointerEvents = 'auto'
    } else {
      chip.textContent = '译'
      chip.removeAttribute('data-pix-fail-code')
      chip.style.pointerEvents = 'auto'
    }
    chip.setAttribute('data-pix-state', state || 'idle')
  }

  /** 在（可能已经换过的）当前气泡里找到我们的 chip。 */
  function chipIn(key, fallback) {
    const row = findRowByKey(key)
    if (row) {
      const host = hostOf(row)
      // P0-3：chip 现在住在 `.pix-trans-action-row` 里，不再是宿主的直接子节点。
      const found = host && host.querySelector('.pix-click')
      if (found) return found
    }
    return fallback
  }

  async function runManualTranslate(chip) {
    const key = chipKey(chip)
    const incoming = chip.getAttribute('data-pix-incoming') === '1'
    // ★ 重复点击闸（#6）★ 必须在任何 await 之前，且只认 chip 自己的状态：
    //   - busy  → 上一次请求还在飞，直接忽略（不再发请求、不再扣费）
    //   - done  → 已经有译文了，直接忽略（用户想重译必须用显式的「重新翻译」）
    //   老实现没有这一闸，用户看到"翻译中…"不消失就会连点，于是同一条消息
    //   可能并发多个请求 —— 重复扣费的风险就出在这里。
    const st = chipStateOf(chip)
    if (st === 'busy' || st === 'done') {
      trace('MANUAL_CLICK_IGNORED', { state: st, messageId: key.value || '-' })
      return
    }
    // 一次点击 = 一个 actionId，后面每一步 trace 都带它。
    sendActionId = newSendActionId()
    // ★ 收口保证（#5）★ 从这里开始无论怎么退出（成功/失败/抛错/目标丢失），
    //   都必须把 chip 从 busy 里带出来。老实现整段是 async 却在调用处用
    //   try/catch 包着 —— async 抛错不会同步抛出，于是任何 await 之后的异常
    //   都变成 unhandled rejection，chip 永远停在「翻译中…」（真机就是这么卡住的）。
    let leftBusy = false
    // code 一路带到 chip：失败时要用真实错误类别说话，不用笼统的"翻译失败"。
    const leaveBusy = (next, code) => { leftBusy = true; setChipState(chipIn(key, chip), next, code) }
    try {
      return await manualTranslateInner(chip, key, incoming, leaveBusy)
    } catch (err) {
      // 任何一步抛错都不许静默：留痕 + 可见失败 + 可重试。
      trace('MANUAL_CLIENT_EXCEPTION', { error: (err && err.message) || String(err) })
      leaveBusy('fail', 'CLIENT_EXCEPTION')
      notifyTranslateIssue({ code: 'MANUAL_FAILED', msg: '翻译请求异常，请重试' })
      return
    } finally {
      // 兜底：内部若因为任何原因没显式收口，这里强制离开 busy。
      // 「永久停在翻译中…」是本轮明令禁止的状态。
      if (!leftBusy && chipStateOf(chipIn(key, chip)) === 'busy') {
        trace('MANUAL_CHAIN_FORCED_RESOLVE', { messageId: key.value || '-' })
        setChipState(chipIn(key, chip), 'fail', 'CHAIN_NOT_RESOLVED')
      }
    }
  }

  async function manualTranslateInner(chip, key, incoming, leaveBusy) {
    let row = findRowByKey(key)
    trace('MANUAL_TRANSLATE_CLICK', {
      action: 'manual_click',
      messageId: String(key.value || '-').slice(0, 64),
      keyAttr: key.attr || '-',
      byPath: key.path ? key.path.join('.') : '-',
      tabId: prefs.tabId || '-',
      partition: prefs.partition || '-',
      engine: prefs.engine || '-',
      incoming: incoming,
      rowFound: !!row,
      // 取证：点击时这条消息在真实 DOM 里的身份 —— 后面渲染失败时用它对齐。
      rowTag: row ? String(row.tagName || '').toLowerCase() : '-',
      rowHasDataId: row ? row.hasAttribute('data-id') : false
    })

    // ---- 第一步：定位气泡 ----
    if (!row) {
      trace('MANUAL_ROW_LOST', { messageId: key.value || '-' })
      leaveBusy('fail', 'MANUAL_ROW_LOST')
      notifyTranslateIssue({ code: 'MANUAL_ROW_LOST', msg: '这条消息已不在当前视图，请滚到它再点一次' })
      return
    }

    // ---- 第二步：提取正文 ----
    const parsed = parseScope(null, row)
    const sourceText = String((parsed && parsed.sourceText) || '')
    trace('SOURCE_EXTRACTED', {
      chain: 'receive',
      messageId: key.value || '-',
      sourceTextLen: sourceText.length,
      translatable: !!(parsed && parsed.translatable)
    })
    if (!sourceText || !parsed.translatable) {
      // 静默是禁止的：必须留下 trace + 给用户看得见的反馈。
      trace('MESSAGE_TEXT_EXTRACTION_FAILED', { messageId: key.value || '-', sourceTextLen: sourceText.length })
      leaveBusy('fail', 'MESSAGE_TEXT_EXTRACTION_FAILED')
      notifyTranslateIssue({
        code: 'MESSAGE_TEXT_EXTRACTION_FAILED',
        msg: '这条消息的正文读不出来，未翻译。请刷新页面后重试'
      })
      return
    }

    // ---- 第三步：请求翻译 ----
    setChipState(chip, 'busy')
    trace('TRANSLATE_STARTED', {
      chain: 'receive',
      action: 'manual_click',
      trigger: TRIGGER_MANUAL,
      incoming: incoming,
      sourceTextLen: sourceText.length,
      engine: prefs.engine || '-'
    })
    let res = null
    try {
      res = await translateTextDetailed(sourceText, incoming, TRIGGER_MANUAL)
    } catch (err) {
      res = { ok: false, code: 'CLIENT_EXCEPTION', out: '', err: (err && err.message) || '' }
    }
    if (res && res.ok) {
      trace('TRANSLATE_SUCCEEDED', {
        chain: 'receive',
        chars: String(res.out || '').length,
        cached: !!res.cached
      })
    } else {
      trace('TRANSLATE_FAILED', {
        chain: 'receive',
        code: (res && res.code) || 'UNKNOWN',
        error: (res && res.err) || ''
      })
    }

    // ---- 失败：必须留在界面上（不许恢复成"什么都没发生"） ----
    if (!res || !res.ok || !res.out) {
      // ★把真实错误码传给 chip★：连不上服务器 / 余额不足 / 通道不可用 …
      //  各说各的，用户才知道下一步该做什么。
      leaveBusy('fail', (res && res.code) || 'UNKNOWN')
      return
    }

    // ---- 第四步：用稳定身份重新定位再渲染 ----
    // 身份 = data-id（哪一行）+ path（行内哪一段正文）。两者都必须在**重新
    // 查询的当前 DOM** 上验证通过，才允许绘制；任何一步对不上就 fail-closed。
    const translated = MessageParser.restoreEmoji(MessageParser.restoreUrls(res.out, parsed.urls), parsed.emojis)
    const curRow = findRowByKey(key)
    if (!curRow) {
      trace('TRANSLATION_RENDER_TARGET_MISSING', { messageId: key.value || '-', reason: 'row_not_found' })
      leaveBusy('fail', 'MANUAL_RENDER_MISSED')
      notifyTranslateIssue({ code: 'MANUAL_RENDER_MISSED', msg: '译文已生成，但这条消息已滚出视图，滚回去即可看到' })
      return
    }
    // 精确回到当初点的那一段正文；没有 path（老 chip）则退回"行内第一个正文 span"。
    let span = key.path ? nodeAtPath(curRow, key.path) : curRow.querySelector(SITE.text)
    // ★ 硬校验：路径命中的节点必须**仍是真正的正文节点** ★
    //   索引路径在列表重绘 / 我们插入了自己的控件之后会漂移，最坏情况会命中
    //   chip / 译文框自身（测试已复现）。真机上的等价事故就是"译文绑错了节点"。
    //   所以这里把"查询返回的到底是不是原始消息气泡"变成一条可判定的断言：
    //   · 必须是 .selectable-text 正文；
    //   · 不能落在我们自己的界面里（data-pix-ui）；
    //   · 必须仍在这一条消息行内。
    const looksLikeText = span && matchesSite(span, SITE.text) &&
      !(span.closest && span.closest('[data-pix-ui]'))
    const textMatches = looksLikeText && normalizeBody(span.textContent) === normalizeBody(sourceText)
    if (!looksLikeText) span = null
    const host = span ? bubbleFromSpan(span, curRow) : null
    // ★ 硬约束（#4）★ 找不到精确气泡就**绝不绘制**。
    //   用户明确要求：所有兜底（#main / 会话根 / 列表根 / footer / last child /
    //   全局 overlay）一律禁止；找不到就 TRANSLATION_RENDER_TARGET_MISSING，
    //   并把这条消息标成翻译失败。宁可不显示，也不能放到页面底部。
    if (!host || !isMessageHost(host) || rowOf(host) !== curRow) {
      trace('TRANSLATION_RENDER_TARGET_MISSING', {
        chain: 'receive',
        messageId: String(key.value || '').slice(0, 64),
        reason: !span ? 'span_not_found_or_not_text' : (!host ? 'bubble_not_found' : 'host_not_in_row'),
        hadPath: !!key.path,
        looksLikeText: !!looksLikeText,
        textMatches: !!textMatches,
        rowHasDataId: curRow.hasAttribute(SITE.keyAttr)
      })
      leaveBusy('fail', 'MANUAL_RENDER_MISSED')
      notifyTranslateIssue({ code: 'MANUAL_RENDER_MISSED', msg: '没能把译文绑回这条消息，已放弃显示（不会放到别处）' })
      return
    }
    // 取证三连：真实 data-id / 用到的选择器 / 命中的节点身份。
    trace('TARGET_RELOCATED', {
      chain: 'receive',
      messageId: String(key.value || '').slice(0, 64),
      byKey: key.attr || '-',
      byPath: key.path ? key.path.join('.') : '-',
      rowId: String((curRow.getAttribute(SITE.keyAttr) || '')).slice(0, 64),
      rowIsSameNode: true,
      textMatches: !!textMatches,
      hostTag: String(host.tagName || '').toLowerCase(),
      hostClass: String(host.className || '').slice(0, 80),
      hostParentTag: String((host.parentElement && host.parentElement.tagName) || '').toLowerCase()
    })
    const drew = paint(host, translated, displayText(parsed, ''), {
      engine: res.engine,
      routed: res.routed
    })
    trace('TRANSLATION_RENDERED', {
      chain: 'receive',
      messageId: key.value || '-',
      chars: translated.length,
      drew: drew
    })
    // 只有"确实画进了正确气泡"才算成功；否则如实标失败，绝不显示「已翻译」。
    if (drew) leaveBusy('done')
    else leaveBusy('fail', 'MANUAL_RENDER_MISSED')
  }

  /**
   * 委托处理器：挂在 document 捕获阶段。
   *
   * 捕获阶段是最外层、最先执行的，因此**不依赖** chip 节点本身是否还活着，
   * 也不怕 WhatsApp 在冒泡阶段 stopPropagation（消息区会拦点击）。
   * 这是"逐 chip 绑 listener"在托管 DOM 上最大的一处致命缺点。
   */
  function onChipClick(event) {
    const t = event && event.target
    if (!t || !t.closest) return false
    const chip = t.closest('.pix-click')
    if (!chip) return false
    // 这一下点击是我们的，绝不能让 WhatsApp 当成"选中消息"之类处理。
    event.preventDefault()
    event.stopPropagation()
    if (event.stopImmediatePropagation) event.stopImmediatePropagation()
    try {
      runManualTranslate(chip)
    } catch (err) {
      // 点译流程自己抛错也不能静默 —— 至少要留下痕迹并给出可重试的界面。
      trace('MANUAL_CLIENT_EXCEPTION', { error: (err && err.message) || String(err) })
      setChipState(chip, 'fail', 'CLIENT_EXCEPTION')
      notifyTranslateIssue({ code: 'MANUAL_FAILED', msg: '翻译请求异常，请重试' })
    }
    return true
  }
  // ==== MANUAL CHIP END ====

  function addClick(host, incoming, root, span) {
    if (!isMessageHost(host)) return
    // P0-3：chip 住在操作行里，所以这里按**后代**判断是否已经挂过入口。
    if (host.querySelector('.pix-click') || host.querySelector(':scope > .pix-trans')) return
    const key = keyOf(root)
    const chip = document.createElement('span')
    chip.className = 'pix-click'
    // 声明成"我们自己的控件"：采集/解析/发送拦截都必须让开。
    chip.setAttribute('data-pix-ui', 'translate-chip')
    chip.setAttribute('data-pix-state', 'idle')
    chip.setAttribute('data-pix-incoming', incoming ? '1' : '0')
    if (key) {
      chip.setAttribute('data-pix-key-attr', key.attr)
      chip.setAttribute('data-pix-key', key.value)
    }
    // ★ 记下"正文 span 相对消息行的路径" ★
    // 渲染译文时靠它精确重回同一个节点 —— 这正是用户要求的
    // 「点击时保存稳定身份，返回后重新查询再绑定」。只有 data-id 还不够：
    // 一条消息里可能有多段文本（引用块、正文），必须回到**同一段**。
    if (span) {
      const path = indexPath(root, span)
      if (path && path.length) chip.setAttribute('data-pix-path', JSON.stringify(path))
    }
    chip.textContent = '译'
    // ★ P0-3 ★ 入口放进**固定的操作行**，而不是直接贴在正文尾部或右下角：
    //   整行块 + 左对齐 → 单独成行、位于正文下方，结构上不会与 WhatsApp
    //   右下角的时间/单勾/双勾重叠。
    const meta = host.querySelector(':scope > .MessageMeta, :scope > .message-time')
    const row = ensureActionRow(host, meta)
    row.appendChild(chip)
    trace('MANUAL_CHIP_RENDERED', {
      messageId: (key && key.value) || '-',
      tabId: prefs.tabId || '-',
      incoming: !!incoming,
      hostTag: String(host.tagName || '').toLowerCase(),
      hostClass: String(host.className || '').slice(0, 80),
      hasPath: chip.hasAttribute('data-pix-path'),
      inActionRow: chip.parentElement === row
    })
  }

  function visible(el) {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 8 && rect.height > 8
  }

  function firstMatch(selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const nodes = document.querySelectorAll(selectors[i])
      for (let j = 0; j < nodes.length; j++) {
        if (visible(nodes[j])) return nodes[j]
      }
    }
    return null
  }

  /**
   * 「这个元素能不能输入」。
   *
   * 为什么不只信 `el.isContentEditable`：它是**宿主实现**的派生属性，在
   * 嵌套 contenteditable（`contenteditable="false"` 的子节点）、shadow DOM、
   * 以及非浏览器环境里都可能是 `undefined`。一旦它假阴性，composerEl() 就会
   * 跳过"用户正在打字的框"退回选择器兜底 —— 那正是 0.1.28 图文不翻译的根因。
   * 所以这里**属性优先**，isContentEditable 仅作补充。
   */
  function isEditableEl(el) {
    if (!el || el.nodeType !== 1) return false
    const tag = el.tagName
    if (tag === 'TEXTAREA' || tag === 'INPUT') return true
    const attr = el.getAttribute && el.getAttribute('contenteditable')
    if (attr != null) return String(attr).toLowerCase() !== 'false'
    return el.isContentEditable === true
  }

  function composerEl() {
    // ★ 优先"用户正在打字的那个框"（document.activeElement）。
    //
    // 为什么把它提到最前（0.1.28 修的真机缺陷）：
    // 用户报「图文一起发送的时候，不翻译」—— 附加图片后，WhatsApp 的输入区变成
    // 图片预览面板，footer 里会出现**不止一个** contenteditable（标题框、caption 框…）。
    // 老实现按选择器顺序 `firstMatch` 取"第一个可见的"，会拿到**不是**用户在打字的那个
    // （比如标题框），于是 readComposer 读到空、或 eventInComposer 不匹配 →
    // 整条发送拦截被**静默放行**，中文原文直接出网。
    //
    // activeElement 天然就是"焦点所在、用户正在输入"的元素，对"只有一个输入框"和
    // "附件后有多个输入框"两种形态都正确。放在最前不改变常规行为：
    // 常规情况下 activeElement 就是 footer 里那个唯一的输入框。
    const ae = document.activeElement
    if (ae && isEditableEl(ae) && visible(ae)) {
      if (!ae.closest('header, [role="search"], [data-testid="chat-list-search"]')) return ae
    }
    const found = firstMatch([
      'footer [contenteditable="true"]',
      '#editable-message-text',
      '.input-message-input[contenteditable="true"]',
      '[data-testid="conversation-compose-box-input"]',
      '[data-tab="10"][contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[aria-label*="message" i][contenteditable="true"]',
      'div[aria-placeholder][contenteditable="true"]',
      'form [contenteditable="true"]',
      'textarea[placeholder*="message" i]',
      'textarea[aria-label*="message" i]'
    ])
    if (found) return found
    return null
  }

  function readComposer(el) {
    if (!el) return ''
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return String(el.value || '')
    return String(el.innerText || el.textContent || '')
  }

  /**
   * ★ 0.1.19：`writeComposer()` 已被**永久移除** ★
   *
   * 它就是真机 0.1.18 的根因所在：用 `execCommand('insertText')` / `textContent`
   * 在页面内直接改 DOM。真机日志证据：
   *
   *     expected : len=29 hash=33aaf90e  "Test translation information."
   *     actual   : len=6  hash=3a49c2d5  "测试翻译信息"
   *     writeMethod:"execCommand:insertText"  sawBeforeInput:false  sawInput:true
   *
   * 译文一个字符都没进去 —— `sawBeforeInput:false` 说明 WhatsApp 的编辑器在祖先
   * 捕获阶段拦掉了 `isTrusted:false` 的 `beforeinput`，我们的写入**从未进入**
   * 编辑器的输入管线。改的是 DOM，编辑器 state 没动，下一次调和就把 DOM 盖回去。
   *
   * 现在写入一律走 `nativeSetComposer()` → `replaceComposerWithTranslatedTextNative()`
   * → 主进程 Chromium 原生编辑命令（`selectAll` / `delete` / `insertText`）。
   * 这里只保留一个**取证占位**，把"最近一次写入方式"记为原生，供
   * `SEND_BODY_MISMATCH_DETAIL` / `NATIVE_SET_COMPOSER` 使用。
   */
  function markNativeWrite(el, method) {
    lastWriteInfo = {
      method: method || 'native:selectAll+delete+insertText',
      trusted: true,
      tag: el ? String(el.tagName || '').toLowerCase() : '-',
      editable: el && el.getAttribute ? String(el.getAttribute('contenteditable') || '') : '',
      cls: el ? String(el.className || '').slice(0, 80) : '',
      // 原生输入由浏览器进程发起 → 事件可信，编辑器必须正常处理。
      // guest 侧不（也无法）观测编辑器的 beforeinput，这里显式说明而不是编造 false。
      sawBeforeInput: null,
      sawInput: null
    }
    return lastWriteInfo
  }

  function sendButton() {
    return firstMatch([
      'button[aria-label="Send"]',
      'button[aria-label="发送"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send a message"]',
      'button[data-testid="send"]',
      'button[data-testid="compose-btn-send"]',
      'button.Button.send',
      '.btn-send',
      'span[data-icon="send"]',
      '[data-icon="wds-ic-send-filled"]'
    ])
  }

  function looksLikeSend(target) {
    if (!target || !target.closest) return false
    const icon = target.closest('[data-icon]')
    if (icon && /send/i.test(icon.getAttribute('data-icon') || '')) return true
    const el = target.closest('button, [role="button"], span[data-icon], div[role="button"]')
    if (!el) return false
    const label = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-icon'),
      el.getAttribute('data-testid'),
      el.className
    ].join(' ').toLowerCase()
    if (/(voice|mic|attach|emoji|sticker|gif|record|拍照|语音|表情)/i.test(label)) return false
    return /(^|[\s_-])(send|发送|enviar|envoyer|senden|invia)([\s_-]|$)/i.test(label) ||
      /btn-send|compose-btn-send|wds-ic-send/i.test(label)
  }

  function isSendEnter(event) {
    if (event.key !== 'Enter' && event.code !== 'Enter' && event.keyCode !== 13) return false
    if (event.shiftKey || event.altKey || event.isComposing) return false
    return true
  }

  function eventInComposer(event, box) {
    if (!event || !box) return false
    const t = event.target
    return t === box || box.contains(t)
  }

  /**
   * ★ 0.1.28 ★ 事件发生在哪个输入框里 —— 以**事件自己**为准，而不是只看焦点。
   *
   * 为什么需要它（真机缺陷「图文一起发送的时候，不翻译」）：
   *   附加图片后 footer 里会出现多个 contenteditable。用户很可能是**先在普通输入框
   *   打字、再点附加图片**，此时焦点不一定跟着切到 caption 框 —— 于是
   *   `composerEl()`（取焦点框）返回的是 A，而 Enter 事件发生在 B，
   *   `eventInComposer` 判定失败 → 整条拦截被**静默放行**，中文原文直接出网。
   *
   * 真机上这种情况**不会**有任何报错，消息也发得出去，用户只看到"没翻译"。
   * 所以这里把"事件落在哪个可编辑框"作为**独立且优先**的判据：
   * 事件目标在哪个框里，就拦哪个框 —— 与焦点无关。
   *
   * 排除项（绝不能误抓）：不是可编辑元素、或落在我们自己的界面 / 搜索框里。
   */
  function boxFromEvent(event) {
    if (!event || !event.target) return null
    const t = event.target
    const host = t.closest
      ? t.closest('[contenteditable="true"], textarea, [role="textbox"]')
      : null
    const el = host || (isEditableEl(t) ? t : null)
    if (!el) return null
    if (el.closest && el.closest('header, [role="search"], [data-testid="chat-list-search"]')) return null
    if (el.closest && el.closest('[data-pix-own-ui], #pix-send-failure, #pix-notice')) return null
    return el
  }

  /**
   * 发送事件的目标输入框：**事件优先，焦点兜底**。
   *
   * 只要事件本身发生在某个可编辑框里，就以它为准；这解决了"焦点没跟上、
   * composerEl() 取错框导致静默放行"的整类问题（图文、转发、编辑等）。
   */
  function sendTargetBox(event) {
    const fromEvent = boxFromEvent(event)
    if (fromEvent) {
      const focusBox = composerEl()
      // 事件框与焦点框不一致时，至少让 composerEl() 的"当前框"缓存跟上事件框，
      // 否则后续 readComposer / nativeSetComposer 会对着另一个框操作。
      if (focusBox && focusBox !== fromEvent) {
        trace('COMPOSER_FOCUS_MISMATCH', {
          at: 'send_target',
          eventBoxEditable: String(!!fromEvent.getAttribute('contenteditable'))
        })
      }
      return fromEvent
    }
    const box = composerEl()
    return box
  }

  function fireSend(box) {
    // suppression 只覆盖**我们这一次同步发送**，用完立刻清零。
    //
    // 老实现是 `setTimeout(() => suppression = false, 400)` —— 一个 400ms 的
    // 一刀切时间窗。窗口内**任何**发送事件都被当成"我们自己发的"放行/吞掉，
    // 于是用户在这 400ms 里按的回车会被静默吃掉（连发消息丢内容，真机已复现）。
    //
    // 我们自己的发送是同步的（.click() 与 dispatchEvent 都同步投递），所以
    // 同步窗口足够；用户的下一次输入必然落在更晚的 task 上，永远不会被误吞。
    suppression = true
    try {
      const btn = sendButton()
      if (btn) {
        const clickable = btn.closest('button, [role="button"]') || btn
        clickable.click()
        return
      }
      if (!box) return
      box.focus()
      box.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }))
    } finally {
      suppression = false
    }
  }

  /**
   * 故障注入点：仅用于测试，生产环境不存在该全局变量。
   *
   * 「拦截流程中途抛错也必须拦下发送」这条不变量，靠人工构造真实崩溃很难覆盖
   * （要精准命中 preventDefault 之前的那几行）。留一个显式的注入点，
   * 让测试能证明：**任何**异常都不会把原文放出去。
   */
  function faultPoint() {
    const inject = typeof window !== 'undefined' && window.__helloPixFaultInject
    if (typeof inject === 'function') inject()
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function blockEvent(event) {
    if (!event) return
    event.preventDefault()
    event.stopPropagation()
    if (event.stopImmediatePropagation) event.stopImmediatePropagation()
  }

  /**
   * 同步决策 —— 这一段**必须**在事件回调里同步跑完。
   *
   * 返回 `null`   = 不该拦（纯英文 / 纯表情 / 纯 URL / 空）：让 WhatsApp 正常发送。
   * 返回 `{busy}` = 占位符还在，拦下、什么都不做（等翻译流程自己收尾）。
   * 返回 `{raw, masked}` = **已经 preventDefault**，接下来必须走翻译（异步）。
   *
   * ## 为什么不能写成 async
   *
   * 这是本次修复里最容易踩空的一处：`async function` 里抛出的异常**不会**同步
   * 抛给调用者，而是变成 rejected promise —— `.catch()` 要到**微任务**里才跑。
   * 而 WhatsApp 的原生发送挂在冒泡阶段，早就执行完了。于是表现成：
   * 我们"以为"自己在拦，实际上原文已经出网。
   *
   * 所以「拦下发送」这件事只能依赖同步路径，不能依赖任何异步函数不抛错。
   */
  function decideIntercept(event, box) {
    faultPoint()
    const raw = readComposer(box).replace(/\s+$/g, '')
    const trimmed = raw.trim()
    if (!trimmed) return null
    if (isBusyText(trimmed) || sendBusy) {
      blockEvent(event)
      return { busy: true }
    }
    if (isEmojiOnly(trimmed)) return null
    // ★ emoji 不再剥离，改成占位符保管 ★
    //
    // 老实现是 `stripEmoji(trimmed)`：表情在**送进接口之前**就被删了，
    // 所以译文里当然没有，发出去的整句话里表情就没了 ——
    // 用户看到的是"翻译不错，但吃掉了我的 emoji"。
    //
    // 现在换成 maskEmoji：表情原地换成 {{e1}}，翻译完在 finalText 里
    // 原样换回来。模型根本看不到表情，也就改不动它。
    const emojiMasked = MessageParser.maskEmoji(trimmed)
    const forApi = emojiMasked.masked
    if (!forApi.trim()) return null
    // URL 抽出来单独保管：翻译时用占位符顶替，发出去的时候原样放回 ——
    // 网址一旦被模型改写就点不开了。纯 URL 消息直接原样发送，不调翻译接口。
    const masked = MessageParser.maskUrls(forApi)
    masked.emojis = emojiMasked.emojis
    if (!MessageParser.hasTranslatableText(masked.masked)) return null
    // 目标语言与原文同语种时不必翻译 —— 但**判据必须保守**。
    //
    // 原实现是 `detectLang(text) === sendTo`，而 detectLang 是个只认
    // zh/ja/ko/th/vi 的正则猜词器：德语、俄语、阿拉伯语、印地语、印尼语
    // 等一律返回 'en'。于是 sendTo='en'（默认值）时，**这些语言全被判成
    // "本来就是英语"，直接放行不翻**。这正是"英语正常、其他语种没反应"
    // 的根因。
    //
    // 现在只做一件事：文本**确定无疑是目标语言**时才跳过。
    // 拿不准就交给上游 —— 所有通道都支持 source='auto'，多翻一次顶多
    // 浪费本地一次判断，而漏翻是用户直接看得见的错误。
    if (isDefinitelyLang(masked.masked, prefs.sendTo || 'en')) return null
    // 到这里才真正决定"拦下并翻译"。状态机从这一刻开始，trace 走同一 actionId。
    sendActionId = newSendActionId()
    sendActionPhase = 'captured'
    // 性能计时从这里起表：用户按下发送 = 计时原点。
    perfStart()
    perfMark('start')
    trace('SEND_CAPTURED', { via: (event && event.type) || '-', chars: raw.length })
    blockEvent(event)
    perfMark('blocked')
    trace('NATIVE_SEND_BLOCKED', { defaultPrevented: !!(event && event.defaultPrevented) })
    // 原文**只留在内存里**（raw），输入框保持不动 —— 不写占位符、不改 DOM。
    trace('SOURCE_SNAPSHOTTED', { chars: raw.length })
    return { raw: raw, masked: masked }
  }

  /**
   * `decideIntercept` 的**兜底外壳** —— 拦下发送这件事，不能依赖"翻译流程自己不抛错"。
   *
   * ## 为什么必须有它
   *
   * `decideIntercept` 里的每一步 —— `readComposer`、`isDefinitelyLang`、
   * `MessageParser.maskUrls`、`hasTranslatableText` —— 只要抛一次
   * （页面上出现没见过的 DOM、选区被页面脚本改动、解析器遇到新格式），
   * 这一下 Enter 就会直接落到 WhatsApp 的发送逻辑上，**中文原文出网**，
   * 而且界面上什么都不会发生。
   *
   * 这与 0.1.12 那个 P0 是同一类失败：不是"翻错了"，而是"根本没拦"。
   * 所以这里把整段包起来，规矩只有一条：
   *
   *     抛错 = 翻译失败 = 拦下发送 + 弹可操作提示。绝不静默放行。
   *
   * 两层都要盖住：决策阶段靠 try/catch（同步，唯一的真防线），
   * 投递阶段靠 .catch()（异步，翻译本身出错）。
   */
  function safeIntercept(event, box) {
    let decision = null
    try {
      decision = decideIntercept(event, box)
    } catch (err) {
      onInterceptCrash(event, box, err)
      return
    }
    if (!decision || decision.busy) return
    try {
      const job = deliverSend(box, decision.raw, decision.masked)
      if (job && typeof job.catch === 'function') {
        job.catch(function (err) { onInterceptCrash(event, box, err) })
      }
    } catch (err) {
      onInterceptCrash(event, box, err)
    }
  }

  function onInterceptCrash(event, box, err) {
    // 1) 先把这一下发送摁死。此时 defaultPrevented 大概率为 false。
    try {
      if (event && !event.defaultPrevented) {
        event.preventDefault()
        event.stopPropagation()
        if (event.stopImmediatePropagation) event.stopImmediatePropagation()
      }
    } catch (e) {}
    // 2) 留痕。之前 preload 内的异常只进 webContents 控制台，客户端日志里一片空白，
    //    线上只能靠用户复述"我按了回车然后中文就发出去了"。
    try {
      console.error('[Hello Pix] 发送翻译流程异常，已拦下发送、未发送任何内容：', err)
    } catch (e) {}
    // 3) 把原文还给用户 + 弹可操作提示。同样一个字节都不发。
    try {
      pendingSend = null
      sendBusy = false
      hideSendBusy()
      const raw = readComposer(box)
      let masked = { masked: raw, urls: [] }
      try {
        masked = MessageParser.maskUrls(MessageParser.maskEmoji(MessageParser.stripBusy(raw)).masked)
      } catch (e) {}
      // 占位符残留的兜底还原：同样走**原生输入**（这是崩溃兜底路径，
      // 不允许因为"反正要失败了"就退回页面内改 DOM）。
      nativeSetComposer(box, MessageParser.stripBusy(raw), 'crash_restore').catch(function () {})
      scrubBusy(box, MessageParser.stripBusy(raw))
      showSendFailureNotice(box, raw, masked)
    } catch (e) {}
  }

  /**
   * 「翻译成功才发送」。
   *
   * ## 铁律：翻译失败绝不发送原文
   *
   * 老实现是「译文拿不到就用原文兜底，然后照常点发送」：
   * `out` 为空（超时 / 断网 / 余额不足 / 通道不在套餐里）时把**中文原文原样
   * 发了出去**。用户以为自己在用"发送翻译"，对方收到的却是一段自己看不懂的
   * 中文；而且这一下是**用户没同意**的发送动作。
   *
   * 正确行为（产品规则）：翻译没成功，就什么都不发。原文退回输入框，
   * 并给用户两个**必须自己点**的选择：
   *   · 重试翻译  → 再翻一次，成功才发
   *   · 发送原文  → 用户明确表示"我知道没翻译，就要发原文"，才发
   *
   * 不做"静默降级成发原文"，也不做"什么提示都没有"。
   */
  async function deliverSend(box, raw, masked) {
    sendBusy = true
    pendingSend = { box: box, raw: raw }
    // ★ A ★ loading 只画在我们自己的浮层上，**不碰输入框**。
    //   （老实现这里是 writeComposer(box, raw + BUSY_MARK)，就是泄漏源头。）
    //   输入框里从头到尾都是用户原文；这段时间由 sendBusy 挡住一切发送。
    showSendBusy()
    sendActionPhase = 'translating'
    perfMark('translateStart')
    trace('TRANSLATE_STARTED', { chain: 'send', trigger: TRIGGER_SEND })
    // 用**带错误码**的版本：统一压成"翻译失败"会把"余额不足 / 通道不在套餐 /
    // 断线 / 空结果"全糊掉，用户与事后取证都看不出真正死在哪一步（本轮明令禁止）。
    // 超时兜底在 translateTextDetailed 内部（见那里的看门狗），这里只管异常。
    let res = null
    try {
      res = await translateTextDetailed(masked.masked, false, TRIGGER_SEND)
    } catch (e) {
      res = { ok: false, code: 'CLIENT_EXCEPTION', out: '', err: (e && e.message) || '' }
    }
    const out = String((res && res.out) || '')
    if (!out) {
      const code = String((res && res.code) || 'TRANSLATE_FAILED')
      lastSendFail = { code: code, reason: (res && res.err) || '', at: Date.now(), trigger: TRIGGER_SEND }
      // D：翻译失败 → **一个字节都不发**。原文本来就在输入框里（我们没动过它），
      //    这里再写一次只是兜底，然后弹可操作的提示。
      pendingSend = null
      sendBusy = false
      hideSendBusy()
      // ★ 失败必须把状态机归位 ★
      //   老实现这一天直接 return，`sendActionPhase` 永远停在 'translating'：
      //   于是"重试"复用同一个 phase 残留，后续每次发送都更容易被判成陈旧。
      sendActionPhase = 'idle'
      // 但兜底之前先看草稿：用户可能已经在打下一条。拿原文硬写回等于把他
      // 正在打的内容整段吃掉（真机已复现，属数据丢失）。
      if (canSafelyRestore(box, raw)) await nativeSetComposer(box, raw, 'translate_failed_restore')
      else trace('COMPOSER_LEFT_AS_IS', { at: 'translate_failed', chars: readComposer(box).length })
      trace('TRANSLATE_FAILED', { chain: 'send', failClosed: true, code: code })
      // 网络类失败要说清楚是"连不上 / 超时"，不能让用户以为是我们翻译坏了。
      // 文案与顶部提示（NOTICE_TEXT）共用同一句，避免两处各说各话。
      const netText = (code === 'NETWORK_UNREACHABLE' || code === 'NETWORK_TIMEOUT'
        || code === 'NETWORK_BACKOFF'
        || code === 'SERVER_BAD_RESPONSE') ? String(NOTICE_TEXT[code] || '') : ''
      showSendFailureNotice(box, raw, masked, {
        title: netText ? '网络异常，消息未发送' : '翻译失败，消息未发送',
        hint: netText ? (netText + ' ' + SEND_FAIL_HINT) : SEND_FAIL_HINT,
        code: code
      })
      perfMark('uiClosed')
      perfEmit('translate_failed', { code: code, engine: prefs.engine || '-', chars: raw.length })
      return false
    }
    const finalText = out === masked.masked
      ? raw
      // 回填顺序：先 URL 再 emoji。
      //
      // 两套占位符形态不同（[[n]] / {{en}}），理论上顺序无关；但先 URL
      // 是有意的 —— URL 一旦丢了就是"链接点不开"，比表情位置不完美严重，
      // 让它在更早一轮拿到最准确的位置。
      : MessageParser.restoreEmoji(MessageParser.restoreUrls(out, masked.urls), masked.emojis)
    // ★ 不收起提示，而是切到「正在发送…」★
    //   译文已经拿到，但**还没发出去**。老实现在这里直接 hideSendBusy()，
    //   于是原生输入 + 沉降 + 发送这段界面空白，用户会以为卡住而反复按回车。
    setSendStatus('sending')
    sendActionPhase = 'succeeded'
    perfMark('translateDone')
    trace('TRANSLATE_SUCCEEDED', { chain: 'send', chars: finalText.length, requestId: (res && res.requestId) || '-' })
    // 性能计时：这一次动作最终有没有真的发出去（决定 SEND_PERF 的 outcome）。
    let sentOk = false
    try {
      // 「再次确认当前 sendAction 仍有效」—— 异步等待期间状态可能已经变了
      // （例如用户又按了一次、或失败提示已被处理）。状态不对就不发。
      if (sendActionPhase !== 'succeeded') {
        blockSend('STALE_ACTION', box, raw, masked)
        return false
      }
      // B + C：成功才写回 → **回读校验** → 校验通过才发，且只发一次。
      //
      // ★ 0.1.19：写入方式换成 **Chromium 原生输入** ★
      //   真机证据（0.1.18）：expected=29 字符英文译文 vs actual=6 字符中文原文，
      //   writeMethod=execCommand:insertText、sawBeforeInput=false —— 页面内改 DOM
      //   的写入**从未进入** WhatsApp 编辑器的输入管线。所以这里不再自己改 DOM，
      //   改由主进程跑 Chromium 编辑命令（selectAll → delete → insertText），
      //   产生**可信事件**，编辑器才会真正更新自己的 state。
      //   `writeAndVerify` / `writeComposer` 已从发送链彻底移出（不再有第二条写法）。
      //
      // ★ 替换之前**先确认 composer 没被用户改过** ★
      //   ① 仍是本次 sourceText（或等价的规范化形式）→ 允许替换；
      //   ② 用户已经打了新内容 → **立即中止**：这一条不发送，
      //      而且一个字节都不许动他的新草稿。
      //   判据用 canonicalizeSendBody，所以 WhatsApp 自己造成的空白/零宽差异
      //   不会被误判成"用户改了"。
      const draftNow = readComposer(box)
      if (canonicalizeSendBody(draftNow) !== canonicalizeSendBody(raw)) {
        trace('USER_DRAFT_EDITED_ABORT', {
          chain: 'send',
          at: 'before_replace',
          sourceChars: raw.length,
          draftChars: draftNow.length
        })
        sendActionPhase = 'idle'
        notifyTranslateIssue({
          code: 'USER_DRAFT_EDITED',
          msg: '你在输入框里已经打了新内容，这一条我没有发送、也没有改动你的输入。如仍要翻译，请重新按发送。'
        })
        return false
      }
      trace('COMPOSER_STILL_SOURCE', { chain: 'send', chars: draftNow.length })
      const replaced = await replaceComposerWithTranslatedTextNative(box, finalText)
      if (!replaced.ok) {
        // 原生输入之后正文仍与译文不一致（或桥不可用）：先取证，再 fail-closed。
        traceBodyMismatch(box, finalText, replaced.actual)
        trace('INPUT_REPLACED', { chars: finalText.length, ok: false, reason: replaced.reason || 'native_failed' })
        blockSend('BODY_MISMATCH', box, raw, masked)
        return false
      }
      sendActionPhase = 'replaced'
      trace('INPUT_REPLACED', {
        chars: finalText.length,
        ok: true,
        via: 'native_input'
      })
      // 发送前最后一道闸：独立于上一段回读，专门对"这一步之后正文又被改掉 /
      // 占位符渗入"负责。事件名按收口规范固定为 FINAL_TEXT_VALIDATED。
      const gate = sendableBody(box, finalText)
      trace('FINAL_TEXT_VALIDATED', {
        ok: gate.ok,
        reason: gate.reason || '',
        chars: String(gate.actual || '').length,
        via: 'native_input'
      })
      perfMark('validated')
      if (!gate.ok) {
        traceBodyMismatch(box, finalText, gate.actual)
        blockSend(gate.reason, box, raw, masked)
        return false
      }
      const fired = fireSendVerified(box, finalText)
      if (!fired.ok) {
        blockSend(fired.reason, box, raw, masked)
        return false
      }
      sentOk = true
    } catch (e) {
      blockSend('EXCEPTION', box, raw, masked)
      return false
    } finally {
      pendingSend = null
      sendBusy = false
      // ★ 只有真的发出去了才显示「已发送」★
      //   发送失败走的是 blockSend 的失败提示（带真实错误码），不会走到这里。
      if (sentOk) {
        perfMark('uiClosed')
        setSendStatus('sent')
        perfEmit('ok', { engine: prefs.engine || '-', chars: finalText.length })
      } else {
        hideSendBusy()
      }
      // 复位必须**只归自己这一次动作**管。
      // 老实现无条件 400ms 后置 idle，于是上一条的定时器会把下一条正在飞的
      // phase 清掉 —— 下一条走到 fireSendVerified 时被 STALE_ACTION 拦下，
      // 表现成"连发几条，中间几条凭空消失"（真机已复现）。
      const myAction = sendActionId
      setTimeout(function () {
        if (sendActionId === myAction && sendActionPhase !== 'idle') sendActionPhase = 'idle'
      }, 400)
    }
    return true
  }

  /**
   * 回读比对用：抹掉空白 / 零宽字符差异。
   *
   * 不能按"逐字节相等"判，否则编辑器加一个换行、浏览器插一个零宽字符就会被
   * 误判成写入失败，把正常消息也拦下来。
   */
  function normalizeBody(text) {
    return String(text == null ? '' : text)
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /**
   * 发送正文的**规范化**（canonicalize）—— 只抹"无语义差异"，不抹真实内容。
   *
   * ## 为什么需要它（P0-1：重试时 BODY_MISMATCH）
   *
   * 译文写进 WhatsApp 输入框后回读，常常与"我们打算发的正文"**字面不等**，
   * 但差别只在几种**不可见/等价**的表示上：
   *   · 换行表示不同     CRLF / CR  vs  LF
   *   · 不换行空格       NBSP(U+00A0) / 窄空格(U+202F) / 全角空格(U+3000) vs 普通空格
   *   · 零宽字符         U+200B / U+200C / U+200D / U+2060 / U+FEFF / U+180E
   *   · Unicode 归一化   NFC vs NFD（带音标的字符可能是"合成/分解"两种写法）
   *
   * 以前这里用的是 `normalizeBody`（把所有空白压成一个空格）—— 那个做法**过头**：
   * 它会把 "第一行\n第二行" 与 "第一行 第二行" 判成相同，等于**篡改语义**。
   *
   * 所以这里换成**严格白名单**：只允许上面四类。以下一律**不许**被抹掉，
   * 抹掉了就会把"真实的内容变化"当成"等价"放出去：
   *   ✗ 文字变化   ✗ 数字变化   ✗ URL 变化   ✗ 标点增删   ✗ 换行结构
   */
  function canonicalizeSendBody(text) {
    return String(text == null ? '' : text)
      .normalize('NFC')                                   // Unicode 归一化
      .replace(/\r\n?/g, '\n')                            // CRLF / CR → LF
      .replace(/[\u180E\u200B-\u200D\u2060\uFEFF]/g, '')  // 零宽字符清理
      .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ') // 各类不可见空格 → 普通空格
      .trim()
  }

  /**
   * 供 trace 用的正文指纹：长度 + 轻量 hash（FNV-1a）+ **差异处的字符码**。
   *
   * ★ 绝不把正文原文放进 trace ★
   * 0.1.18 真机踩过这个坑：payload 里带了 head/tail 原文，日志脱敏器把**整行**
   * （连事件名一起）打成了 `<已脱敏长串>`，真机分诊时连"这是哪个事件"都看不出来。
   * 现在只留长度、hash、以及差异位置附近的 charCode —— 既能一眼认出
   * NBSP(160) / ZWSP(8203) / CR(13) 这类不可见字符，又不泄漏消息内容。
   */
  function bodyDigest(text) {
    const s = String(text == null ? '' : text)
    let h = 2166136261
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return { len: s.length, hash: (h >>> 0).toString(16) }
  }

  /** 差异位置附近的字符码（不含原文），用来判断"到底差的是哪种不可见字符"。 */
  function codesAround(text, from, span) {
    const s = String(text == null ? '' : text)
    const n = Math.min(s.length, Math.max(0, from) + (span || 12))
    const out = []
    for (let i = Math.max(0, from); i < n; i++) out.push(s.charCodeAt(i))
    return out
  }

  /** 两个字符串**首个不同字符的位置**；完全相同返回 -1，前缀相同返回较短长度。 */
  function firstDiffIndex(a, b) {
    const x = String(a == null ? '' : a)
    const y = String(b == null ? '' : b)
    const n = Math.min(x.length, y.length)
    for (let i = 0; i < n; i++) if (x.charCodeAt(i) !== y.charCodeAt(i)) return i
    return x.length === y.length ? -1 : n
  }

  /**
   * ★ 0.1.19：`writeAndVerify()` 已删除（连同 `writeComposer()`）★
   *
   * 它在真机上的实际表现是**静默失败**：`execCommand` 什么都没写进去也返回 true，
   * 于是"写回失败"对调用方完全不可见。真机 0.1.18 证据显示 actual 就是原文本身。
   *
   * 现在写入只有一条路：`nativeSetComposer()` → 主进程 Chromium 原生编辑命令，
   * 并由 `replaceComposerWithTranslatedTextNative()` 回读 + canonical 比对。
   * 保留本说明是为了让"为什么删掉"可被 grep 到，防止被顺手加回来。
   */

  /**
   * ★ 0.1.19 主线：用 **Chromium 原生输入**把译文放进 composer ★
   *
   * ## 为什么不再自己改 DOM（真机证据）
   *
   * 0.1.18 真机日志（同一台 Mac，hello-pix-2026-10-08.log）：
   *
   *     expected : len=29 hash=33aaf90e  "Test translation information."
   *     actual   : len=6  hash=3a49c2d5  "测试翻译信息"
   *     writeMethod:"execCommand:insertText"  sawBeforeInput:false  sawInput:true
   *
   * `actual` **就是原文**，译文一个字符都没进去。`sawBeforeInput:false` 是关键：
   * WhatsApp 的编辑器（Lexical 系）在**祖先捕获阶段**拦掉了 `isTrusted:false`
   * 的 `beforeinput`，所以 `execCommand` / `textContent` 这类"页面内改 DOM"的写入
   * **从未进入编辑器的输入管线** —— 改的是 DOM，编辑器 state 没动，下一次它自己
   * 调和就把 DOM 重新盖回去。
   *
   * 结论：写入方式必须换成**浏览器进程发起的真实输入**（可信事件），
   * 编辑器才会按正常输入处理、同步自己的 state。
   *
   * ## 流程
   *
   *     box.focus()（只聚焦，不改内容）
   *       → 主进程 selectAll + delete        → 回读 → COMPOSER_CLEARED
   *       → 主进程 insertText(translatedText) → 回读 → NATIVE_TEXT_INSERTED
   *       → 轮询直到正文稳定                   → LEXICAL_SETTLED（含漂移采样）
   *       → canonical 比对                     → FINAL_TEXT_VALIDATED
   *
   * 全程**不**出现 innerText / textContent / innerHTML / replaceChildren / 手工插 span。
   *
   * @returns {Promise<{ok:boolean, actual:string, reason?:string, samples:Array}>}
   */
  async function replaceComposerWithTranslatedTextNative(box, text) {
    const expected = String(text == null ? '' : text)
    const wantCanon = canonicalizeSendBody(expected)
    const samples = []
    if (!box) return { ok: false, actual: '', reason: 'NO_COMPOSER', samples: samples }
    // 取证：从这一刻起"最近一次写入方式"就是原生输入。
    markNativeWrite(box, 'native:selectAll+delete+insertText')
    const bridge = (typeof pixBridge !== 'undefined' && pixBridge) || null
    if (!bridge || !bridge.nativeComposerClear || !bridge.nativeComposerInsertText) {
      // 桥没有原生通道 = 老版本主进程。**不许退回 DOM 写入**（那正是根因）。
      trace('NATIVE_INPUT_UNAVAILABLE', { chain: 'send', reason: 'no_bridge' })
      return { ok: false, actual: readComposer(box), reason: 'NO_NATIVE_BRIDGE', samples: samples }
    }

    trace('NATIVE_INPUT_BEGIN', {
      chain: 'send',
      expected: bodyDigest(expected),
      canonicalLen: wantCanon.length,
      boxTag: String(box.tagName || '').toLowerCase(),
      contentEditable: box.isContentEditable ? 'true' : 'false'
    })
    perfMark('nativeBegin')

    // 只聚焦，不改内容 —— 让 Chromium 的编辑命令作用在 composer 上。
    try { box.focus() } catch (e) {}

    const sample = (label, at) => {
      const raw = readComposer(box)
      const canon = canonicalizeSendBody(raw)
      const row = {
        label: label,
        t: at,
        len: raw.length,
        hash: bodyDigest(raw).hash,
        canonLen: canon.length,
        equal: canon === wantCanon
      }
      samples.push(row)
      return row
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      // ---- 清空（Chromium 编辑命令）----
      let cleared = null
      try {
        cleared = await bridge.nativeComposerClear()
      } catch (e) {
        cleared = { ok: false, reason: 'BRIDGE_ERROR:' + ((e && e.message) || e) }
      }
      const afterClear = sample('COMPOSER_CLEARED', 0)
      trace('COMPOSER_CLEARED', {
        chain: 'send',
        attempt: attempt,
        ok: !!(cleared && cleared.ok),
        reason: (cleared && cleared.reason) || '',
        focused: !!(cleared && cleared.focused),
        actual: bodyDigest(readComposer(box))
      })
      if (!cleared || !cleared.ok) {
        trace('NATIVE_INPUT_FAILED', { chain: 'send', at: 'clear', reason: (cleared && cleared.reason) || 'unknown' })
        return { ok: false, actual: readComposer(box), reason: 'CLEAR_FAILED', samples: samples }
      }

      // ---- 原生插入（Chromium 原生文本输入）----
      let inserted = null
      try {
        // 第二次尝试走**逐行插入**：换行表示差异（`\n` 被编辑器落成 `<br>` / 新 div）
        // 是唯一可能由"插入方式"引起的差异，逐行插入能避开它。
        inserted = await bridge.nativeComposerInsertText(expected, attempt > 1)
      } catch (e) {
        inserted = { ok: false, reason: 'BRIDGE_ERROR:' + ((e && e.message) || e) }
      }
      sample('NATIVE_TEXT_INSERTED', 0)
      trace('NATIVE_TEXT_INSERTED', {
        chain: 'send',
        attempt: attempt,
        ok: !!(inserted && inserted.ok),
        reason: (inserted && inserted.reason) || '',
        chars: expected.length,
        actual: bodyDigest(readComposer(box))
      })
      if (!inserted || !inserted.ok) {
        trace('NATIVE_INPUT_FAILED', { chain: 'send', at: 'insert', reason: (inserted && inserted.reason) || 'unknown' })
        return { ok: false, actual: readComposer(box), reason: 'INSERT_FAILED', samples: samples }
      }

      // ---- 等编辑器自己收口（LEXICAL_SETTLED）----
      //
      // ## 0.1.19 性能专项：从"固定 500ms 观察窗"改成"确认即走"
      //
      // 实测（bench-send-timing）：固定 500ms 的观察窗占掉了整条发送链
      // **100%** 的客户端开销（508ms / 508ms），而它存在的唯一目的是证明
      // "编辑器不再改动正文"。既然目标只是"确认"，就不该无条件等满 500ms。
      //
      // 新判据是三条同时成立：
      //   ① canonical 正文 == 译文（编辑器的内部 state 确实吃进了我们的输入）
      //   ② 连续 STABLE_STREAK 次回读完全一致（不是在两次 render 之间取到的瞬态）
      //   ③ 已观察满 **下限** sendSettleMs（默认 60ms，给编辑器留一拍）
      // 满足即认为收口，立刻进入校验 + 发送。
      //
      // ## 为什么可以缩短而**不降低安全性**
      //
      // 缩短观察窗**不会**把风险放到"发出去之后"，因为：
      //   · 发送前仍有**独立**的一道 `sendableBody()` 闸（FINAL_TEXT_VALIDATED），
      //     它就在 `fireSend()` 前一行同步执行；
      //   · 那道闸读的是**此刻的 DOM**，与触发发送之间没有任何 await 间隙；
      //   · 不一致就 fail-closed，一个字节都不发（BODY_MISMATCH 原样保留）。
      // 所以"观察窗"只影响**确认得早不早**，不影响"不合格会不会被拦"。
      //
      // 上限 sendSettleCeilingMs（默认 400ms）：到点仍不稳定 → 换一种插入方式
      // 重试一次 → 仍不行就 fail-closed。绝不会为了快而放行。
      const settleFloorMs = Number.isFinite(Number(prefs.sendSettleMs))
        ? Math.max(0, Number(prefs.sendSettleMs))
        : NATIVE_SETTLE_FLOOR_DEFAULT_MS
      // 上限必须 ≥ 下限（取证模式会把下限调到 500，此时要让它跑得完，
      // 否则 0/100/300/500 的漂移时间线会被截断）。
      const settleCeilingMs = Math.max(
        settleFloorMs + NATIVE_SETTLE_SLACK_MS,
        Number.isFinite(Number(prefs.sendSettleCeilingMs))
          ? Math.max(0, Number(prefs.sendSettleCeilingMs))
          : NATIVE_SETTLE_CEILING_DEFAULT_MS
      )
      const t0 = Date.now()
      let lastCanon = null
      let streak = 0
      let marks = 0
      let settled = false
      let everEqual = false
      while (true) {
        const elapsed = Date.now() - t0
        const s = sample('DRIFT', elapsed)
        // 稳定性判据用**完整 canonical 正文**，不是只看长度 ——
        // 等长替换（"3 点" → "4 点"）长度一样但内容已经变了，不能算"稳定"。
        if (s.canon === lastCanon) streak++
        else streak = 1
        lastCanon = s.canon
        if (s.equal) everEqual = true
        // 关键采样点：0 / 100 / 300 / 500ms（取证用；只采落在窗口内的点，
        // 避免留下误导性的半截时间线）。
        if (marks < NATIVE_SAMPLE_MARKS.length && elapsed >= NATIVE_SAMPLE_MARKS[marks]) {
          const mark = NATIVE_SAMPLE_MARKS[marks]
          marks++
          if (mark <= settleCeilingMs) {
            trace('COMPOSER_DRIFT_SAMPLE', {
              chain: 'send',
              attempt: attempt,
              t: elapsed,
              mark: mark,
              len: s.len,
              hash: s.hash,
              canonLen: s.canonLen,
              equal: s.equal
            })
          }
        }
        // 收口判据：**正文已经稳定**（连续 NATIVE_STABLE_STREAK 次回读完全一致，
        // 说明不是在两次 render 之间取到的瞬态）+ 已过下限。
        // 注意这里**不要求**内容等于译文 —— 内容稳定但不等于译文，恰恰说明
        // 这次写入没生效，应当尽快进入重试/fail-closed，而不是白等满上限。
        // （分批插入的场景不会误判：那时 canonical 每次都在变，streak 始终很低。）
        if (streak >= NATIVE_STABLE_STREAK && elapsed >= settleFloorMs) { settled = true; break }
        if (elapsed >= settleCeilingMs) break
        await wait(NATIVE_SETTLE_POLL_MS)
      }
      const settleMsSpent = Date.now() - t0
      const finalRaw = readComposer(box)
      const finalCanon = canonicalizeSendBody(finalRaw)
      const ok = finalCanon === wantCanon
      trace('LEXICAL_SETTLED', {
        chain: 'send',
        attempt: attempt,
        ms: settleMsSpent,
        stable: settled,
        settledEarly: settled && settleMsSpent < settleCeilingMs,
        everEqual: everEqual,
        floor: settleFloorMs,
        ceiling: settleCeilingMs,
        expected: bodyDigest(expected),
        actual: bodyDigest(finalRaw),
        canonicalEqual: ok,
        canonicalLen: { expected: wantCanon.length, actual: finalCanon.length },
        firstDiffCanonical: firstDiffIndex(wantCanon, finalCanon),
        driftSamples: samples.length
      })
      perfMark('settled')
      if (ok) return { ok: true, actual: finalRaw, samples: samples }
      if (attempt < 2) {
        trace('NATIVE_INPUT_RETRY', { chain: 'send', attempt: attempt })
        continue
      }
      return { ok: false, actual: finalRaw, reason: 'BODY_MISMATCH', samples: samples }
    }
    return { ok: false, actual: readComposer(box), reason: 'BODY_MISMATCH', samples: samples }
  }

  /**
   * 把正文写进输入框，并**回读校验**。
   *
   * ★ 0.1.19：这个函数连同 `writeComposer()` 已经**从发送链彻底删除** ★
   * 它代表的正是被真机证伪的那条路（页面内改 DOM，编辑器不认、下一次调和就盖回来）。
   * 发送链现在只有一条写入路径：`nativeSetComposer()` →
   * `replaceComposerWithTranslatedTextNative()` → 主进程 Chromium 原生编辑命令。
   * 保留这个说明是为了让"为什么删掉"可被 grep 到，避免以后有人又加回来。
   */
  async function nativeSetComposer(box, text, why) {
    const value = String(text == null ? '' : text)
    const res = await replaceComposerWithTranslatedTextNative(box, value)
    trace('NATIVE_SET_COMPOSER', {
      chain: 'send',
      why: String(why || ''),
      ok: !!res.ok,
      reason: res.reason || '',
      chars: value.length,
      actual: bodyDigest(res.actual || '')
    })
    return res
  }

  /**
   * 现在能不能**安全地**把 composer 还原成 raw？
   *
   * 铁律：**用户打了新内容就一个字节都不许动**。覆盖用户的输入 = 数据丢失，
   * 比"没反应"严重得多（真机已复现过"我打了一半，自己没了"）。
   *
   * 只有当框里装的是"我们自己的东西"时才允许还原：
   *   · 空的（本来就没内容，写回原文是恢复原状）
   *   · 还挂着占位符（那是我们的状态，必须清掉）
   *   · 规范化之后就是 raw 本身（没变，无需担心）
   */
  function canSafelyRestore(box, raw) {
    const now = readComposer(box)
    if (!String(now).trim()) return true
    if (MessageParser.hasBusy(now)) return true
    return canonicalizeSendBody(now) === canonicalizeSendBody(raw)
  }

  /**
   * 发送前的最后一道闸（fail-closed）—— **不受 suppression 影响**。
   *
   * 老实现里 `onClick` / `onKeyDown` 都是**先看 suppression、再跑 guardBusySend**，
   * 而 `fireSend()` 恰恰会把 suppression 置真。于是"我们自己发起的那一次发送"
   * 正好把唯一能拦住占位符的闸关掉了 —— 这就是占位符出网的最后一步。
   *
   * 现在这一闸独立于一切开关：正文里只要还挂着占位符，或者正文与预期译文的
   * **规范化结果**不一致，就**不发**。
   *
   * P0-1：比对改为 canonicalize —— 只放行 CRLF/LF、NBSP、零宽、Unicode 归一化
   * 这类**无语义**差异；文字/数字/URL/标点/换行结构的真实变化仍然 fail-closed。
   */
  function sendableBody(box, expected) {
    const actual = readComposer(box)
    if (MessageParser.hasBusy(actual)) {
      return { ok: false, reason: 'BUSY_MARK', actual: actual }
    }
    if (expected != null && canonicalizeSendBody(actual) !== canonicalizeSendBody(expected)) {
      return { ok: false, reason: 'BODY_MISMATCH', actual: actual }
    }
    return { ok: true, actual: actual }
  }

  /**
   * BODY_MISMATCH 的**完整取证** —— 用户明确要求：必须能看到究竟差在哪，
   * 不许再用一句笼统的"状态异常"糊过去。
   *
   * 落盘内容：预期/实际的长度与 hash、首个差异位、canonical 前后文本、
   * 输入框 tag/class/contenteditable、写入方式、input/beforeinput 是否触发。
   */
  function traceBodyMismatch(box, expected, actual) {
    const ce = canonicalizeSendBody(expected)
    const ca = canonicalizeSendBody(actual)
    const w = lastWriteInfo || {}
    const rawIdx = firstDiffIndex(String(expected == null ? '' : expected), String(actual == null ? '' : actual))
    const canIdx = firstDiffIndex(ce, ca)
    trace('SEND_BODY_MISMATCH_DETAIL', {
      chain: 'send',
      expected: bodyDigest(expected),
      actual: bodyDigest(actual),
      canonicalEqual: ce === ca,
      firstDiffRaw: rawIdx,
      firstDiffCanonical: canIdx,
      canonicalLen: { expected: ce.length, actual: ca.length },
      // 只给字符码，不给原文 —— 避免整行被日志脱敏器打成 <已脱敏长串>。
      expectedCodes: codesAround(expected, rawIdx, 12),
      actualCodes: codesAround(actual, rawIdx, 12),
      boxTag: w.tag || (box && String(box.tagName || '').toLowerCase()) || '-',
      boxClass: w.cls || (box && String(box.className || '').slice(0, 80)) || '-',
      contentEditable: w.editable != null ? w.editable : (box && box.isContentEditable ? 'true' : 'false'),
      writeMethod: w.method || '-',
      trustedEvent: w.trusted === true,
      sawBeforeInput: w.sawBeforeInput,
      sawInput: w.sawInput
    })
  }

  function fireSendVerified(box, expected) {
    // 「TRANSLATE_SUCCEEDED 之前不得有任何真实发送」—— 在代码里写死这一条：
    // 只有走完 succeeded → replaced 的状态机，才允许进入程序化发送。
    if (sendActionPhase !== 'replaced') {
      console.error('[Hello Pix] BLOCKED_STALE_ACTION：发送动作已失效（phase=' +
        sendActionPhase + '），未发出任何内容')
      trace('SEND_ABORTED_STALE', { phase: sendActionPhase })
      return { ok: false, reason: 'STALE_ACTION' }
    }
    const gate = sendableBody(box, expected)
    if (!gate.ok) {
      console.error('[Hello Pix] BLOCKED_' + gate.reason +
        '：已拦下发送，未发出任何内容 · 正文=' + JSON.stringify(gate.actual))
      // P0-1：BODY_MISMATCH 必须留下完整差异取证，否则真机只能看到"失败了"。
      if (gate.reason === 'BODY_MISMATCH') traceBodyMismatch(box, expected, gate.actual)
      trace('SEND_BLOCKED_' + gate.reason, { chars: String(gate.actual || '').length })
      return gate
    }
    // 真机取证用：把**实际要发出去的正文**记进客户端日志。
    // 排查"对方收到的和我以为的不一样"时，没有这一行只能靠猜。
    console.info('[Hello Pix] 发送翻译 · 最终正文=' + JSON.stringify(gate.actual) + ' · trigger=manual_send')
    sendActionPhase = 'sending'
    trace('PROGRAMMATIC_SEND_BEGIN', { chars: gate.actual.length })
    perfMark('sendBegin')
    fireSend(box)
    perfMark('sendDone')
    trace('PROGRAMMATIC_SEND_DONE', { chars: gate.actual.length })
    return { ok: true, actual: gate.actual }
  }

  /**
   * 用户**明确授权**的发送：目前只有失败提示里的「发送原文」。
   *
   * 与 `fireSendVerified()` 的唯一区别：**不要求**走完翻译状态机。
   * 用户点「发送原文」的意思就是"这条我不翻了，按原样发出去"，此时
   * `sendActionPhase` 必然是失败态（translating/idle），永远不可能是 replaced。
   *
   * 老实现让「发送原文」也走 `fireSendVerified()`，于是线上真机表现是：
   * 点「发送原文」→ STALE_ACTION 拦下 → 什么都不发 → 又弹回同一个失败提示。
   * 用户被卡在一个**永远发不出去**的死循环里。
   *
   * 但"正文里不许有占位符"这条校验一点都不能省 —— 所以仍然要过 sendableBody()。
   */
  function fireSendUserAuthorized(box, expected, via) {
    const gate = sendableBody(box, expected)
    if (!gate.ok) {
      console.error('[Hello Pix] BLOCKED_' + gate.reason +
        '：已拦下发送，未发出任何内容 · 正文=' + JSON.stringify(gate.actual))
      trace('SEND_BLOCKED_' + gate.reason, { via: via || 'user', chars: String(gate.actual || '').length })
      return gate
    }
    console.info('[Hello Pix] ' + (via === 'send_raw' ? '发送原文' : '用户授权发送') +
      ' · 最终正文=' + JSON.stringify(gate.actual))
    sendActionPhase = 'sending'
    trace('PROGRAMMATIC_SEND_BEGIN', { via: via || 'user', chars: gate.actual.length })
    fireSend(box)
    trace('PROGRAMMATIC_SEND_DONE', { via: via || 'user', chars: gate.actual.length })
    perfMark('sendDone')
    // 用户明确点了「发送原文」：同样按"真的发出去了"给一次「已发送」反馈。
    perfMark('uiClosed')
    setSendStatus('sent')
    perfEmit('ok', { via: via || 'user', engine: prefs.engine || '-', chars: gate.actual.length })
    // 发完必须把 phase 归位，否则下一次正常发送会被 STALE_ACTION 误拦。
    // 同样只归自己这一次动作管（见 deliverSend 的同名处理）。
    const myAction = sendActionId
    window.setTimeout(function () {
      if (sendActionId === myAction && sendActionPhase === 'sending') sendActionPhase = 'idle'
    }, 400)
    return { ok: true, actual: gate.actual }
  }

  /** 被 fail-closed 拦下之后的收尾：还原原文 + 明确告知用户"没发出去"。 */
  function blockSend(reason, box, raw, masked) {
    pendingSend = null
    sendBusy = false
    hideSendBusy()
    // 归位状态机：失败态绝不能把 phase 留在 translating，否则下一次发送
    // （尤其是「重试翻译」）会被残留状态误判成陈旧动作而再次失败。
    sendActionPhase = 'idle'
    lastSendFail = { code: String(reason || 'BLOCKED'), reason: String(reason || ''), at: Date.now(), trigger: TRIGGER_SEND }
    // 还原正文同样走**原生输入**（不再有第二套写法）。这里是异步的：
    // 即使还原还没完成，sendableBody() 也会因为占位符/正文不符而拦下发送 ——
    // 绝不会出现"占位符还没抹掉就真发出去"。
    //
    // ★ 但**用户的新草稿必须原样不动** ★：只要框里不是"我们自己的东西"
    //   （空 / 占位符 / 就是 raw 本身），一律不碰。
    if (canSafelyRestore(box, raw)) {
      nativeSetComposer(box, raw, 'block_send_restore').catch(function () {})
    } else {
      trace('COMPOSER_LEFT_AS_IS', { at: 'block_send', chars: readComposer(box).length })
    }
    console.error('[Hello Pix] BLOCKED_' + reason + '：翻译状态异常，消息未发送')
    trace('SEND_FAIL_CLOSED', { reason: reason })
    // 性能计时：fail-closed 也要给一行收口，否则这条动作在统计里就是"没有记录"。
    perfMark('uiClosed')
    perfEmit('fail_closed', { code: String(reason || '') })
    showSendFailureNotice(box, raw, masked, {
      title: '翻译状态异常，消息未发送',
      hint: '为避免发出未翻译或带占位符的内容，这一条已拦下。对方没有收到任何内容。',
      code: String(reason || '')
    })
  }

  /** 输入框里还挂着占位符就把它抹掉，换成给定文本。发送前的最后一道复核。 */
  function scrubBusy(box, fallback) {
    if (!box) return
    if (!MessageParser.hasBusy(readComposer(box))) return
    nativeSetComposer(box, String(fallback == null ? '' : fallback), 'scrub_busy').catch(function () {})
  }

  /**
   * 事件是不是发生在我们自己画的界面上（失败提示的两个按钮等）。
   *
   * 这些元素都在 `document.body` 下、和 WhatsApp 的输入区无关。放行它们，
   * 既避免"点重试被当成点了发送"这类自噬，也避免我们的控件被采集/解析误收。
   */
  function eventIsOwnUi(event) {
    const t = event && event.target
    if (!t || !t.closest) return false
    return !!t.closest('[data-pix-ui]')
  }

  /**
   * 占位符硬闸 —— 与翻译开关无关的最后一道闸。
   *
   * 只要输入框里还挂着 [正在翻译中...]，这一下发送就必须被拦下。
   * 老实现只在 `prefs.transSend` 打开时才检查占位符，于是：
   *   - 翻译中途用户关掉发送翻译 → 这一下 Enter 直通 WhatsApp，占位符就发出去了
   *   - 异步流程被打断 / 写回失败 → 占位符留在框里，下一次 Enter 也直通
   * 占位符是**我们自己的状态**，绝不能变成一条真实消息，所以这一闸必须独立于
   * 翻译开关，并且挂在捕获阶段最先执行。
   */
  function guardBusySend(event) {
    if (eventIsOwnUi(event)) return false
    const box = composerEl()
    if (!box) return false
    const text = readComposer(box)
    if (!MessageParser.hasBusy(text)) return false
    if (event) {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }
    // 正在翻译：什么都不做，等 runIntercept 自己把译文或原文写回来
    if (sendBusy) return true
    // 翻译流程已结束而占位符还在（写回失败 / 被打断）：**原生**还原成用户原文。
    // 注意这一下发送已经被上面的 preventDefault 拦住了 —— 这里只负责"把正文还回去"，
    // 用户再按一次 Enter 才会真正发送。宁可多按一次，也绝不把占位符发出去。
    const pending = pendingSend && pendingSend.box === box ? pendingSend.raw : ''
    const restoreTo = pending || MessageParser.stripBusy(text)
    trace('NATIVE_RESTORE_SCHEDULED', { reason: 'busy_mark_without_busy_send', chars: restoreTo.length })
    nativeSetComposer(box, restoreTo, 'guard_busy_restore').catch(function () {})
    return true
  }

  function onKeyDown(event) {
    // 我们自己的界面（失败提示里的两个按钮）不是 WhatsApp 的输入区，
    // 一律放行 —— 否则按钮上的 Enter 会被当成"要不要翻译"重新走一遍。
    if (eventIsOwnUi(event)) return
    // 占位符硬闸**永远先跑**，且不受 suppression 影响。
    // 老实现把 suppression 判在它前面，于是 fireSend() 发起的那一次发送把闸关掉了 ——
    // 占位符正是从那个缺口出去的（真机 0.1.14 复现）。
    if (isSendEnter(event) && guardBusySend(event)) return
    // suppression 由 fireSend() 同步置位/清零，标记的是**我们自己那一次发送**。
    // 这里只放行、不复位 —— 复位交给 fireSend 的 finally，避免"第一次事件把标记吃掉，
    // 我们自己的后续事件反而被拦"。
    if (suppression && isSendEnter(event)) return
    if (!prefs.transSend) return
    if (event.defaultPrevented) return
    if (!isSendEnter(event)) return
    const box = sendTargetBox(event)
    if (!box || !eventInComposer(event, box)) {
      traceSkip('keydown', event, box)
      return
    }
    safeIntercept(event, box)
  }

  function onBeforeInput(event) {
    if (eventIsOwnUi(event)) return
    if (event.inputType === 'insertParagraph' && guardBusySend(event)) return
    if (!prefs.transSend) return
    if (suppression) return
    if (event.inputType !== 'insertParagraph') return
    const box = sendTargetBox(event)
    if (!box || !eventInComposer(event, box)) {
      traceSkip('beforeinput', event, box)
      return
    }
    safeIntercept(event, box)
  }

  function onClick(event) {
    // 「译」按钮走委托：必须在所有别的判断之前 —— 它是我们自己的控件，
    // 后面那些逻辑（自噬保护 / 发送拦截）都不该碰它。
    if (onChipClick(event)) return
    if (eventIsOwnUi(event)) return
    // 点发送按钮同样要过占位符硬闸：Enter 被绕过时，按钮是唯一的出口。
    // 顺序同样不能反 —— 必须在 suppression 之前，否则 fireSend 发起的那一次会溜过去。
    if (guardBusySend(event)) return
    if (suppression) return
    if (!prefs.transSend) return
    if (!looksLikeSend(event.target)) {
      // 「点发送按钮」这条通道最容易静默失效：附件预览面板等新结构下，
      // 发送按钮可能不带 aria-label/data-icon="send"，looksLikeSend 会漏判。
      // 但**不是所有点击都该记**（用户点别处也会走到这里），所以只记录
      // "看起来像发送"的点击：在 compose-box / footer 内、带 send 字样或是个按钮。
      traceSendClickSkip(event)
      return
    }
    const box = sendTargetBox(event)
    if (!box) { traceSkip('click-no-box', event, null); return }
    if (!readComposer(box).trim()) { traceSkip('click-empty-box', event, box); return }
    safeIntercept(event, box)
  }

  /**
   * 发送拦截被**静默放行**时的取证日志。
   *
   * 为什么需要它：用户报「图文一起发送的时候，不翻译」时，日志里**一条记录都没有** ——
   * 我们只能靠复述推断。凡是"本该拦下却没拦"的分支，都必须留下能一眼定位现场的一行，
   * 否则下一次还是同样两眼一抹黑。只记结构与原因，绝不记正文。
   */
  function traceSkip(reason, event, box) {
    try {
      const t = event && event.target
      console.info('[PIX_TRACE] SEND_NOT_INTERCEPTED ' + JSON.stringify({
        reason: reason,
        via: (event && event.type) || '-',
        key: (event && event.key) || '-',
        box: box ? {
          tag: String(box.tagName || '').toLowerCase(),
          testid: box.getAttribute ? (box.getAttribute('data-testid') || '') : '',
          editable: box.getAttribute ? (box.getAttribute('contenteditable') || '') : ''
        } : null,
        target: t ? {
          tag: String(t.tagName || '').toLowerCase(),
          testid: t.getAttribute ? (t.getAttribute('data-testid') || '') : '',
          icon: t.getAttribute ? (t.getAttribute('data-icon') || '') : '',
          ariaLabel: (t.getAttribute ? (t.getAttribute('aria-label') || '') : '').slice(0, 40)
        } : null,
        // 当前可见的输入框候选（不记内容，只记结构），用来判断"选错了哪个框"
        candidates: visibleComposerCandidates()
      }))
    } catch (e) {}
  }

  /**
   * 只有"看起来像发送按钮"的点击才记录 —— 避免用户在页面上随便点一下就刷日志。
   * 判据放宽到"在 compose-box / footer 内 且 是个按钮/图标"，因为附件预览面板
   * 的发送按钮可能没有 send 字样。
   */
  function traceSendClickSkip(event) {
    try {
      const t = event && event.target
      if (!t || !t.closest) return
      const btn = t.closest('button, [role="button"], [data-icon], [data-testid]')
      if (!btn) return
      const inCompose = !!(btn.closest('footer, [data-testid*="compose" i], [data-testid*="attach" i], [data-testid*="media" i]'))
      if (!inCompose) return
      traceSkip('click-not-send', event, composerEl())
    } catch (e) {}
  }

  /** 页面上当前可见的输入框候选结构（供 traceSkip 判断"选错框"）。 */
  function visibleComposerCandidates() {
    const out = []
    try {
      const all = document.querySelectorAll('[contenteditable="true"], textarea')
      for (let i = 0; i < all.length && out.length < 6; i++) {
        const el = all[i]
        if (!visible(el)) continue
        out.push({
          tag: String(el.tagName || '').toLowerCase(),
          testid: el.getAttribute('data-testid') || '',
          inFooter: !!el.closest('footer'),
          focused: el === document.activeElement
        })
      }
    } catch (e) {}
    return out
  }

  const DELETED_RE = /^(this message was deleted\.?|you deleted this message\.?|此消息已删除|你删除了这条消息|你已删除此消息|esta mensagem foi apagada|este mensaje fue eliminado|ce message a été supprimé|diese nachricht wurde gelöscht|pesan ini telah dihapus)$/i
  const revokeMap = new Map()

  function messageRoot(node) {
    // 只认"消息行"这一种身份：任何更宽的容器（msg-container / 聊天根）都不再
    // 被当作消息根 —— 那正是"译文绑错节点"的入口。没有 data-id 就用节点自身，
    // 由上层（parseScope / 渲染）自行判断可不可用。
    return node.closest(SITE.row) || node
  }

  function messageKey(root) {
    if (!root) return ''
    return root.getAttribute(SITE.keyAttr) || root.getAttribute('data-pre-plain-text') || ''
  }

  function isDeletedText(text) {
    return DELETED_RE.test(String(text || '').trim())
  }

  function rememberMessage(root, text) {
    const key = messageKey(root)
    if (!key || !text || isDeletedText(text) || text.length > 4000) return
    revokeMap.set(key, text)
  }

  function keepRevoked(root, text) {
    if (!prefs.antiRevoke || !root) return
    const key = messageKey(root)
    const saved = key && revokeMap.get(key)
    if (!saved) return
    if (!isDeletedText(text) && root.querySelector('.pix-kept')) return
    if (!isDeletedText(text)) return
    let kept = root.querySelector(':scope > .pix-kept')
    if (!kept) {
      kept = document.createElement('div')
      kept.className = 'pix-kept'
      root.appendChild(kept)
    }
    kept.textContent = saved
    let tag = root.querySelector(':scope > .pix-revoked')
    if (!tag) {
      tag = document.createElement('div')
      tag.className = 'pix-revoked'
      root.appendChild(tag)
    }
    tag.textContent = '已撤回'
  }

  /**
   * 「群聊自动翻译」开关的当前档位。
   *
   * 单独拎出来只为一件小事：CHAT_KIND 取证要在扫描循环**之前**打点，
   * 而扫描循环里"翻译开关不得出现在归档之前"这条硬规则有测试守着。
   * 把开关读取收进这个函数，既保留了取证信息，又不让 scan() 里多出
   * 一个会被误判成"翻译闸门"的 prefs 引用。
   */
  function groupModeLabel() { return prefs.transGroup ? 'auto' : 'manual' }

  /**
   * 把残留的手动「译」按钮收掉 —— 自动翻译接手时调用。
   *
   * 真机现象（2026-10-11）：先把群聊设成「手动」→ 满屏「译」；再切成「自动」→
   * 消息确实开始自动翻，但**按钮还赖在原处**。原因是 scan 的 auto 分支以前只画
   * 译文、从不清理入口，而已经挂上去的 chip 没有任何人负责摘掉。
   *
   * `busy` 态刻意不动：那是一次**正在进行**的手动翻译，收掉它等于把用户点出来的
   * 操作半途掐死（它的回调还要用这个节点回写状态）。
   */
  function removeStaleChip(host) {
    if (!isMessageHost(host)) return 0
    let removed = 0
    host.querySelectorAll('.pix-click').forEach(el => {
      if (el.getAttribute('data-pix-state') === 'busy') return
      el.remove()
      removed++
    })
    if (removed) {
      // 操作行空了就一起收掉，免得留一条空白行把气泡撑高
      host.querySelectorAll(':scope > .pix-trans-action-row').forEach(row => {
        if (!row.querySelector('.pix-click') && !String(row.textContent || '').trim()) row.remove()
      })
    }
    return removed
  }

  // ---------------------------------------------------------------------------
  // 自动翻译派发池
  //
  // 为什么不能在扫描循环里 `await` 一条翻一条（0.1.24 的做法）：
  // 「群聊=自动」现在要把打开会话时渲染出来的那批消息（真机实测 30~40 条）
  // 也翻掉。串行一条约 1s，用户就得盯着"翻一半"看半分钟 —— 那正是
  // 「一部分翻译、一部分没有翻译」的观感。
  //
  // 这里用**有界并发**派发，并且**新的先翻**：打开会话时人在底部，先把眼前
  // 这几条翻出来，剩下的在后台陆续填上。
  //
  // 并发上限不能去掉：翻译请求和**发送**链走同一套连接池，把连接占满会直接
  // 拖慢用户最在意的发送耗时（0.1.19 性能专项的结论）；账号级限流是
  // 120 次/分钟，也不允许一次性把几十条全推上去。
  // ---------------------------------------------------------------------------
  const AUTO_POOL_SIZE = 3
  const autoQueue = []
  // 正在翻译的消息 id —— **必须单独记一份**，不能靠 autoQueue 判断"是否已翻译"。
  //
  // 踩过的坑：enqueueAuto 原来只扫 autoQueue，而 autoPump 一 shift 出去、
  // 这条 job 就不在队里了。可它要跑 1 秒（一次网络往返），而 scan 每 220ms
  // 一轮 —— 期间它会被当成"还没翻过"重新入队、重新翻译、**再扣一次费**。
  // 打开一个 30 条的会话，同一条消息能被翻好几遍，用户看到的字符消耗
  // 和实际收到的译文条数对不上，就是这个原因。
  const autoInFlight = Object.create(null)
  let autoRunning = 0
  let lastScanIdentity = ''

  // 同一条消息自动翻译**失败后的冷却**。没有它会出事：scan 每 220ms 一轮，
  // 同一条失败的消息会被一轮一轮地重发 —— 一旦撞上限流，就是一场自己打自己的
  // 重试风暴。冷却期内不再自动重试（用户仍可手动点「译」）。
  const AUTO_FAIL_COOLDOWN_MS = 60000
  const autoFailedAt = new Map()

  function autoPump() {
    while (autoRunning < AUTO_POOL_SIZE && autoQueue.length) {
      const job = autoQueue.shift()
      autoRunning++
      if (job.id) autoInFlight[job.id] = 1
      const run = async () => {
        try {
          const translated = await translateParsed(job.parsed, true, TRIGGER_AUTO)
          // 翻译失败时**不清**已有译文框：一次网络抖动不该把上面那条好好的译文抹掉。
          if (translated) {
            paint(job.host, translated.out, job.text, {
              engine: translated.engine,
              routed: translated.routed
            })
          } else autoFailedAt.set(job.id, Date.now())
        } catch (e) {
          autoFailedAt.set(job.id, Date.now())
        } finally {
          // 先摘 in-flight 标记再 pump：pump 里可能立刻派发下一条，
          // 顺序反了会让同一条消息在极短窗口内被重复放行。
          if (job.id) delete autoInFlight[job.id]
          autoRunning--
          autoPump()
        }
      }
      run()
    }
  }

  /**
   * 把本轮扫描发现的待自动翻译消息交给派发池。返回真正入队的条数。
   *
   * 倒序入队 = **最新的先翻**。同一条消息（按消息身份去重）不会重复入队 ——
   * 判重要同时看**排队中**和**正在翻译中**两处，只看队列会让 in-flight 的那条
   * 被重复派发（见 autoInFlight 的注释）。
   */
  function enqueueAuto(jobs) {
    if (!jobs || !jobs.length) return 0
    const known = Object.create(null)
    for (let i = 0; i < autoQueue.length; i++) known[autoQueue[i].id] = 1
    let added = 0
    for (let i = jobs.length - 1; i >= 0; i--) {
      const job = jobs[i]
      if (!job.id || known[job.id] || autoInFlight[job.id]) continue
      const failedAt = autoFailedAt.get(job.id)
      if (failedAt && Date.now() - failedAt < AUTO_FAIL_COOLDOWN_MS) continue
      known[job.id] = 1
      autoQueue.push(job)
      added++
    }
    if (added) autoPump()
    return added
  }

  async function scan() {
    // 每次扫描顺带看一眼是不是换了客户 —— 打开新会话就是撞单检测的触发点。
    // 挂在 scan 上而不是另起定时器：scan 已由 MutationObserver 调度，
    // 复用既省资源，也保证"页面一变就能发现"。
    try { reportIfPeerChanged() } catch (e) {}

    // 换会话：把上一段会话的自动翻译排队与失败冷却一起清掉。
    // 消息 id 只在本会话内有意义，留着只会让新会话的消息被旧冷却误伤。
    const identity = chatIdentity()
    if (identity !== lastScanIdentity) {
      lastScanIdentity = identity
      autoQueue.length = 0
      autoFailedAt.clear()
      // in-flight 标记同样按会话作废：消息 id 只在本会话内有意义，
      // 留着会让新会话里恰好同 id 的消息被永远挡在门外（就像旧冷却误伤那样）。
      // 正在跑的那几条不会因为这次清理而出错 —— 它们各自持着 job 引用，
      // 只是 finally 里的 delete 变成 no-op（本来也已经删不到了）。
      for (const key in autoInFlight) delete autoInFlight[key]
    }

    const nodes = messageNodes()
    // 会话类型 + 取证：判成"群"会把自动翻译交给「群聊自动翻译」开关，
    // 所以"凭哪条证据判的"必须能事后查（0.1.23 真机就是这里判错）。
    const kind = chatKind()
    const group = kind.group
    // groupMode 必须进指纹：不然用户把「群聊翻译」从手动切成自动时，
    // 指纹没变 → 一行 CHAT_KIND 都不会再打，日志里永远停在旧的 manual
    // （2026-10-11 排查就是卡在这里：日志说 manual，实际已经在自动翻）。
    const kindKey = identity + '|' + group + '|' + kind.evidence.source + '|' + groupModeLabel()
    if (kindKey !== lastChatKindKey) {
      lastChatKindKey = kindKey
      trace('CHAT_KIND', {
        tabId: prefs.tabId || '-',
        group: group,
        evidence: kind.evidence.source,
        platform: kind.evidence.platform,
        inMain: kind.evidence.inMain,
        sawGUs: kind.evidence.sawGUs,
        sawCUs: kind.evidence.sawCUs,
        negativePeer: kind.evidence.negativePeer,
        headerText: kind.evidence.headerText,
        // 头部证据的**形状**（词长序列 + 标点骨架），不含人名：
        // 每次真机跑"群 + 私聊"各一次，就能确认/推翻"副标题=成员名单"这条判据。
        headerMarker: kind.evidence.headerMarker,
        headerMarkers: kind.evidence.headerMarkers,
        memberList: kind.evidence.memberList,
        subtitleShape: kind.evidence.subtitleShape,
        headerShape: kind.evidence.headerShape,
        groupMode: groupModeLabel()
      })
    }
    const autoJobs = []
    let chipRemoved = 0
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      const host = hostOf(node)
      const root = messageRoot(node)
      // 正文走解析器：只认真正的用户文本，时间/已读勾/预览卡片/按钮全部挡在外面。
      const parsed = parseScope(node, host)
      const text = parsed.messageText
      if (prefs.antiRevoke) {
        rememberMessage(root, text)
        keepRevoked(root, text)
      }
      if (!text || text.length > 4000) continue
      if (isBusyText(text) || isDeletedText(text)) continue
      // 消息归档：**放在翻译开关判断之前**。
      // 归档和"要不要翻译这条"是两件事 —— 中文消息（includeZh 关闭）、
      // 群聊（transGroup 关闭）同样是需要留档的往来记录，不能因为不翻译就不归档。
      try { reportMessage(node, isOwn(node) ? 'out' : 'in', text) } catch (e) {}
      // 计费决策集中在一处（MessageParser.messageAction，已被真 DOM 用例锁死）：
      //   auto → 自动调翻译接口（唯一会产生字符消耗的分支）
      //   chip → 群聊手动模式，只给按钮
      //   hide → 功能关着 / 没正文，清掉按钮与译文
      const action = MessageParser.messageAction({
        receiveEnabled: !!prefs.transRecv,
        translatable: !!parsed.translatable,
        emojiOnly: isEmojiOnly(text),
        hasChinese: hasChinese(text),
        includeZh: !!prefs.includeZh,
        sameLang: sameLang(text),
        group: group,
        transGroup: !!prefs.transGroup,
        chatKindUnverified: !SITE.chatKindVerified
      })
      if (action === 'auto') {
        // 自动接手 → 手动留下的「译」按钮必须收掉，否则就是"开了自动还挂着按钮"。
        chipRemoved += removeStaleChip(host)
        autoJobs.push({ id: messageIdentity(root, parsed), host: host, parsed: parsed, text: text })
      } else if (action === 'chip') {
        if (isMessageHost(host) && !host.querySelector(':scope > .pix-trans')) addClick(host, true, root, node)
      } else if (isMessageHost(host)) {
        clearExtras(host)
      }
    }
    const dispatched = enqueueAuto(autoJobs)
    if (dispatched || chipRemoved) {
      trace('AUTO_DISPATCH', {
        tabId: prefs.tabId || '-',
        group: group,
        groupMode: groupModeLabel(),
        candidates: autoJobs.length,
        dispatched: dispatched,
        queued: autoQueue.length,
        running: autoRunning,
        chipRemoved: chipRemoved
      })
    }
  }

  function schedule() {
    if (scanTimer) return
    scanTimer = window.setTimeout(() => {
      scanTimer = 0
      scan()
    }, 220)
  }

  async function boot() {
    const pix = api()
    if (pix && pix.onPrefs) pix.onPrefs(applyPrefs)
    if (pix && pix.getPrefs) {
      try { applyPrefs(await pix.getPrefs()) } catch (e) {}
    }
    document.querySelectorAll('#pix-h-btn').forEach(el => el.remove())
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('beforeinput', onBeforeInput, true)
    document.addEventListener('click', onClick, true)
    installImageTranslate(pix)
    schedule()
  }

  /**
   * 安装「翻译图片」按钮。
   *
   * ## 为什么源码要从主进程取，不能直接 require
   *
   * 客页 webPreferences 是 `sandbox: true`（见 src/window/web-view.js）——
   * preload 在这个模式下**只能 require('electron')**，读不到本地的
   * src/translate/image-translate-ui.js。所以源码由主进程读进来、
   * 用 IPC 交给这里。
   *
   * 用 sendSync 而不是 await：boot() 是 async 的，但这里不需要异步 ——
   * 同步拿一次字符串（几十 KB）开销可以忽略，换来的是"安装时机确定"，
   * 不用管 async 竞态。
   *
   * ## 为什么用 new Function 而不是 eval
   *
   * `new Function` 不继承当前作用域，避免和本文件里上百个同名局部变量
   * （prefs / schedule / scan …）撞车。
   *
   * ## 桥怎么交给它
   *
   * 页面里的那一段拿不到 pixBridge（它在 preload 作用域里）。所以先把
   * 回调挂到 window 上，注入的脚本再按名字取。
   * 用带 __pix 前缀的名字，且**只挂这一个函数** —— 不挂 pixBridge 本身，
   * 否则页面 JS 就能直接调所有 IPC。
   */
  function installImageTranslate(pix) {
    try {
      if (!pix || typeof pix.translateImage !== 'function') return
      if (window.__pixImageTranslateInstalled) return

      window.__pixTranslateImage = payload => {
        try {
          return pix.translateImage({ to: (payload && payload.to) || (prefs && prefs.langMine) || 'zh' })
        } catch (e) {
          return Promise.resolve({ success: false, msg: String((e && e.message) || e) })
        }
      }
      window.__pixImageLang = (prefs && prefs.langMine) || 'zh'

      let code = ''
      try {
        code = ipcRenderer.sendSync('translate:imageUiSource') || ''
      } catch (e) {
        code = ''
      }
      if (!code) return
      new Function(code)()
    } catch (e) {
      // 静默失败：这是附加功能，不能因为它拖垮翻译主线。
    }
  }

  const obs = new MutationObserver(schedule)
  const observePage = () => {
    if (document.documentElement) obs.observe(document.documentElement, { childList: true, subtree: true })
  }
  observePage()
  if (!document.documentElement) document.addEventListener('DOMContentLoaded', observePage, { once: true })
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
  return true
})()
