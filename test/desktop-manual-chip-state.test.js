/**
 * 《WhatsApp Translation Bridge 稳定化收口》—— 手动点译 / 发送链 状态机守卫
 *
 * 这一组是**源码级**守卫：它不跑 DOM，只保证"本轮新增的三条硬规则"在代码里
 * 有明确的、可被 grep 到的实现。因为这几条规则的失效方式都是**静默**的
 * （卡在翻译中、重复扣费、译文画到聊天底部），只靠行为测试容易漏，
 * 必须再加一层"结构断言"防止以后被顺手改回去。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const guest = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'guest-inject.js'), 'utf8')

function section (startMarker, endMarker) {
  const a = guest.indexOf(startMarker)
  assert.ok(a >= 0, '找不到锚点：' + startMarker)
  const b = guest.indexOf(endMarker, a + startMarker.length)
  assert.ok(b > a, '找不到结束锚点：' + endMarker)
  return guest.slice(a, b)
}

test('硬规则 5：runManualTranslate 必须有 finally，保证离开 busy（禁止永久「翻译中…」）', () => {
  const body = section('async function runManualTranslate', 'async function manualTranslateInner')
  assert.match(body, /try\s*\{/, '缺少 try')
  assert.match(body, /\}\s*finally\s*\{/, '缺少 finally —— async 抛错时会永久停在「翻译中…」')
  assert.match(body, /MANUAL_CHAIN_FORCED_RESOLVE/, 'finally 里没有强制收口兜底')
  assert.match(body, /chipStateOf\(chipIn\(key, chip\)\) === 'busy'/, 'finally 没有针对"仍停在 busy"做处理')
  // 调用处不能再依赖同步 try/catch 去接 async 的错。
  const click = section('function onChipClick', 'function addClick')
  assert.match(click, /runManualTranslate\(chip\)/, 'onChipClick 没有触发点译')
})

test('硬规则 6：busy / done 态的 chip 再次点击必须被忽略（防重复请求 / 重复扣费）', () => {
  const body = section('async function runManualTranslate', '==== MANUAL CHIP END')
  assert.match(body, /chipStateOf\(chip\)/, '没有读取 chip 状态')
  assert.match(body, /st === 'busy' \|\| st === 'done'/, '没有 busy/done 双重闸')
  assert.match(body, /MANUAL_CLICK_IGNORED/, '忽略重复点击时没有留 trace')
  // done 态由成功渲染后写入
  assert.match(body, /leaveBusy\('done'\)/, '成功渲染后没有把 chip 置为 done')
})

test('失败 chip 必须带真实错误类别（禁止把"连不上服务器"说成"翻译失败"）', () => {
  const body = section('async function runManualTranslate', '==== MANUAL CHIP END')
  // chip 文案按错误码分流：网络类失败必须自成一类。
  assert.match(guest, /const CHIP_FAIL_TEXT = \{/, '缺少 CHIP_FAIL_TEXT 映射')
  assert.match(guest, /NETWORK_UNREACHABLE: '连不上服务器 · 点击重试'/,
    '网络不可达必须显示"连不上服务器"，不能退回"翻译失败"')
  assert.match(guest, /NETWORK_TIMEOUT: '服务器超时 · 点击重试'/, '缺少响应超时文案')
  assert.match(guest, /const CHIP_FAIL_DEFAULT = '翻译失败 · 点击重试'/, '缺少默认文案（认不出的码用它）')
  assert.match(guest, /function chipFailText\(code\)/, '缺少 chipFailText 归一函数')
  // 真实错误码必须传进失败态，否则映射永远用不上。
  assert.match(body, /leaveBusy\('fail', \(res && res\.code\) \|\| 'UNKNOWN'\)/,
    '翻译失败时必须把真实错误码传给 chip')
  assert.match(body, /const leaveBusy = \(next, code\) =>/,
    'leaveBusy 必须能携带错误码')
  // setChipState 的失败态要写入真实文案，并把码钉在 chip 上供取证。
  const setChip = section('function setChipState', 'function chipIn')
  assert.match(setChip, /chip\.textContent = chipFailText\(code\)/, '失败态没有用错误码文案')
  assert.match(setChip, /data-pix-fail-code/, '失败态没有把真实错误码钉在 chip 上')
  // 成功/忙碌两态文案不许被改坏（别的测试也依赖它们）。
  assert.match(setChip, /chip\.textContent = '翻译中…'/)
  assert.match(setChip, /chip\.textContent = '已翻译'/)
  // IPC 层抛错也不能丢掉网络类错误码。
  assert.match(guest, /NETWORK_UNREACHABLE', 'NETWORK_TIMEOUT', 'SERVER_BAD_RESPONSE'\]\.indexOf\(cls\)/,
    'translateTextDetailed 的 catch 必须保留网络类错误码')
})

test('硬规则 4：渲染前必须有 isMessageHost 硬守卫 + TARGET_MISSING 兜底（禁止画到聊天根节点）', () => {
  assert.match(guest, /function isMessageHost\b/, '缺少 isMessageHost')
  assert.match(guest, /HOST_FORBIDDEN_IDS\s*=\s*\[[^\]]*'main'/, 'isMessageHost 没有禁止 #main')
  assert.match(guest, /el\.closest\(SITE\.row\)/, 'isMessageHost 没有要求消息行结构证据')
  assert.match(guest, /whatsapp: \{[^}]*row: '\[data-id\]'/, 'WhatsApp 的消息行不再是 [data-id]')
  const host = section('function isMessageHost', '==== TRANSLATE FAILURE NOTICE BEGIN')
  assert.match(host, /const row = rowOf\(el\)\s*\n\s*if \(!row\) return false/, 'isMessageHost 没有要求宿主挂在消息行上')
  const paint = section('function paint', '==== MANUAL CHIP BEGIN')
  assert.match(paint, /if \(!isMessageHost\(host\)\) return false/, 'paint 没有硬拒绝非消息宿主')
  const body = section('async function manualTranslateInner', '/**')
  assert.match(body, /TRANSLATION_RENDER_TARGET_MISSING/, '目标缺失时没有 TARGET_MISSING 事件')
  // P0-3 起：译文插在**操作行之后**，入口本身保留在同一个操作行里显示「已翻译」。
  // 所以 paint 不再删除「译」按钮 —— 状态位置必须始终一致（正文 → 操作行 → 译文）。
  assert.match(paint, /insertTransBox\(host, box\)/, 'paint 没有把译文插到操作行之后')
  assert.ok(!/pix-click'\)\s*\n\s*if \(click\) click\.remove\(\)/.test(paint),
    'paint 不应再删除「译」按钮 —— 入口要留在操作行里显示「已翻译」')
})

test('P0-3：翻译入口必须在固定的 .pix-trans-action-row 里，且不用绝对定位抢 metadata', () => {
  // 真机现象：单行/短消息时入口和时间/单勾/双勾挤在右下角、按钮被盖住。
  // 硬规则：入口住独立操作行；该行是正常文档流的整行块，绝不绝对定位。
  assert.match(guest, /\.pix-trans-action-row\s*\{[\s\S]*?display:\s*block/,
    '缺少 .pix-trans-action-row 或它不是块级布局（无法单独成行）')
  const rowRule = (guest.match(/\.pix-trans-action-row\s*\{[\s\S]*?\}/) || [''])[0]
  assert.match(rowRule, /flex-basis:\s*100%/, '操作行必须在弹性容器里也占满整行，避免与右对齐的 metadata 同排')
  assert.match(rowRule, /position:\s*static/, '操作行必须留在正常文档流，不许绝对定位')
  assert.ok(!/position:\s*absolute/.test(rowRule), '操作行禁止使用绝对定位抢 WhatsApp metadata 区域')
  const chipRule = (guest.match(/\.pix-click\s*\{[\s\S]*?\}/) || [''])[0]
  assert.ok(chipRule.length > 0, '找不到 .pix-click 规则')
  assert.ok(!/position:\s*absolute/.test(chipRule), '.pix-click 禁止绝对定位（right/bottom 抢 metadata）')
  assert.ok(!/z-index/.test(chipRule), '.pix-click 不许靠 z-index 压 metadata —— 位置问题要由布局解决')
  assert.match(chipRule, /position:\s*static/, '.pix-click 应留在文档流里（static）')
  assert.match(chipRule, /pointer-events:\s*auto/, '.pix-click 必须显式打开 pointer-events（否则点不动）')
  // 所有状态都写进同一个操作行：addClick 必须把 chip 放进 row，而不是直接挂宿主。
  const add = section('function addClick', 'function visible')
  assert.match(add, /ensureActionRow\(host, meta\)/, 'addClick 没有把入口放进固定操作行')
  assert.match(add, /row\.appendChild\(chip\)/, 'addClick 没有把 chip 放进操作行')
  assert.match(add, /inActionRow:\s*chip\.parentElement === row/, '缺少"入口确实在操作行内"的取证字段')
  // clearExtras 必须能把操作行一起清掉（换会话/关闭功能时不留残渣）
  assert.match(guest, /function clearExtras[\s\S]{0,220}?pix-trans-action-row/, 'clearExtras 没有清理操作行')
})

test('trace 规范名：接收链与发送链都对齐四段式命名', () => {
  for (const ev of ['SOURCE_EXTRACTED', 'TARGET_RELOCATED', 'TRANSLATION_RENDERED', 'TRANSLATION_RENDER_TARGET_MISSING']) {
    assert.ok(guest.includes("trace('" + ev + "'"), '接收链缺少 trace：' + ev)
  }
  assert.ok(guest.includes("trace('FINAL_TEXT_VALIDATED'"), '发送链缺少 FINAL_TEXT_VALIDATED')
  // 两条链的共享事件必须带 chain 判别字段，否则分诊时分不清是哪条链
  const recv = section('async function manualTranslateInner', '==== MANUAL CHIP END')
  assert.match(recv, /chain: 'receive'/, '接收链 trace 没有 chain=receive')
  const send = section('async function deliverSend', 'function fireSendVerified')
  assert.match(send, /chain: 'send'/, '发送链 trace 没有 chain=send')
})

test('硬规则 3：失败提示的「重试翻译」必须有可见的「正在重试…」与「重试失败」', () => {
  const notice = section('function showSendFailureNotice', '// ==== SEND FAILURE NOTICE END ====')
  assert.match(notice, /'正在重试…'/, '重试没有「正在重试…」状态')
  assert.match(notice, /'重试失败'/, '重试失败没有「重试失败」状态')
  assert.match(notice, /actions: false/, '重试中的瞬态提示应该没有按钮')
  assert.match(notice, /hideSendFailureNotice\(\)/, '重试成功后没有收起状态条')
})
