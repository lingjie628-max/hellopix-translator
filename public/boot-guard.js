(function () {
  'use strict'

  var BOOT_TIMEOUT_MS = 12000
  var timer = null
  var shown = false

  function installStyle() {
    if (document.getElementById('pix-boot-guard-style')) return
    var style = document.createElement('style')
    style.id = 'pix-boot-guard-style'
    style.textContent = [
      '.pix-boot-fallback{min-height:100vh;display:grid;place-items:center;padding:32px;box-sizing:border-box;background:#f5f8fb;color:#263241;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.pix-boot-card{width:min(620px,100%);padding:36px;border:1px solid rgba(113,132,153,.2);border-radius:18px;background:#fff;box-shadow:0 24px 70px rgba(26,45,66,.14)}',
      '.pix-boot-code{color:#c26a17;font-size:11px;font-weight:800;letter-spacing:.18em}',
      '.pix-boot-card h1{margin:10px 0;font-size:28px}.pix-boot-card p{margin:0;color:#6d7b89;line-height:1.75}',
      '.pix-boot-msg{margin-top:16px;padding:12px;border-radius:8px;background:#f0f4f7;font-size:12px;overflow-wrap:anywhere}',
      '.pix-boot-card button{margin-top:24px;padding:10px 18px;border:0;border-radius:9px;background:#409eff;color:#fff;cursor:pointer}'
    ].join('')
    document.head.appendChild(style)
  }

  function showFatal(message) {
    if (shown) return
    var root = document.getElementById('app')
    if (!root) return
    shown = true
    installStyle()
    root.innerHTML = [
      '<div class="pix-boot-fallback"><div class="pix-boot-card">',
      '<div class="pix-boot-code">BOOT ERROR</div>',
      '<h1>页面加载失败</h1>',
      '<p>前端资源没有正常启动。系统已阻止整页空白，请重新加载后再试。</p>',
      '<div class="pix-boot-msg"></div>',
      '<button type="button">重新加载</button>',
      '</div></div>'
    ].join('')
    var msg = root.querySelector('.pix-boot-msg')
    if (msg) msg.textContent = String(message || '启动超时')
    var button = root.querySelector('button')
    if (button) button.addEventListener('click', function () { window.location.reload() })
  }

  function check() {
    var root = document.getElementById('app')
    if (!root || !root.children.length) {
      showFatal('前端资源加载超时（' + Math.round(BOOT_TIMEOUT_MS / 1000) + ' 秒）')
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = window.setTimeout(check, BOOT_TIMEOUT_MS)
  }

  window.__pixShowFatal = showFatal
  window.__pixBootReady = function () {
    if (timer) clearTimeout(timer)
    timer = null
  }

  window.addEventListener('error', function (event) {
    var target = event && event.target
    var tag = target && target.tagName
    if (tag === 'SCRIPT' || tag === 'LINK') {
      showFatal('前端资源加载失败：' + String((target && (target.src || target.href)) || ''))
    }
  }, true)

  if (document.readyState === 'complete') schedule()
  else window.addEventListener('load', schedule, { once: true })
})()
