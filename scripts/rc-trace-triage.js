'use strict'

/**
 * 真机 trace 分诊：把客户端日志里的 manual_click（点「译」）与 manual_send（发送翻译）
 * 两条链**分别**还原成事件时间线，并直接判定断在哪一步。
 *
 * 用法：
 *   node scripts/rc-trace-triage.js                        # 自动找今天的客户端日志
 *   node scripts/rc-trace-triage.js /path/to/hello-pix-2026-10-07.log
 *   cat some.log | node scripts/rc-trace-triage.js -
 *
 * 只读，不改任何东西。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TRACE_RE = /\[PIX_TRACE\]\s+(\w+)\s*(\{.*\})?\s*$/

/** 点译（manual_click）的期望顺序。 */
const MANUAL_ORDER = ['MANUAL_TRANSLATE_CLICK', 'SOURCE_EXTRACTED', 'TRANSLATE_STARTED', 'TRANSLATE_SUCCEEDED', 'TARGET_RELOCATED', 'TRANSLATION_RENDERED']
/** 发送翻译（manual_send）的期望顺序。 */
const SEND_ORDER = ['SEND_CAPTURED', 'NATIVE_SEND_BLOCKED', 'SOURCE_SNAPSHOTTED', 'TRANSLATE_STARTED', 'TRANSLATE_SUCCEEDED', 'INPUT_REPLACED', 'FINAL_TEXT_VALIDATED', 'PROGRAMMATIC_SEND_BEGIN', 'PROGRAMMATIC_SEND_DONE']
/**
 * 「Chromium 原生输入」链的期望顺序（0.1.19 起，发送翻译的唯一写入口）。
 *
 * 真机 0.1.18 把根因钉死在**事件可信性**上：页面内改 DOM（execCommand /
 * textContent）产生的是 untrusted 事件，WhatsApp/Lexical 在捕获阶段直接过滤掉，
 * EditorState 从未更新 → 下一次调和把正文盖回原文 → BODY_MISMATCH。
 *
 * 0.1.19 改为从 Electron 主进程发 Chromium 原生编辑命令，事件是 trusted 的，
 * 编辑器必须认。这条顺序一旦完整，就证明写入真的进了编辑器输入管线。
 * 只要日志里出现过 NATIVE_INPUT_BEGIN，就按这条顺序要求（缺失即断点）。
 */
const NATIVE_ORDER = ['NATIVE_INPUT_BEGIN', 'COMPOSER_CLEARED', 'NATIVE_TEXT_INSERTED', 'LEXICAL_SETTLED', 'INPUT_REPLACED', 'FINAL_TEXT_VALIDATED', 'PROGRAMMATIC_SEND_BEGIN', 'PROGRAMMATIC_SEND_DONE']
/**
 * 「重试翻译」的期望顺序（0.1.17 起）。
 *
 * 真机 P0-1：翻译异常 → 点「重试翻译」→ 最终「重试失败」。所以重试必须能被
 * 单独分诊：从 RETRY_TRANSLATE_CLICK 一路走到 PROGRAMMATIC_SEND_DONE，
 * 中间任何一环断掉都能指出是哪一步。
 */
const RETRY_ORDER = ['RETRY_TRANSLATE_CLICK', 'RETRY_TRANSLATE_RESULT']

/**
 * 事件名归一化。
 *
 * 本轮按收口规范把接收链的 trace 改名（MANUAL_PARSED → SOURCE_EXTRACTED 等）。
 * 但用户手上可能还留着**旧版本客户端**导出的 rc 取证文件，分诊脚本必须同时
 * 认得两套名字 —— 否则拿旧日志来跑会误报"缺少事件"。这里统一归一到新名。
 */
const EVENT_ALIAS = {
  MANUAL_PARSED: 'SOURCE_EXTRACTED',
  MANUAL_REQUEST: 'TRANSLATE_STARTED',
  MANUAL_RESPONSE: 'TRANSLATE_SUCCEEDED',
  MANUAL_RENDERED: 'TRANSLATION_RENDERED',
  MANUAL_RENDER_MISSED: 'TRANSLATION_RENDER_TARGET_MISSING',
  MANUAL_FAILED: 'TRANSLATE_FAILED'
}

function defaultLogPath () {
  const roots = [
    path.join(os.homedir(), 'Library', 'Application Support', 'Hello Pix', 'logs'),
    path.join(os.homedir(), 'Library', 'Application Support', 'hello-pix-desktop', 'logs')
  ]
  for (const dir of roots) {
    let names
    try { names = fs.readdirSync(dir) } catch (e) { continue }
    const logs = names.filter(n => /^hello-pix-.*\.log(\.\d+)?$/.test(n)).sort()
    if (logs.length) return path.join(dir, logs[logs.length - 1])
  }
  return null
}

function readInput (argv) {
  const arg = argv[2]
  if (arg === '-') return fs.readFileSync(0, 'utf8')
  const file = arg || defaultLogPath()
  if (!file) {
    console.error('找不到客户端日志。请显式传入路径，例如：')
    console.error('  node scripts/rc-trace-triage.js ~/Library/Application\\ Support/Hello\\ Pix/logs/hello-pix-2026-10-07.log')
    process.exit(2)
  }
  console.log('读取日志：' + file + '\n')
  return fs.readFileSync(file, 'utf8')
}

/** 把日志行解析成 trace 事件。 */
function parseTrace (text) {
  const out = []
  const lines = String(text).split(/\r?\n/)
  for (const line of lines) {
    const m = TRACE_RE.exec(line.trim())
    if (!m) continue
    let payload = {}
    if (m[2]) { try { payload = JSON.parse(m[2]) } catch (e) { payload = { _raw: m[2] } } }
    out.push({ at: line.slice(0, 23).trim(), event: EVENT_ALIAS[m[1]] || m[1], payload })
  }
  return out
}

/** 按 actionId 分组，并区分这条 action 属于哪条链。 */
function group (events) {
  const byId = new Map()
  for (const e of events) {
    const id = (e.payload && e.payload.sendActionId) || '-'
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id).push(e)
  }
  return byId
}

function chainOf (list) {
  const names = list.map(e => e.event)
  // 优先用显式 chain 字段：本轮起两条链共享的事件（TRANSLATE_STARTED 等）
  // 都带 chain，避免"发送链的 TRANSLATE_STARTED 被当成点译"这种分诊误判。
  const explicit = list.map(e => e.payload && e.payload.chain).find(Boolean)
  if (explicit === 'receive') return 'manual_click'
  if (explicit === 'send') return 'manual_send'
  // 兼容旧版本客户端导出的日志（无 chain 字段）。
  if (names.some(n => n.startsWith('MANUAL_') ||
      n === 'SOURCE_EXTRACTED' || n === 'TARGET_RELOCATED' ||
      n === 'TRANSLATION_RENDERED' || n === 'TRANSLATION_RENDER_TARGET_MISSING' ||
      n === 'MESSAGE_TEXT_EXTRACTION_FAILED')) return 'manual_click'
  if (names.some(n => n.startsWith('SEND_') || n === 'SOURCE_SNAPSHOTTED' ||
      n === 'INPUT_REPLACED' || n === 'INPUT_REWRITTEN' || n === 'FINAL_TEXT_VALIDATED' ||
      n === 'RETRY_TRANSLATE_CLICK' || n === 'RETRY_TRANSLATE_RESULT' ||
      n === 'NATIVE_INPUT_BEGIN' || n === 'COMPOSER_CLEARED' ||
      n === 'NATIVE_TEXT_INSERTED' || n === 'LEXICAL_SETTLED' ||
      n === 'PROGRAMMATIC_SEND_BEGIN' || n === 'PROGRAMMATIC_SEND_DONE')) return 'manual_send'
  return null
}

/**
 * 判定一条 manual_click 链断在哪。
 * @returns {{verdict: string, reason: string, code: string}}
 */
function judgeManual (list) {
  const names = list.map(e => e.event)
  const has = n => names.includes(n)
  const get = n => list.find(e => e.event === n)

  if (!has('MANUAL_TRANSLATE_CLICK')) {
    return { verdict: '✖ 点击事件没到', reason: 'chip 上没有产生点击事件：listener 丢了 / 被覆盖层挡住（pointer-events）/ WhatsApp 重绘把 chip 换掉了', code: '' }
  }
  if (has('MANUAL_CLIENT_EXCEPTION')) {
    return { verdict: '✖ 客户端异常', reason: '点译流程自己抛错（本轮已保证即使抛错也会离开「翻译中…」并给出提示）', code: (get('MANUAL_CLIENT_EXCEPTION').payload || {}).error || '' }
  }
  if (has('MANUAL_CLICK_IGNORED')) {
    return { verdict: 'ℹ 重复点击已忽略', reason: 'chip 处于 busy/done，重复点击被闸门挡下 —— 这是**防重复扣费**的正确行为', code: 'MANUAL_CLICK_IGNORED' }
  }
  if (has('MANUAL_CHAIN_FORCED_RESOLVE')) {
    return { verdict: '⚠ 收口兜底触发', reason: '内部没有显式离开 busy，由 finally 强制收口。链路仍然收尾，但应查明是哪一步漏了显式状态', code: 'MANUAL_CHAIN_FORCED_RESOLVE' }
  }
  const click = get('MANUAL_TRANSLATE_CLICK').payload || {}
  if (click.rowFound === false) {
    return { verdict: '✖ 找不到消息气泡', reason: '按 ' + click.keyAttr + '=' + click.messageId + ' 重新查询失败：消息已滚出视图 / data-id 变了', code: 'MANUAL_ROW_LOST' }
  }
  if (has('MESSAGE_TEXT_EXTRACTION_FAILED')) {
    return { verdict: '✖ 正文提取失败', reason: '严格 parser 没找到 .selectable-text：chip 能显示但点击时取不到正文（老实现的静默 return）', code: 'MESSAGE_TEXT_EXTRACTION_FAILED' }
  }
  if (!has('TRANSLATE_STARTED')) {
    return { verdict: '✖ 没发起翻译请求', reason: '点击与解析之间断了，没有走到 /translate/run', code: '' }
  }
  if (has('TRANSLATE_FAILED')) {
    const p = get('TRANSLATE_FAILED').payload || {}
    return { verdict: '✖ 翻译失败', reason: '真实错误码见右列，客户端已原样回报（不再吞）', code: p.code || 'UNKNOWN' }
  }
  if (!has('TRANSLATE_SUCCEEDED')) {
    return { verdict: '✖ 请求发出后没有响应', reason: '/translate/run 挂住了（网络 / 主进程没回）—— 这是客户端还是服务端要再看服务端日志', code: '' }
  }
  if (has('TRANSLATION_RENDER_TARGET_MISSING')) {
    return { verdict: '✖ 译文生成了但没渲染', reason: '翻译成功后按 key 找不到气泡（或宿主不是消息气泡）—— 本轮起**宁可不显示也不画到聊天根节点**', code: 'TRANSLATION_RENDER_TARGET_MISSING' }
  }
  if (has('TRANSLATION_RENDER_UNVERIFIED')) {
    return { verdict: '✖ 译文没挂进气泡', reason: '绘制后的硬校验没过：译文节点不在原消息行内 —— 已拒绝显示并标失败（不会画到页面底部）', code: 'TRANSLATION_RENDER_UNVERIFIED' }
  }
  if (has('TRANSLATION_RENDERED')) {
    const p = get('TRANSLATION_RENDERED').payload || {}
    if (p.drew === false) {
      return { verdict: '⚠ 渲染被判为无需显示', reason: '译文与原文一致 / 被判定为图标噪音 —— 按钮保留为失败态，不会「点一下按钮没了」', code: '' }
    }
    const reloc = get('TARGET_RELOCATED')
    if (reloc && reloc.payload && reloc.payload.textMatches === false) {
      return { verdict: '⚠ 已渲染，但目标正文不一致', reason: '按路径命中的正文与点击时捕获的不完全一致（可能被 WhatsApp 重绘）。译文已落在原消息行内，但值得复核', code: 'TEXT_MISMATCH' }
    }
    return { verdict: '✔ 成功', reason: '点击 → 提取 → 请求 → 响应 → 重定位 → 渲染 全链路走通', code: '' }
  }
  return { verdict: '✖ 未完成', reason: '事件序列停在 ' + names[names.length - 1] + '，缺失：' + MANUAL_ORDER.filter(n => !names.includes(n)).join(' / '), code: '' }
}

function judgeSend (list) {
  const names = list.map(e => e.event)
  const has = n => names.includes(n)
  // 「重试翻译」是独立的一次发送动作，必须单独判定 ——
  // 真机 P0-1 就是死在这条链上，不能被当成普通的 manual_send 混过去。
  if (has('RETRY_TRANSLATE_CLICK')) {
    const result = list.find(e => e.event === 'RETRY_TRANSLATE_RESULT')
    if (!result) {
      return { verdict: '△ 重试链断在半路', reason: '点了「重试翻译」但缺少 ' + RETRY_ORDER.filter(n => !has(n)).join(' / ') + ' —— 停在 ' + names[names.length - 1] + '，那一步就是断点', code: names[names.length - 1] }
    }
    const p = result.payload || {}
    if (p.ok === true) {
      return { verdict: '✔ 重试成功', reason: '「重试翻译」→ 重翻 → 原生输入写回 → 正文校验 → 程序化发送 全链路闭环' + (has('NATIVE_INPUT_BEGIN') ? '（走的是 Chromium 原生输入链，0.1.19 起）' : (has('INPUT_REWRITTEN') ? '（含一次"正文被还原后就地重写"自愈，0.1.18 起）' : '')), code: '' }
    }
    return { verdict: '⛔ 重试仍然失败', reason: '这一下又没成。真实原因见右列错误码（本轮起不再用统一的「重试失败」掩盖）', code: p.code || 'UNKNOWN' }
  }
  if (has('SEND_FAIL_CLOSED')) {
    return { verdict: '⛔ fail-closed 拦下（未发出任何内容）', reason: '原因见右列。这是**正确**行为，但要确认用户看到了提示', code: (list.find(e => e.event === 'SEND_FAIL_CLOSED').payload || {}).reason || '' }
  }
  if (has('SEND_BLOCKED_BUSY_MARK') || has('SEND_BLOCKED_BODY_MISMATCH')) {
    // 0.1.18：BODY_MISMATCH 必须带上**差在哪**，否则真机还是只能看到"状态异常"。
    const detail = list.find(e => e.event === 'SEND_BODY_MISMATCH_DETAIL')
    let why = '正文里有占位符或不等于预期 —— 至少没有把脏内容发出去'
    if (detail && detail.payload) {
      const d = detail.payload
      why = '回读正文与预期译文（canonical 化之后）仍不一致：首个差异位=' + d.firstDiffCanonical +
        '，预期 len=' + ((d.expected || {}).len) + ' hash=' + ((d.expected || {}).hash) +
        '，实际 len=' + ((d.actual || {}).len) + ' hash=' + ((d.actual || {}).hash) +
        '，写入方式=' + d.writeMethod + '，input 事件=' + d.sawInput +
        '。canonical 前：预期=' + JSON.stringify(d.expectedCanonical) + ' 实际=' + JSON.stringify(d.actualCanonical)
    }
    return { verdict: '⛔ 发送前复核发现问题，已拦下', reason: why, code: names.find(n => n.startsWith('SEND_BLOCKED')) }
  }
  // ★ 0.1.19：只要走了原生输入链，就按**原生顺序**判定完整性 ★
  //   （原生事件是否 trusted、编辑器是否认，是这一轮的唯一命门）
  if (has('NATIVE_INPUT_BEGIN')) {
    const missing = NATIVE_ORDER.filter(n => !has(n))
    if (!missing.length) {
      const settled = list.find(e => e.event === 'LEXICAL_SETTLED')
      const sp = (settled && settled.payload) || {}
      const drift = Array.isArray(sp.driftSamples) ? sp.driftSamples : []
      if (sp.stable === false || drift.some(s => s && s.equal === false)) {
        return { verdict: '⛔ 原生写入后正文仍在漂移', reason: 'Lexical 在观察窗内把正文改掉了（漂移采样里出现 equal:false）—— 正是 0.1.18 的病症，本轮应已消失；若复现请立刻回报', code: 'LEXICAL_DRIFT' }
      }
      return { verdict: '✔ 成功', reason: '原生输入链完整（BEGIN → 清空 → 插入 → 沉降 → 校验 ok → 发送），编辑器认可、正文无漂移', code: '' }
    }
    return { verdict: '△ 原生输入链断在半路', reason: '缺：' + missing.join(' / ') + ' —— 停在 ' + names[names.length - 1] + '，那一步就是断点', code: names[names.length - 1] }
  }
  const order = SEND_ORDER.filter(n => has(n))
  if (order.length === SEND_ORDER.length) {
    return { verdict: '✔ 成功', reason: '状态机顺序完整，且成功之前没有真实发送', code: '' }
  }
  if (has('TRANSLATE_FAILED')) {
    return { verdict: '⛔ 翻译失败 → 一个字节都没发', reason: '正确行为（宁可不发，也不发原文）', code: 'TRANSLATE_FAILED' }
  }
  return { verdict: '△ 未完成', reason: '缺：' + SEND_ORDER.filter(n => !has(n)).join(' / '), code: '' }
}

function main () {
  const text = readInput(process.argv)
  const events = parseTrace(text)
  if (!events.length) {
    console.log('日志里一条 [PIX_TRACE] 都没有。')
    console.log('可能原因：当前安装的是旧版本（trace 是本次新增的），或日志被截断。')
    process.exit(1)
  }
  const byId = group(events)

  const buckets = { manual_click: [], manual_send: [] }
  let unknown = 0
  for (const [id, list] of byId) {
    // id='-' 的是点击之前产生的噪声（chip 渲染、启动等），不属于任何一次动作。
    if (id === '-') { unknown++; continue }
    const chain = chainOf(list)
    if (chain) buckets[chain].push({ id, list })
    else unknown++
  }

  for (const chain of ['manual_click', 'manual_send']) {
    const label = chain === 'manual_click' ? '点「译」手动翻译（链 A）' : '发送翻译（链 B）'
    const items = buckets[chain]
    console.log('='.repeat(78))
    console.log(' ' + label + '：共 ' + items.length + ' 次动作')
    console.log('='.repeat(78))
    if (!items.length) { console.log('  （本次日志里没有）\n'); continue }
    let ok = 0
    for (const it of items) {
      const v = chain === 'manual_click' ? judgeManual(it.list) : judgeSend(it.list)
      if (v.verdict.startsWith('✔')) ok++
      const p = it.list[0].payload || {}
      console.log('\n' + v.verdict + '  ' + it.id)
      if (chain === 'manual_click') {
        console.log('   消息      ' + (p.messageId || '-') + '   tab=' + (p.tabId || '-') +
          '   partition=' + (p.partition || '-') + '   engine=' + (p.engine || '-'))
      }
      console.log('   原因      ' + v.reason)
      if (v.code) console.log('   错误码    ' + v.code)
      console.log('   事件      ' + it.list.map(e => e.event).join(' → '))
      const parsed = it.list.find(e => e.event === 'SOURCE_EXTRACTED')
      if (parsed) console.log('   正文      sourceTextLen=' + parsed.payload.sourceTextLen + '  translatable=' + parsed.payload.translatable)
    }
    console.log('\n  ' + label + '：' + ok + ' / ' + items.length + ' 次成功\n')
  }

  if (unknown) console.log('（另有 ' + unknown + ' 组无可识别动作的 trace，多为 chip 渲染等噪声）')
}

main()
