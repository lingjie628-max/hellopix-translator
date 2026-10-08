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
const MANUAL_ORDER = ['MANUAL_TRANSLATE_CLICK', 'MANUAL_PARSED', 'MANUAL_REQUEST', 'MANUAL_RESPONSE', 'MANUAL_RENDERED']
/** 发送翻译（manual_send）的期望顺序。 */
const SEND_ORDER = ['SEND_CAPTURED', 'NATIVE_SEND_BLOCKED', 'SOURCE_SNAPSHOTTED', 'TRANSLATE_STARTED', 'TRANSLATE_SUCCEEDED', 'INPUT_REPLACED', 'PROGRAMMATIC_SEND_BEGIN', 'PROGRAMMATIC_SEND_DONE']

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
    out.push({ at: line.slice(0, 23).trim(), event: m[1], payload })
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
  if (names.some(n => n.startsWith('MANUAL_') || n === 'MESSAGE_TEXT_EXTRACTION_FAILED')) return 'manual_click'
  if (names.some(n => n.startsWith('SEND_') || n === 'TRANSLATE_STARTED' || n === 'PROGRAMMATIC_SEND_BEGIN')) return 'manual_send'
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
  const resp = get('MANUAL_RESPONSE')

  if (!has('MANUAL_TRANSLATE_CLICK')) {
    return { verdict: '✖ 点击事件没到', reason: 'chip 上没有产生点击事件：listener 丢了 / 被覆盖层挡住（pointer-events）/ WhatsApp 重绘把 chip 换掉了', code: '' }
  }
  if (has('MANUAL_CLIENT_EXCEPTION')) {
    return { verdict: '✖ 客户端异常', reason: '点译流程自己抛错', code: (get('MANUAL_CLIENT_EXCEPTION').payload || {}).error || '' }
  }
  const click = get('MANUAL_TRANSLATE_CLICK').payload || {}
  if (click.rowFound === false) {
    return { verdict: '✖ 找不到消息气泡', reason: '按 ' + click.keyAttr + '=' + click.messageId + ' 重新查询失败：消息已滚出视图 / data-id 变了', code: 'MANUAL_ROW_LOST' }
  }
  if (has('MESSAGE_TEXT_EXTRACTION_FAILED')) {
    return { verdict: '✖ 正文提取失败', reason: '严格 parser 没找到 .selectable-text：chip 能显示但点击时取不到正文（老实现的静默 return）', code: 'MESSAGE_TEXT_EXTRACTION_FAILED' }
  }
  if (!has('MANUAL_REQUEST')) {
    return { verdict: '✖ 没发起翻译请求', reason: '点击与解析之间断了，没有走到 /translate/run', code: '' }
  }
  if (!has('MANUAL_RESPONSE')) {
    return { verdict: '✖ 请求发出后没有响应', reason: '/translate/run 挂住了（网络 / 主进程没回）—— 这是客户端还是服务端要再看服务端日志', code: '' }
  }
  if (resp.payload && resp.payload.ok === false) {
    return { verdict: '✖ 服务端拒绝', reason: '真实错误码见右列，客户端已原样回报（不再吞）', code: resp.payload.code || 'UNKNOWN' }
  }
  if (has('MANUAL_RENDER_MISSED')) {
    return { verdict: '✖ 译文生成了但没渲染', reason: '翻译成功后按 key 找不到气泡 —— 异步期间 DOM 变了，老实现就是这里把译文插进 detach 节点', code: 'MANUAL_RENDER_MISSED' }
  }
  if (has('MANUAL_FAILED')) {
    return { verdict: '✖ 翻译失败', reason: '失败已如实记录（不再静默）', code: (get('MANUAL_FAILED').payload || {}).code || '' }
  }
  if (has('MANUAL_RENDERED')) {
    return { verdict: '✔ 成功', reason: '点击 → 解析 → 请求 → 响应 → 渲染 全链路走通', code: '' }
  }
  return { verdict: '✖ 未完成', reason: '事件序列停在 ' + names[names.length - 1] + '，缺失：' + MANUAL_ORDER.filter(n => !names.includes(n)).join(' / '), code: '' }
}

function judgeSend (list) {
  const names = list.map(e => e.event)
  const has = n => names.includes(n)
  if (has('SEND_FAIL_CLOSED')) {
    return { verdict: '⛔ fail-closed 拦下（未发出任何内容）', reason: '原因见右列。这是**正确**行为，但要确认用户看到了提示', code: (list.find(e => e.event === 'SEND_FAIL_CLOSED').payload || {}).reason || '' }
  }
  if (has('SEND_BLOCKED_BUSY_MARK') || has('SEND_BLOCKED_BODY_MISMATCH')) {
    return { verdict: '⛔ 发送前复核发现问题，已拦下', reason: '正文里有占位符或不等于预期 —— 至少没有把脏内容发出去', code: names.find(n => n.startsWith('SEND_BLOCKED')) }
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
      const parsed = it.list.find(e => e.event === 'MANUAL_PARSED')
      if (parsed) console.log('   正文      sourceTextLen=' + parsed.payload.sourceTextLen + '  translatable=' + parsed.payload.translatable)
    }
    console.log('\n  ' + label + '：' + ok + ' / ' + items.length + ' 次成功\n')
  }

  if (unknown) console.log('（另有 ' + unknown + ' 组无可识别动作的 trace，多为 chip 渲染等噪声）')
}

main()
