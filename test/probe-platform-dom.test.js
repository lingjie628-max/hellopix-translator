/**
 * 结构采集器的采集脚本：能找出消息列表 / 输入框 / 发送按钮，且**不泄露任何聊天内容**。
 *
 * 采集结果会被拿来写平台适配，所以脱敏是硬要求：人名、号码、消息正文一个字都不能出现。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'scripts', 'probe-platform-dom.js'), 'utf8')

function grab (name) {
  const start = SRC.indexOf('function ' + name + ' (')
  assert.ok(start > 0, '找不到 ' + name)
  let depth = 0
  let started = false
  for (let i = start; i < SRC.length; i++) {
    if (SRC[i] === '{') { depth++; started = true } else if (SRC[i] === '}') {
      depth--
      if (started && depth === 0) return SRC.slice(start, i + 1)
    }
  }
  throw new Error('大括号不平衡')
}

const SECRETS = ['Katherine', 'Jonathan Smith', '+1 415 555 0199', '4155550199', 'meet me at the harbor',
  'bank transfer done', '周末一起吃饭', 'Project Phoenix', 'katherine.w']

function bubble (id, dir, text, sender) {
  return '<div class="msg-row ' + dir + '" data-mid="' + id + '" role="row">' +
    (sender ? '<span class="sender-name" title="' + sender + '">' + sender + '</span>' : '') +
    '<div class="bubble"><span class="msg-text" dir="auto">' + text + '</span><span class="time">10:2' + (id % 10) + '</span></div></div>'
}

const PAGE = `<div id="app"><aside class="sidebar"><div class="conv" aria-label="Chat with Katherine">Katherine</div></aside>
<section class="chat-pane">
  <header class="chat-header"><h2 title="Project Phoenix">Project Phoenix</h2><span class="subtitle">Jonathan Smith, Katherine, 5 members</span></header>
  <div class="message-list" role="log" aria-live="polite">
    ${bubble(48151623, 'incoming', 'meet me at the harbor', 'Jonathan Smith')}
    ${bubble(48151624, 'outgoing', 'bank transfer done')}
    ${bubble(48151625, 'incoming', '周末一起吃饭', 'Katherine')}
    ${bubble(48151626, 'incoming', 'call +1 415 555 0199', 'Katherine')}
    ${bubble(48151627, 'outgoing', 'ok katherine.w')}
  </div>
  <footer class="composer"><div contenteditable="true" role="textbox" aria-label="Message Katherine" class="input-box"></div>
  <button class="send-btn" aria-label="Send">➤</button></footer>
</section></div>`

function run () {
  const dom = new JSDOM('<!doctype html><html><head><title>(3) Project Phoenix | Chat</title></head><body>' + PAGE + '</body></html>', {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://chat.example.com/u/4155550199/t/katherine.w#48151623'
  })
  dom.window.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 })
  const out = dom.window.eval('(' + grab('probeSource') + ')()')
  dom.window.close()
  return out
}

test('采集结果不含任何人名 / 号码 / 消息正文 / 群名', () => {
  const json = JSON.stringify(run())
  for (const s of SECRETS) {
    assert.ok(!json.includes(s), '采集结果泄露了：' + s)
  }
  for (const piece of ['harbor', 'Phoenix', 'Jonathan', '0199', '吃饭']) {
    assert.ok(!json.includes(piece), '采集结果泄露了片段：' + piece)
  }
})

test('采集结果能找到消息列表，并给出区分来/去的结构线索', () => {
  const out = run()
  const list = out.repeatingLists.find((l) => /message-list/.test(l.container))
  assert.ok(list, '没找到消息列表')
  assert.equal(list.itemCount, 5)
  assert.ok(list.discriminators.some((d) => /^class:incoming 3\/5$/.test(d)), '没给出 incoming 区分符')
  assert.ok(list.discriminators.some((d) => /^class:outgoing 2\/5$/.test(d)), '没给出 outgoing 区分符')
  assert.ok(list.discriminators.some((d) => /^class:sender-name 3\/5$/.test(d)), '没给出群聊发送者名线索')
})

test('采集结果能找到输入框与发送按钮，标题未读数形状保留', () => {
  const out = run()
  assert.ok(out.editables.some((e) => /contenteditable="true"/.test(e.ser) && /kw=message/.test(e.ser)), '没找到输入框')
  assert.ok(out.sendCandidates.some((b) => /send-btn/.test(b.ser)), '没找到发送按钮')
  assert.equal(out.titleDigitsShape, '(3)')
})
