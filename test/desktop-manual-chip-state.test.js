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

test('硬规则 4：渲染前必须有 isMessageHost 硬守卫 + TARGET_MISSING 兜底（禁止画到聊天根节点）', () => {
  assert.match(guest, /function isMessageHost\b/, '缺少 isMessageHost')
  assert.match(guest, /HOST_FORBIDDEN_IDS\s*=\s*\[[^\]]*'main'/, 'isMessageHost 没有禁止 #main')
  assert.match(guest, /el\.closest\('\[data-id\]'\)/, 'isMessageHost 没有要求 data-id 结构证据')
  const paint = section('function paint', '==== MANUAL CHIP BEGIN')
  assert.match(paint, /if \(!isMessageHost\(host\)\) return false/, 'paint 没有硬拒绝非消息宿主')
  const body = section('async function manualTranslateInner', '/**')
  assert.match(body, /TRANSLATION_RENDER_TARGET_MISSING/, '目标缺失时没有 TARGET_MISSING 事件')
  // paint 只有在真的画出译文后才移除「译」按钮
  assert.match(paint, /box\.textContent = translated[\s\S]*querySelector\(':scope > \.pix-click'\)[\s\S]*remove\(\)/,
    'paint 没有"先画成、再删按钮"的顺序 —— 会让用户看到"点一下按钮没了什么都没发生"')
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
