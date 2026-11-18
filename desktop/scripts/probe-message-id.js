'use strict'

/**
 * 深度探针：消息 ID 在新版 WhatsApp Web 里到底藏在哪。
 *
 * ## 为什么需要它
 *
 * 2026-11-11 第一次验证的结果：
 *   scopeFound/headerFound/subtitleFound 全是 true  → 挂载点没问题
 *   rowCount = 2，但 dataIdSample 为空          → 消息 ID 不在 data-id 上
 *
 * guest-inject.js 里早有一条注释：「新构建 data-id 只剩消息哈希」。
 * 现在要用真实数据确认：消息 ID（带 3A / 3EB0 前缀那个）到底在哪。
 *
 * ## 探针做什么
 *
 * 在 #main 里把所有可能承载消息身份的东西都 dump 出来：
 *   · 所有 [data-*] 属性及其值
 *   · 消息容器的 class / role / aria-label
 *   · 找出哪些值符合「消息 ID」形状（3A / 3EB0 / 长随机串）
 *
 * 只读，不点、不发。
 *
 *   cd desktop
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/probe-message-id.js
 */

const { app, BrowserWindow } = require('electron')

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const PROBE = `
(function () {
  var out = {
    scope: false,
    rowCounts: {},
    attrNames: {},
    candidates: [],
    sampleNodes: [],
    looksLikeMsgId: []
  }

  var scope = document.querySelector('#main')
  if (!scope) return JSON.stringify(out)
  out.scope = true

  // 1) 各个可能的选择器命中多少
  var sels = [
    '[data-id]',
    '[data-message-id]',
    '[role="row"]',
    '.message-in',
    '.message-out',
    '[data-testid="msg-container"]',
    '[data-testid*="msg"]',
    '[class*="message"]'
  ]
  for (var i = 0; i < sels.length; i++) {
    try { out.rowCounts[sels[i]] = scope.querySelectorAll(sels[i]).length } catch (e) {}
  }

  // 2) 统计 #main 里所有 data-* 属性名
  var all = scope.querySelectorAll('*')
  out.totalNodes = all.length
  for (var j = 0; j < all.length; j++) {
    var attrs = all[j].attributes
    if (!attrs) continue
    for (var k = 0; k < attrs.length; k++) {
      var name = attrs[k].name
      if (name.indexOf('data-') !== 0) continue
      out.attrNames[name] = (out.attrNames[name] || 0) + 1
    }
  }

  // 3) 找符合「消息 ID」形状的值：3A 开头 / 3EB0 开头 / 长十六进制串
  function looksLikeId(v) {
    if (!v || typeof v !== 'string') return false
    if (v.indexOf('3A') === 0 && v.length >= 20 && v.length <= 40) return true
    if (v.indexOf('3EB0') === 0) return true
    // 纯十六进制且长度像安卓 ID
    if (/^[0-9A-F]{22,40}$/i.test(v)) return true
    return false
  }

  for (var m = 0; m < all.length && out.looksLikeMsgId.length < 20; m++) {
    var el = all[m]
    var at = el.attributes
    if (!at) continue
    for (var n = 0; n < at.length; n++) {
      var val = String(at[n].value || '')
      // 值里可能嵌着 3EB0... 这样的片段（如 false_jid_3EB0xxx）
      var hit = looksLikeId(val)
      if (!hit) {
        var seg = val.split('_')
        for (var p = 0; p < seg.length; p++) {
          if (looksLikeId(seg[p])) { hit = true; break }
        }
      }
      if (hit) {
        out.looksLikeMsgId.push({
          attr: at[n].name,
          value: val.slice(0, 90),
          tag: String(el.tagName || '').toLowerCase(),
          cls: String(el.className || '').slice(0, 60)
        })
        if (out.looksLikeMsgId.length >= 20) break
      }
    }
  }

  // 4) 采样几个「像消息」的节点，把它们的属性全 dump 出来
  var cand = scope.querySelectorAll('[data-testid="msg-container"], .message-in, .message-out, [role="row"]')
  for (var q = 0; q < cand.length && out.sampleNodes.length < 4; q++) {
    var node = cand[q]
    var dump = { tag: String(node.tagName || '').toLowerCase(), attrs: {}, childAttrs: [] }
    var na = node.attributes
    for (var r = 0; r < na.length; r++) dump.attrs[na[r].name] = String(na[r].value || '').slice(0, 70)
    // 再看两层子节点，找承载 ID 的那个
    var kids = node.querySelectorAll('*')
    for (var s = 0; s < kids.length && dump.childAttrs.length < 8; s++) {
      var ck = kids[s]
      if (!ck.attributes) continue
      for (var t = 0; t < ck.attributes.length; t++) {
        var an = ck.attributes[t].name
        if (an.indexOf('data-') !== 0 && an !== 'id') continue
        dump.childAttrs.push({
          tag: String(ck.tagName || '').toLowerCase(),
          attr: an,
          value: String(ck.attributes[t].value || '').slice(0, 80)
        })
        if (dump.childAttrs.length >= 8) break
      }
    }
    out.sampleNodes.push(dump)
  }

  return JSON.stringify(out)
})();
`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 950,
    show: true,
    webPreferences: {
      partition: 'persist:verify-device-tag', // 复用上次已登录的分区，不用再扫码
      userAgent: UA,
      sandbox: true,
      contextIsolation: true
    }
  })

  console.log('[probe] 复用上次的登录态（persist:verify-device-tag）…')
  await win.loadURL('https://web.whatsapp.com/')
  console.log('[probe] 已加载。**请点开一个有很多条消息的私聊**（至少 5 条来往）。')
  console.log('[probe] 每 15 秒采样一次，最多 5 分钟。\n')

  let best = null
  let attempt = 0
  const timer = setInterval(async () => {
    attempt++
    try {
      const raw = await win.webContents.executeJavaScript(PROBE, true)
      const r = JSON.parse(raw)
      const msgish = (r.looksLikeMsgId || []).length
      console.log('--- 第 ' + attempt + ' 次 ---')
      console.log('  选择器命中: ' + JSON.stringify(r.rowCounts))
      console.log('  像消息ID的样本: ' + msgish)

      // 记录最好的一次
      if (r.scope && (!best || msgish > (best.looksLikeMsgId || []).length)) best = r

      if (msgish >= 3) {
        clearInterval(timer)
        console.log('\n===== 找到消息 ID，完整结果 =====')
        console.log(JSON.stringify(r, null, 2))
        setTimeout(() => app.quit(), 1500)
      }
    } catch (e) {
      console.log('[probe] 失败：' + e.message)
    }
  }, 15000)

  setTimeout(() => {
    clearInterval(timer)
    console.log('\n===== 超时。输出最好的一次结果 =====')
    if (best) console.log(JSON.stringify(best, null, 2))
    else console.log('（一次都没采到 #main）')
    setTimeout(() => app.quit(), 1500)
  }, 5 * 60 * 1000)
})
