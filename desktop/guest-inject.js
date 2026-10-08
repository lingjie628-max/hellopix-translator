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
  }
}

;(() => {
  if (window.__helloPixChat) return true
  window.__helloPixChat = true

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

  const EMOJI_RE = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\uFE0F\u200D\u20E3])/gu
  let prefs = {
    transRecv: true,
    transSend: true,
    transGroup: false,
    langMine: 'zh',
    langOther: 'auto',
    sendTo: 'en',
    includeZh: false,
    antiRevoke: false
  }
  let scanTimer = 0
  let sendBusy = false
  // 翻译期间被换掉的用户原文。发送前若发现占位符还在输入框里，用它还原。
  let pendingSend = null

  // ---------------------------------------------------------------------------
  // 群聊「手动 / 自动」与历史消息隔离（计费保护）
  //
  // 手动模式下打开群聊曾会**自动翻译满屏历史消息**并在服务端扣字符。两个根因：
  //   1. isGroupChat() 只认 Telegram 的头部文案，WhatsApp 群聊一律判成"非群"，
  //      于是 auto = !group || ... 恒为 true，groupMode=manual 直接被绕过；
  //   2. 即便判成群、即便 auto 开着，scan() 也会把页面上**所有已渲染的**消息
  //      （打开会话时 WhatsApp 会渲染最近几十条）统统翻译一遍，滚动补加载更早的
  //      消息时还继续补翻 —— 用户一个键都没点，字符却在掉。
  //
  // 判定逻辑本身放在 MessageParser 里（messageAction / createHistoryGate），
  // 是纯逻辑、能用真 DOM 用例锁住 —— 计费闸门不该藏在异步扫描循环里没法测。
  //
  // ⚠️ `historyGate` 必须**等到 MessageParser 定义之后**才能初始化。
  // `var MessageParser` 会提升但值是 undefined，在这里调它的方法会立刻抛
  // `TypeError: Cannot read properties of undefined`。而 preload 脚本一抛错就
  // **整份停摆**：下面所有 addEventListener 都不会执行 —— 拦截器、扫描、自动
  // 翻译全部消失，界面却毫无提示（真机上表现为「发送翻译完全失效、原文直接
  // 发出去」）。所以初始化统一挪到解析器模块（BEGIN/END 标记之间那一段的末尾
  // 之后），见下面 `createHistoryGate()` 那一行。
  // ---------------------------------------------------------------------------

  /**
   * 当前会话的容器（WhatsApp 是 `#main`）。
   *
   * 拿不到就返回 null —— **绝不退回整个 document**：左侧会话列表的行也在
   * document 里，且带 `[data-id]`。退回 document 等于把别的会话当成当前会话。
   */
  function conversationScope() {
    return document && typeof document.querySelector === 'function'
      ? document.querySelector('#main')
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
   * 会话身份。用来识别"换会话了"，换会话就要重建历史基线。
   *
   * ## 真机 P0 根因（0.1.11 复现，见 test/group-conversation-identity.test.js）
   *
   * 老实现**先取 `currentPeer()`**，而 `whatsappPeer()` 扫的是**整个 document**
   * 的 `[data-id]`。WhatsApp 左侧会话列表的行也带 `[data-id]`（`@c.us`），
   * 而且排在 `#main` 之前 —— 群聊里身份因此取到"左侧列表里某个私聊"，
   * 根本不是当前会话。列表每来一条消息就会重排，身份跟着变
   * → `historyGate.begin()` 每轮都判定"换会话了"并重置
   * → `ready` 恒为 false → `isHistoric()` 对**每条**消息都返回 true
   * → `messageAction()` 一律给 `chip`
   * → **「群组翻译 = 自动」永不生效**（手动「译」按钮还在，所以只表现为"自动不翻"）。
   *
   * 这也是 0.1.11 才暴露的：修好 `isGroupChat()` 让 WhatsApp 群聊真正被判成群之后，
   * 历史基线闸门才第一次对群聊生效（此前 `group=false` 整个绕过了它）。
   *
   * 所以身份必须**只认当前会话**。拿不到就退回头部标题/URL ——
   * 宁可多重建几次基线（更保守），也不能取到别的会话的身份。
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
      user-select: text;
    }
    .message-in .pix-trans, .message-list-item:not(.own) .pix-trans {
      border-top-color: rgba(255,255,255,.12);
    }
    .pix-click {
      display: inline-block;
      clear: both;
      margin-top: 6px;
      padding: 2px 8px;
      border-radius: 8px;
      background: rgba(255,255,255,.12);
      font-size: 12px;
      cursor: pointer;
      user-select: none;
      /* 真机可点击性：WhatsApp 的消息层在若干状态下会关掉 pointer-events，
         继承下来按钮就"看得见、点不动"。这里显式打开并抬一层，避免被
         消息气泡的覆盖层挡掉。 */
      pointer-events: auto !important;
      position: relative;
      z-index: 2;
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
      engine: next.engine || ''
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
      '.pix-trans', '.pix-click', '.pix-kept', '.pix-revoked'
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
     * 收集真正的正文候选：`.selectable-text`，且不落在预览卡片 / 引用块里。
     *
     * 只认这个标记是有意的 —— WhatsApp 把"用户可选中的文本"都打了它，
     * 而时间、勾、卡片文案、按钮都没有。找不到就是没有正文，返回空。
     * 外层若已收录，内层直接跳过（外层的 textContent 已含内层）。
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
      return out
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
      var masked = maskUrls(parsed.messageText)
      var out = {}
      for (var key in parsed) if (Object.prototype.hasOwnProperty.call(parsed, key)) out[key] = parsed[key]
      out.urls = masked.urls
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
     * 判定顺序：先看功能与内容（该不该有译文），再看模式（能不能自动翻）。
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
      // 群聊 + 手动：一条都不自动翻，只给按钮
      if (s.group && !s.transGroup) return 'chip'
      // 群聊 + 历史消息（打开会话之前就在的，或滚动补加载出来的）：只给按钮。
      // 「自动」只对**打开会话之后新到达**的消息生效 —— 否则一进群就满屏扣费。
      if (s.group && s.historic) return 'chip'
      return 'auto'
    }

    /**
     * 群聊「历史 / 新消息」判定闸。
     *
     * 两条独立证据取并集，宁可漏翻、绝不误扣：
     *   - 打开会话那一刻已经在页面上的消息（基线未就绪 → 一律算历史）；
     *   - 消息自带时间戳明显早于打开时刻（挡住滚动补加载出来的旧消息）。
     *
     * 时间戳只精确到分钟（WhatsApp 的 `[3:25 PM, 9/25/2026]`），所以留 `graceMs`
     * 余量，免得把"刚刚到的那条"误判成历史。
     */
    function createHistoryGate(options) {
      var opts = options || {}
      var graceMs = typeof opts.graceMs === 'number' ? opts.graceMs : 90000
      var cap = typeof opts.cap === 'number' ? opts.cap : 5000
      var stamp = ''
      var ready = false
      var watermark = 0
      var keys = Object.create(null)
      var count = 0

      function size() { return count }

      return {
        /** 换会话就重建基线。返回 true 表示"基线尚未就绪 = 首轮"。 */
        begin: function (identity, now) {
          if (String(identity) !== stamp) {
            stamp = String(identity)
            keys = Object.create(null)
            count = 0
            watermark = number(now)
            ready = false
          }
          return !ready
        },
        /** 基线没就绪（首轮）一律算历史：打开会话时的满屏消息绝不能自动翻。 */
        isHistoric: function (id, sentAt) {
          if (!ready) return true
          if (keys[id]) return true
          var when = number(sentAt)
          return when > 0 && when < watermark - graceMs
        },
        /** 登记已见过的消息：之后的重扫就当它已经是"旧消息"。 */
        remember: function (id) {
          if (!id || keys[id]) return
          keys[id] = 1
          count++
          if (count > cap) { keys = Object.create(null); count = 0 }
        },
        /** 首轮扫描结束。只有确实扫到了消息才算基线就绪。 */
        settle: function (sawMessages) { if (sawMessages) ready = true },
        snapshot: function () { return { stamp: stamp, ready: ready, watermark: watermark, size: count } }
      }
    }

    function number(value) {
      var n = Number(value)
      return Number.isFinite(n) ? n : 0
    }

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
      extractUrls: extractUrls,
      hasTranslatableText: hasTranslatableText,
      detectPlatform: detectPlatform,
      parseMessage: parseMessage,
      parseForTranslation: parseForTranslation,
      messageAction: messageAction,
      createHistoryGate: createHistoryGate
    }
  })()
  // ==== MESSAGE PARSER END ====

  /**
   * 历史消息闸门。**必须在 MessageParser 定义之后**初始化 —— 见文件上方
   * 「群聊手动/自动与历史消息隔离」那段注释：`var` 提升会让提前调用静默炸掉
   * 整份 preload 脚本。
   */
  const historyGate = MessageParser.createHistoryGate()

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

  function hasChinese(text) {
    return /[\u4e00-\u9fff]/.test(String(text || ''))
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
    if (!parsed || !parsed.translatable) return ''
    const out = await translateText(parsed.sourceText, incoming, trigger)
    if (!out) return ''
    return MessageParser.restoreUrls(out, parsed.urls)
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
    return Array.from(document.querySelectorAll(
      '.message-list-item .text-content, .Message .text-content, div.message-in span.selectable-text, div.message-out span.selectable-text, div.copyable-text span.selectable-text'
    ))
  }

  function isOwn(node) {
    return !!(node.closest('.own') || node.closest('.message-out'))
  }

  /**
   * 当前会话是不是群聊。
   *
   * 这个判定直接决定计费：`auto = !group || prefs.transGroup`，
   * 判成"非群"就等于把「群组翻译 = 手动」整个绕过。
   *
   * 老实现只认 Telegram 头部里的 members / 位成员 / 群组 文案。WhatsApp 的
   * 头部是群名 + 成员昵称，**根本不含这些词**，于是 WhatsApp 群聊一律被判成
   * 非群 → 手动模式失效 → 打开群聊就满屏自动翻译并扣字符（线上计费 P0）。
   *
   * 现在优先用**结构性证据**：WhatsApp 把会话类型编进了消息的 data-id，
   *   false_8613800138000@c.us_3EB0ABC   ← 个人
   *   true_1203630199xxxx@g.us_3EB0ABC   ← 群
   * 只扫 `#main`（会话区）里的消息行，**不扫左侧会话列表** ——
   * 列表里混着别的群，扫它会把每个一对一会话都误判成群。
   */
  function isGroupChat() {
    const info = document.querySelector('.ChatInfo, header')
    const text = ((info && info.innerText) || '').slice(0, 400)
    if (/members|subscribers|位成员|位订阅|群组/i.test(text)) return true

    const scope = document.querySelector('#main') || document
    const rows = scope.querySelectorAll('[data-id]')
    for (let i = 0; i < rows.length && i < 200; i++) {
      const raw = String(rows[i].getAttribute('data-id') || '')
      if (raw.indexOf('@g.us') >= 0) return true
    }
    // WhatsApp 群聊头部会带 "点击查看群组成员" 之类的 aria-label
    if (scope.querySelector('[data-testid*="group" i], [aria-label*="group" i]')) return true
    return false
  }

  function hostOf(node) {
    return node.closest('.text-content') ||
      node.closest('div.copyable-text') ||
      node.closest('[data-testid="msg-container"]') ||
      node
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

  function detectLang(text) {
    const s = String(text || '')
    if (/[\u4e00-\u9fff]/.test(s)) return 'zh'
    if (/[\u3040-\u30ff]/.test(s)) return 'ja'
    if (/[\uac00-\ud7af]/.test(s)) return 'ko'
    if (/[\u0e00-\u0e7f]/.test(s)) return 'th'
    if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s)) return 'vi'
    return 'en'
  }

  function sameLang(text) {
    return detectLang(text) === (prefs.langMine || 'zh')
  }

  function clearExtras(host) {
    host.querySelectorAll(':scope > .pix-trans, :scope > .pix-click').forEach(el => el.remove())
  }

  /** 只清译文框，**保留「译」按钮** —— 没有可画的译文时不该把按钮一起删掉。 */
  function clearTransBox(host) {
    host.querySelectorAll(':scope > .pix-trans').forEach(el => el.remove())
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
    // 必须在会话区 #main 内 —— 左侧会话列表里的节点不是消息气泡。
    const main = doc && doc.getElementById('main')
    if (main && !main.contains(el)) return false
    // 真正的消息气泡一定挂在带 data-id 的消息行内（WhatsApp 的结构性证据）。
    return !!el.closest('[data-id]')
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
    TRANSLATE_FAILED: '翻译服务暂不可用，请稍后重试'
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
  const SEND_BUSY_TEXT = '正在翻译…（翻译期间不会发送任何内容）'

  function showSendBusy() {
    try {
      const doc = typeof document === 'undefined' ? null : document
      if (!doc || !doc.body) return
      if (doc.getElementById(SEND_BUSY_ID)) return
      const el = doc.createElement('div')
      el.id = SEND_BUSY_ID
      // 和我们的其它 UI 一样打标记：绝不能进采集、解析、发送链。
      el.setAttribute('data-pix-ui', 'send-busy')
      el.textContent = SEND_BUSY_TEXT
      el.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'left:50%', 'bottom:24px',
        'transform:translateX(-50%)', 'max-width:min(92vw,440px)',
        'padding:10px 14px', 'border-radius:10px', 'box-sizing:border-box',
        'background:rgba(24,24,27,.96)', 'color:#fff', 'font-size:13px',
        'line-height:1.5', 'font-family:inherit', 'text-align:center',
        'box-shadow:0 10px 30px rgba(0,0,0,.34)', 'pointer-events:none'
      ].join(';')
      doc.body.appendChild(el)
    } catch (e) {}
  }

  function hideSendBusy() {
    try {
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

      const acts = doc.createElement('div')
      acts.style.cssText = 'display:flex;gap:8px'

      const retry = noticeButton('重试翻译', function () {
        hideSendFailureNotice()
        // 用户可能在失败后又改了输入框：以**当前内容**为准重新走一遍。
        const now = readComposer(box).trim() || raw
        const again = MessageParser.maskUrls(stripEmoji(now))
        if (!again.masked || !MessageParser.hasTranslatableText(again.masked)) {
          // 内容已经变得不需要翻译了：不再自动发，交给用户自己按发送。
          showSendFailureNotice(box, raw, masked, {
            title: '重试失败',
            hint: '当前内容已不需要翻译，请直接按发送'
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
                hideSendFailureNotice()
                return
              }
              // 失败时 deliverSend 已弹过默认提示；这里把标题改成明确的「重试失败」，
              // 让用户知道"这一下又没成"，而不是对着同一个提示发懵。
              showSendFailureNotice(box, raw, masked, {
                title: '重试失败',
                hint: SEND_FAIL_HINT
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
        // 用户明确点击才允许发未翻译的原文。同样要**写回 + 回读校验** ——
        // 真机上"发送原文"把占位符一并发出去过（用户从没同意发占位符）。
        //
        // 关键：先把上一次翻译留下的状态解掉。否则 fireSendUserAuthorized 之外
        // 的任何状态机残留都可能把这一下也当成 STALE_ACTION 拦掉。
        pendingSend = null
        sendBusy = false
        hideSendBusy()
        if (!writeAndVerify(box, raw)) {
          blockSend('BODY_MISMATCH', box, raw, masked)
          return
        }
        wait(50).then(function () {
          const fired = fireSendUserAuthorized(box, raw, 'send_raw')
          if (!fired.ok) blockSend(fired.reason, box, raw, masked)
        })
      })
      sendRaw.style.cssText += ';background:rgba(255,255,255,.14);color:#fff'

      acts.appendChild(retry)
      acts.appendChild(sendRaw)
      wrap.appendChild(title)
      wrap.appendChild(hint)
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
    const cleaned = stripEmoji(MessageParser.stripBusy(text))
    if (!cleaned) return Promise.resolve({ ok: false, code: 'EMPTY_TEXT', out: '' })
    const key = (incoming ? 'in:' : 'out:') + cleaned
    if (cache.has(key)) return Promise.resolve({ ok: true, out: cache.get(key), code: '', cached: true })
    if (pending.has(key)) return pending.get(key)
    const pix = api()
    if (!pix || !pix.translate) return Promise.resolve({ ok: false, code: 'NO_BRIDGE', out: '' })
    const job = pix.translate({ text: cleaned, incoming: incoming, trigger: trigger || '' }).then(resp => {
      pending.delete(key)
      // 余额不足 / 通道不在套餐里之类：必须弹提示，不能表现成"没译文"。
      if (resp && resp.success === false) {
        notifyTranslateIssue(resp)
        return { ok: false, code: String((resp && resp.code) || 'TRANSLATE_FAILED'), out: '' }
      }
      const out = String((resp && (resp.translation || resp.text)) || '').trim()
      if (out) cache.set(key, out)
      return { ok: !!out, code: out ? '' : 'EMPTY_RESULT', out: out }
    }).catch(err => {
      pending.delete(key)
      // 走到这里说明 IPC/线路层面就断了（服务端错误已在上面 return）。
      // 同样不能静默：用户看到的表现和"翻译坏了"一模一样。
      notifyTranslateIssue({ code: 'TRANSLATE_FAILED', msg: (err && err.message) || '' })
      return { ok: false, code: 'TRANSLATE_FAILED', out: '' }
    })
    pending.set(key, job)
    return job
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
  function paint(host, translated, original) {
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
    if (!box) {
      box = document.createElement('div')
      box.className = 'pix-trans'
      const meta = host.querySelector(':scope > .MessageMeta, :scope > .message-time')
      if (meta) host.insertBefore(box, meta)
      else host.appendChild(box)
    }
    box.textContent = translated
    // ★ 只有真的画出了译文，才把「译」按钮移除 ★
    const click = host.querySelector(':scope > .pix-click')
    if (click) click.remove()
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
    const id = root.getAttribute('data-id')
    if (id) return { attr: 'data-id', value: id }
    const pre = root.getAttribute('data-pre-plain-text')
    if (pre) return { attr: 'data-pre-plain-text', value: pre }
    return null
  }

  /** 按稳定 key 重新查当前气泡 —— 绝不长期持有裸 DOM 引用。 */
  function findRowByKey(key) {
    if (!key || !key.attr || !key.value) return null
    let nodes
    try { nodes = document.querySelectorAll('[' + key.attr + ']') } catch (e) { return null }
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute(key.attr) === key.value) return nodes[i]
    }
    return null
  }

  function chipKey(chip) {
    return {
      attr: chip.getAttribute('data-pix-key-attr') || '',
      value: chip.getAttribute('data-pix-key') || ''
    }
  }

  /** 把 chip 的可见状态改掉 —— 成功/失败都必须看得出来，绝不允许"什么都没发生"。 */
  function chipStateOf(chip) {
    return (chip && chip.getAttribute('data-pix-state')) || 'idle'
  }

  function setChipState(chip, state) {
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
      chip.textContent = '翻译失败 · 点击重试'
      chip.style.pointerEvents = 'auto'
    } else {
      chip.textContent = '译'
      chip.style.pointerEvents = 'auto'
    }
    chip.setAttribute('data-pix-state', state || 'idle')
  }

  /** 在（可能已经换过的）当前气泡里找到我们的 chip。 */
  function chipIn(key, fallback) {
    const row = findRowByKey(key)
    if (row) {
      const host = hostOf(row)
      const found = host && host.querySelector(':scope > .pix-click')
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
    const leaveBusy = (next) => { leftBusy = true; setChipState(chipIn(key, chip), next) }
    try {
      return await manualTranslateInner(chip, key, incoming, leaveBusy)
    } catch (err) {
      // 任何一步抛错都不许静默：留痕 + 可见失败 + 可重试。
      trace('MANUAL_CLIENT_EXCEPTION', { error: (err && err.message) || String(err) })
      leaveBusy('fail')
      notifyTranslateIssue({ code: 'MANUAL_FAILED', msg: '翻译请求异常，请重试' })
      return
    } finally {
      // 兜底：内部若因为任何原因没显式收口，这里强制离开 busy。
      // 「永久停在翻译中…」是本轮明令禁止的状态。
      if (!leftBusy && chipStateOf(chipIn(key, chip)) === 'busy') {
        trace('MANUAL_CHAIN_FORCED_RESOLVE', { messageId: key.value || '-' })
        setChipState(chipIn(key, chip), 'fail')
      }
    }
  }

  async function manualTranslateInner(chip, key, incoming, leaveBusy) {
    let row = findRowByKey(key)
    trace('MANUAL_TRANSLATE_CLICK', {
      action: 'manual_click',
      messageId: key.value || '-',
      keyAttr: key.attr || '-',
      tabId: prefs.tabId || '-',
      partition: prefs.partition || '-',
      engine: prefs.engine || '-',
      incoming: incoming,
      rowFound: !!row
    })

    // ---- 第一步：定位气泡 ----
    if (!row) {
      trace('MANUAL_ROW_LOST', { messageId: key.value || '-' })
      leaveBusy('fail')
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
      leaveBusy('fail')
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
      leaveBusy('fail')
      return
    }

    // ---- 第四步：用稳定 key 重新定位再渲染 ----
    const translated = MessageParser.restoreUrls(res.out, parsed.urls)
    const curRow = findRowByKey(key)
    if (!curRow) {
      trace('TRANSLATION_RENDER_TARGET_MISSING', { messageId: key.value || '-' })
      leaveBusy('fail')
      notifyTranslateIssue({ code: 'MANUAL_RENDER_MISSED', msg: '译文已生成，但这条消息已滚出视图，滚回去即可看到' })
      return
    }
    const host = hostOf(curRow)
    // ★ 硬约束（#4）★ 找不到宿主就**绝不绘制**。老实现一旦 host 取到聊天根节点，
    //   译文就会被 append 到聊天区域底部（真机复现过）。宁可不显示。
    if (!host || !isMessageHost(host)) {
      trace('TRANSLATION_RENDER_TARGET_MISSING', { messageId: key.value || '-', reason: 'host_unresolved' })
      leaveBusy('fail')
      notifyTranslateIssue({ code: 'MANUAL_RENDER_MISSED', msg: '没能定位到这条消息的气泡，未显示译文' })
      return
    }
    trace('TARGET_RELOCATED', { messageId: key.value || '-', byKey: key.attr || '-' })
    const drew = paint(host, translated, displayText(parsed, ''))
    trace('TRANSLATION_RENDERED', {
      chain: 'receive',
      messageId: key.value || '-',
      chars: translated.length,
      drew: drew
    })
    if (drew) leaveBusy('done')
    else leaveBusy('fail')
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
      setChipState(chip, 'fail')
      notifyTranslateIssue({ code: 'MANUAL_FAILED', msg: '翻译请求异常，请重试' })
    }
    return true
  }
  // ==== MANUAL CHIP END ====

  function addClick(host, incoming, root) {
    if (host.querySelector(':scope > .pix-trans, :scope > .pix-click')) return
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
    chip.textContent = '译'
    const meta = host.querySelector(':scope > .MessageMeta, :scope > .message-time')
    if (meta) host.insertBefore(chip, meta)
    else host.appendChild(chip)
    trace('MANUAL_CHIP_RENDERED', {
      messageId: (key && key.value) || '-',
      tabId: prefs.tabId || '-',
      incoming: !!incoming
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

  function composerEl() {
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
    const ae = document.activeElement
    if (ae && visible(ae) && (ae.isContentEditable || ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) {
      if (!ae.closest('header, [role="search"], [data-testid="chat-list-search"]')) return ae
    }
    return null
  }

  function readComposer(el) {
    if (!el) return ''
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return String(el.value || '')
    return String(el.innerText || el.textContent || '')
  }

  function writeComposer(el, text) {
    if (!el) return
    el.focus()
    const value = String(text || '')
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && desc.set) desc.set.call(el, value)
      else el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return
    }
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    sel.removeAllRanges()
    sel.addRange(range)
    const ok = document.execCommand('insertText', false, value)
    if (!ok) {
      el.textContent = value
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
    }
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
    const forApi = stripEmoji(trimmed)
    if (!forApi) return null
    // URL 抽出来单独保管：翻译时用占位符顶替，发出去的时候原样放回 ——
    // 网址一旦被模型改写就点不开了。纯 URL 消息直接原样发送，不调翻译接口。
    const masked = MessageParser.maskUrls(forApi)
    if (!MessageParser.hasTranslatableText(masked.masked)) return null
    if (detectLang(masked.masked) === (prefs.sendTo || 'en')) return null
    // 到这里才真正决定"拦下并翻译"。状态机从这一刻开始，trace 走同一 actionId。
    sendActionId = newSendActionId()
    sendActionPhase = 'captured'
    trace('SEND_CAPTURED', { via: (event && event.type) || '-', chars: raw.length })
    blockEvent(event)
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
   * `decideIntercept` 里的每一步 —— `readComposer`、`detectLang`、
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
        masked = MessageParser.maskUrls(stripEmoji(MessageParser.stripBusy(raw)))
      } catch (e) {}
      writeComposer(box, MessageParser.stripBusy(raw))
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
    trace('TRANSLATE_STARTED', { chain: 'send', trigger: TRIGGER_SEND })
    let out = ''
    try {
      out = await translateText(masked.masked, false, TRIGGER_SEND)
    } catch (e) {
      out = ''
    }
    if (!out) {
      // D：翻译失败 → **一个字节都不发**。原文本来就在输入框里（我们没动过它），
      //    这里再写一次只是兜底，然后弹可操作的提示。
      pendingSend = null
      sendBusy = false
      hideSendBusy()
      // 但兜底之前必须先看草稿：用户可能已经在打下一条。拿原文硬写回，
      // 等于把他正在打的内容整段吃掉（真机已复现，属数据丢失）。
      if (composerDraftChanged(box, raw)) trace('DRAFT_PRESERVED', { at: 'translate_failed' })
      else writeComposer(box, raw)
      trace('TRANSLATE_FAILED', { chain: 'send', failClosed: true })
      showSendFailureNotice(box, raw, masked)
      return false
    }
    const finalText = out === masked.masked
      ? raw
      : MessageParser.restoreUrls(out, masked.urls)
    hideSendBusy()
    sendActionPhase = 'succeeded'
    trace('TRANSLATE_SUCCEEDED', { chain: 'send', chars: finalText.length })
    try {
      // 「再次确认当前 sendAction 仍有效」—— 异步等待期间状态可能已经变了
      // （例如用户又按了一次、或失败提示已被处理）。状态不对就不发。
      if (sendActionPhase !== 'succeeded') {
        blockSend('STALE_ACTION', box, raw, masked)
        return false
      }
      // B + C：成功才写回 → **回读校验** → 校验通过才发，且只发一次。
      // 回读是必须的：托管编辑器可能根本没接受我们的写入（而 execCommand 照样
      // 返回 true）。不校验就会出现"界面显示译文、实际发出原文"或"原文+占位符"。
      //
      // ★ 写回之前先抓草稿 ★：用户在等翻译这段时间很可能已经开始打**下一条**。
      //   无条件覆盖会把那段内容整段吃掉 —— 真机上就是"我打了一半，自己没了"。
      //   有草稿就先存下来，发完译文再放回去。
      const draftNow = readComposer(box)
      const keepDraft = composerDraftChanged(box, raw)
      if (keepDraft) trace('DRAFT_PRESERVED', { at: 'before_replace', chars: draftNow.length })
      if (!writeAndVerify(box, finalText)) {
        blockSend('BODY_MISMATCH', box, raw, masked)
        return false
      }
      sendActionPhase = 'replaced'
      trace('INPUT_REPLACED', { chars: finalText.length, draftChars: keepDraft ? draftNow.length : 0 })
      await wait(50)
      // 发送前最后一次正文校验 —— 独立于 writeAndVerify 的回读，专门对"这一段
      // 等待期间正文又被改掉/占位符渗入"负责。事件名按收口规范固定为
      // FINAL_TEXT_VALIDATED，真机取证时可以直接用它作为"这道闸跑过"的证据。
      const finalGate = sendableBody(box, finalText)
      trace('FINAL_TEXT_VALIDATED', {
        ok: finalGate.ok,
        reason: finalGate.reason || '',
        chars: String(finalGate.actual || '').length
      })
      if (!finalGate.ok) {
        blockSend(finalGate.reason, box, raw, masked)
        return false
      }
      const fired = fireSendVerified(box, finalText)
      if (!fired.ok) {
        blockSend(fired.reason, box, raw, masked)
        return false
      }
      // 译文发出去之后，把用户正在打的下一条放回输入框。
      // 放不回去必须**明说** —— 静默丢失用户内容是最不可接受的失败方式。
      if (keepDraft) {
        if (writeAndVerify(box, draftNow)) {
          trace('DRAFT_RESTORED', { chars: draftNow.length })
        } else {
          trace('DRAFT_RESTORE_FAILED', { chars: draftNow.length })
          notifyTranslateIssue({
            code: 'DRAFT_RESTORE_FAILED',
            msg: '你刚才在打的下一条内容没能放回输入框，请检查后重新输入'
          })
        }
      }
    } catch (e) {
      blockSend('EXCEPTION', box, raw, masked)
      return false
    } finally {
      pendingSend = null
      sendBusy = false
      hideSendBusy()
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
   * 输入框里是不是已经被用户改成了**别的**内容（在等翻译期间打了下一条）。
   *
   * 这是"写回译文 / 还原原文"之前必须先问的一句话：
   *   - 内容仍等于我们捕获的原文 → 正常路径，随便覆盖。
   *   - 内容变了 → 用户正在打新消息，我们**没有资格**覆盖它。
   *
   * 老实现从不问这句话，于是翻译一回来就把用户草稿整段吃掉（真机复现）。
   */
  function composerDraftChanged(box, raw) {
    return normalizeBody(readComposer(box)) !== normalizeBody(raw)
  }

  /**
   * 把正文写进输入框，并**回读校验**。写两次仍不一致就返回 false。
   *
   * 为什么不能只写不校验：`writeComposer` 是在 React/Lexical 托管编辑器背后改
   * DOM。它成功与否，调用方**拿不到信号** —— `execCommand` 即使什么都没写进去
   * 也返回 true，`if (!ok)` 那条兜底永远不会触发。真机事故里占位符就是这样
   * "写进去了、清不掉、然后被原样发出去"。
   */
  function writeAndVerify(box, text) {
    for (let i = 0; i < 2; i++) {
      writeComposer(box, text)
      if (normalizeBody(readComposer(box)) === normalizeBody(text)) return true
    }
    return false
  }

  /**
   * 发送前的最后一道闸（fail-closed）—— **不受 suppression 影响**。
   *
   * 老实现里 `onClick` / `onKeyDown` 都是**先看 suppression、再跑 guardBusySend**，
   * 而 `fireSend()` 恰恰会把 suppression 置真。于是"我们自己发起的那一次发送"
   * 正好把唯一能拦住占位符的闸关掉了 —— 这就是占位符出网的最后一步。
   *
   * 现在这一闸独立于一切开关：正文里只要还挂着占位符，或者正文不是我们打算
   * 发的那份译文，就**不发**。
   */
  function sendableBody(box, expected) {
    const actual = readComposer(box)
    if (MessageParser.hasBusy(actual)) {
      return { ok: false, reason: 'BUSY_MARK', actual: actual }
    }
    if (expected != null && normalizeBody(actual) !== normalizeBody(expected)) {
      return { ok: false, reason: 'BODY_MISMATCH', actual: actual }
    }
    return { ok: true, actual: actual }
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
      trace('SEND_BLOCKED_' + gate.reason, { chars: String(gate.actual || '').length })
      return gate
    }
    // 真机取证用：把**实际要发出去的正文**记进客户端日志。
    // 排查"对方收到的和我以为的不一样"时，没有这一行只能靠猜。
    console.info('[Hello Pix] 发送翻译 · 最终正文=' + JSON.stringify(gate.actual) + ' · trigger=manual_send')
    sendActionPhase = 'sending'
    trace('PROGRAMMATIC_SEND_BEGIN', { chars: gate.actual.length })
    fireSend(box)
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
    try { writeComposer(box, raw) } catch (e) {}
    try { scrubBusy(box, raw) } catch (e) {}
    console.error('[Hello Pix] BLOCKED_' + reason + '：翻译状态异常，消息未发送')
    trace('SEND_FAIL_CLOSED', { reason: reason })
    showSendFailureNotice(box, raw, masked, {
      title: '翻译状态异常，消息未发送',
      hint: '为避免发出未翻译或带占位符的内容，这一条已拦下。对方没有收到任何内容。'
    })
  }

  /** 输入框里还挂着占位符就把它抹掉，换成给定文本。发送前的最后一道复核。 */
  function scrubBusy(box, fallback) {
    if (!box) return
    if (!MessageParser.hasBusy(readComposer(box))) return
    writeComposer(box, String(fallback == null ? '' : fallback))
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
    // 翻译流程已结束而占位符还在（写回失败 / 被打断）：还原成用户原文再发
    const pending = pendingSend && pendingSend.box === box ? pendingSend.raw : ''
    writeComposer(box, pending || MessageParser.stripBusy(text))
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
    const box = composerEl()
    if (!box || !eventInComposer(event, box)) return
    safeIntercept(event, box)
  }

  function onBeforeInput(event) {
    if (eventIsOwnUi(event)) return
    if (event.inputType === 'insertParagraph' && guardBusySend(event)) return
    if (!prefs.transSend) return
    if (suppression) return
    if (event.inputType !== 'insertParagraph') return
    const box = composerEl()
    if (!box || !eventInComposer(event, box)) return
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
    if (!looksLikeSend(event.target)) return
    const box = composerEl()
    if (!box) return
    if (!readComposer(box).trim()) return
    safeIntercept(event, box)
  }

  const DELETED_RE = /^(this message was deleted\.?|you deleted this message\.?|此消息已删除|你删除了这条消息|你已删除此消息|esta mensagem foi apagada|este mensaje fue eliminado|ce message a été supprimé|diese nachricht wurde gelöscht|pesan ini telah dihapus)$/i
  const revokeMap = new Map()

  function messageRoot(node) {
    return node.closest('[data-id]') ||
      node.closest('[data-testid="msg-container"]') ||
      hostOf(node)
  }

  function messageKey(root) {
    if (!root) return ''
    return root.getAttribute('data-id') || root.getAttribute('data-pre-plain-text') || ''
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

  async function scan() {
    // 每次扫描顺带看一眼是不是换了客户 —— 打开新会话就是撞单检测的触发点。
    // 挂在 scan 上而不是另起定时器：scan 已由 MutationObserver 调度，
    // 复用既省资源，也保证"页面一变就能发现"。
    try { reportIfPeerChanged() } catch (e) {}

    // 换会话就重建历史基线：**打开会话那一刻在页面上的消息全部是历史**。
    // 基线就绪之前一律按历史处理 —— 宁可让用户点一下，
    // 也不能把满屏历史消息当"新消息"自动翻掉并扣字符。
    historyGate.begin(chatIdentity(), Date.now())

    const nodes = messageNodes()
    const group = isGroupChat()
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
      // 群聊判定"历史"：只有打开会话之后**新到达**的消息才允许自动翻。
      let historic = false
      if (group) {
        const id = messageIdentity(root, parsed)
        historic = historyGate.isHistoric(id, Date.parse(messageTime(root) || '') || 0)
        historyGate.remember(id)
      }
      // 计费决策集中在一处（MessageParser.messageAction，已被真 DOM 用例锁死）：
      //   auto → 自动调翻译接口（唯一会产生字符消耗的分支）
      //   chip → 手动模式或历史消息，只给按钮
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
        historic: historic
      })
      if (action === 'auto') {
        // 翻译失败时**不清**已有译文框：一次网络抖动不该把上面那条好好的译文抹掉。
        const translated = await translateParsed(parsed, true, TRIGGER_AUTO)
        if (translated) paint(host, translated, text)
      } else if (action === 'chip') {
        if (isMessageHost(host) && !host.querySelector(':scope > .pix-trans')) addClick(host, true, root)
      } else if (isMessageHost(host)) {
        clearExtras(host)
      }
    }
    // 首轮扫描结束：此后出现的消息才算"新消息"。
    historyGate.settle(nodes.length > 0)
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
    schedule()
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
