'use strict'

/**
 * 图片预览的「翻译图片」按钮 —— 注入客页的常驻模块。
 *
 * ## 这个文件为什么长这样
 *
 * 灯箱是**宿主自己的 UI**（WhatsApp / Telegram 等），我们没有任何钩子能知道
 * "用户点开了图片"。宿主也不会发事件给嵌入方。所以只能靠**观察画面本身**。
 *
 * 判据：屏幕上出现一个足够大、且**不在聊天列表里**的图片 → 认为灯箱打开了。
 *
 * ## 踩过的三个坑（都写在这里，别重复踩）
 *
 * 1. **不能写死容器选择器。** 宿主用哈希类名（`.x1lliihq` / `.r1iyk9cc`），
 *    每次发版都变。写死 = 下次它更新就静默失效，而且用户不会报"按钮没了"，
 *    只会觉得"功能时好时坏"。
 *
 * 2. **不能只靠 MutationObserver。** 灯箱打开时 DOM 变化可能发生在
 *    别的子树（React portal），observer 挂错根节点就永远收不到。
 *    所以「观察 + 低频轮询」两条腿走路：observer 及时响应，轮询兜底。
 *
 * 3. **不能把按钮挂在 img 里。** 灯箱图片常被 transform 缩放/旋转，
 *    挂在 img 内部会跟着变形。所以按钮用 **fixed 定位挂在 body 上**，
 *    位置由图片的 getBoundingClientRect 算出。
 *
 * ## 为什么按钮定位要跟着图走
 *
 * 灯箱里图片可能居中、可能带工具栏在顶部。把按钮 fixed 在"图片矩形
 * 右上角内侧"—— 无论图多大、怎么居中，都贴在图边上，不会飘到工具栏或
 * 列表去。
 */

/** 判定为"灯箱大图"的最小边长（CSS 像素）。 */
const MIN_EDGE = 200
/** 轮询间隔：够快能跟上用户操作，又不会让主线程一直忙。 */
const POLL_MS = 400

/**
 * 生成注入脚本的源码字符串。
 *
 * 用字符串而不是直接在这里操作 DOM —— 这段代码会被塞进 guest-inject.js，
 * 在那里以普通函数形式执行（见 installImageTranslate）。用字符串是关键：
 * 单测可以把它当纯文本断言，不需要真的开一个 Electron 页面。
 *
 * @param {object} opts { buttonText }
 */
function buildImageTranslateScript (opts) {
  const o = opts || {}
  const label = JSON.stringify(String(o.buttonText || '翻译图片'))
  return `
(function installImageTranslate () {
  if (window.__pixImageTranslateInstalled) return
  window.__pixImageTranslateInstalled = true

  var MIN_EDGE = ${MIN_EDGE}
  var POLL_MS = ${POLL_MS}
  var LABEL = ${label}

  var btn = null
  var panel = null
  var busy = false
  var lastRect = ''
  // 按钮当前是否可见。用来避免每一次 tick 都去写 btn.dataset
  // （无谓的 DOM 写入会让样式重算，和上面的布局预判是一个目的）。
  var buttonShown = false

  function ensureStyle () {
    if (document.getElementById('pix-imgtrans-style')) return
    var st = document.createElement('style')
    st.id = 'pix-imgtrans-style'
    // z-index 取 2147483000：宿主灯箱常见 1e6~1e7 量级，这里压过它们；
    // 又不取 2147483647（那是弹层上限，取满后我们自己的提示框反而压不上去）。
    st.textContent = ''
      + '#pix-imgtrans-btn{position:fixed;z-index:2147483000;display:none;'
      + 'align-items:center;gap:6px;padding:8px 14px;border:0;border-radius:999px;'
      + 'background:rgba(17,27,33,.92);color:#fff;font:600 14px/1 system-ui,-apple-system,"Segoe UI",sans-serif;'
      + 'cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4);backdrop-filter:blur(8px);'
      + 'transition:opacity .15s,transform .15s;opacity:0;transform:translateY(-4px);'
      + '-webkit-user-select:none;user-select:none;}'
      + '#pix-imgtrans-btn[data-show="1"]{display:flex;opacity:1;transform:none;}'
      + '#pix-imgtrans-btn:hover{background:rgba(0,168,132,.96);}'
      + '#pix-imgtrans-btn[data-busy="1"]{cursor:progress;opacity:.75;}'
      + '#pix-imgtrans-panel{position:fixed;z-index:2147483001;display:none;'
      + 'flex-direction:column;max-width:min(420px,42vw);max-height:70vh;'
      + 'background:rgba(17,27,33,.97);color:#e9edef;border-radius:12px;'
      + 'box-shadow:0 12px 40px rgba(0,0,0,.55);font:400 14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;'
      + 'overflow:hidden;backdrop-filter:blur(12px);}'
      + '#pix-imgtrans-panel[data-show="1"]{display:flex;}'
      + '.pix-it-head{display:flex;align-items:center;justify-content:space-between;gap:12px;'
      + 'padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.1);font-weight:600;}'
      + '.pix-it-close{cursor:pointer;opacity:.7;font-size:18px;line-height:1;padding:0 4px;'
      + 'background:none;border:0;color:inherit;}'
      + '.pix-it-close:hover{opacity:1;}'
      + '.pix-it-body{overflow-y:auto;padding:10px 14px 14px;}'
      + '.pix-it-row{padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06);}'
      + '.pix-it-row:last-child{border-bottom:0;}'
      + '.pix-it-src{font-size:12px;opacity:.6;margin-bottom:4px;white-space:pre-wrap;'
      + 'word-break:break-word;-webkit-user-select:text;user-select:text;}'
      + '.pix-it-dst{white-space:pre-wrap;word-break:break-word;'
      + '-webkit-user-select:text;user-select:text;}'
      + '.pix-it-hint{padding:16px 14px;opacity:.75;font-size:13px;line-height:1.6;}'
      + '.pix-it-err{color:#f15c6d;}'
      + '.pix-it-spin{display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.3);'
      + 'border-top-color:#fff;border-radius:50%;animation:pix-it-rot .8s linear infinite;}'
      + '@keyframes pix-it-rot{to{transform:rotate(360deg);}}'
    ;(document.head || document.documentElement).appendChild(st)
  }

  // 可见面积（与 preview-image.js 的判据保持一致，避免"按钮出现但取不到图"）
  function visibleArea (el) {
    var r = el.getBoundingClientRect()
    var w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0))
    var h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0))
    return { area: w * h, rect: r, w: w, h: h }
  }

  // 找出当前"正在被预览"的图片。
  //
  // 除面积外还要满足：长宽都够大。只看面积会误判 —— 聊天里一张
  // 横向长图（比如 600x120 的名片）面积可能有 72000，但那是消息气泡里的
  // 缩略图，不是灯箱。
  function findPreviewImage () {
    var best = null
    for (var i = 0; i < document.images.length; i++) {
      var img = document.images[i]
      if (!img.currentSrc && !img.src) continue
      var m = visibleArea(img)
      if (m.w < MIN_EDGE || m.h < MIN_EDGE) continue
      if (!best || m.area > best.area) best = { area: m.area, el: img, rect: m.rect }
    }
    return best
  }

  function placeButton (img) {
    if (!btn) return
    var r = img.getBoundingClientRect()
    if (r.width < MIN_EDGE || r.height < MIN_EDGE) { hideButton(); return }
    // 贴图片右上角内侧：始终在图边上，不会飘到工具栏或列表
    var top = Math.max(8, r.top + 12)
    var right = Math.max(8, innerWidth - r.right + 12)
    var key = Math.round(top) + '|' + Math.round(right)
    if (key === lastRect) return
    lastRect = key
    btn.style.top = top + 'px'
    btn.style.right = right + 'px'
    btn.dataset.show = '1'
  }

  function hideButton () {
    lastRect = ''
    if (btn) btn.dataset.show = '0'
  }

  function closePanel () {
    if (panel) panel.dataset.show = '0'
  }

  function ensureButton () {
    if (btn && btn.isConnected) return btn
    btn = document.createElement('button')
    btn.id = 'pix-imgtrans-btn'
    btn.type = 'button'
    btn.textContent = LABEL
    btn.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
      translateCurrent()
    })
    // 拖拽/选中时不要误触发
    btn.addEventListener('mousedown', function (e) { e.stopPropagation() })
    document.body.appendChild(btn)
    return btn
  }

  function ensurePanel () {
    if (panel && panel.isConnected) return panel
    panel = document.createElement('div')
    panel.id = 'pix-imgtrans-panel'
    panel.innerHTML = ''
      + '<div class="pix-it-head"><span>图片翻译</span>'
      + '<button class="pix-it-close" type="button" title="关闭">×</button></div>'
      + '<div class="pix-it-body"></div>'
    panel.querySelector('.pix-it-close').addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
      closePanel()
    })
    document.body.appendChild(panel)
    return panel
  }

  function panelBody () {
    var p = ensurePanel()
    return p.querySelector('.pix-it-body')
  }

  function panelPosition (img) {
    var p = ensurePanel()
    var r = img.getBoundingClientRect()
    // 优先放在图片右侧；右侧放不下就放左侧；再不行贴左边缘。
    var gap = 16
    var width = Math.min(420, Math.max(260, innerWidth * 0.3))
    p.style.width = width + 'px'
    var left = r.right + gap
    if (left + width > innerWidth - 8) {
      var alt = r.left - gap - width
      left = alt >= 8 ? alt : Math.max(8, Math.min(innerWidth - width - 8, r.left))
    }
    p.style.left = Math.round(left) + 'px'
    p.style.top = Math.round(Math.max(8, r.top)) + 'px'
    p.style.maxHeight = Math.min(Math.round(innerHeight - 96), Math.round(r.height || innerHeight)) + 'px'
  }

  function renderLoading (img) {
    panelPosition(img)
    var body = panelBody()
    body.innerHTML = ''
    var hint = document.createElement('div')
    hint.className = 'pix-it-hint'
    hint.innerHTML = '<span class="pix-it-spin"></span> 正在识别图片中的文字…'
    body.appendChild(hint)
    ensurePanel().dataset.show = '1'
  }

  function renderMessage (img, message, isError) {
    panelPosition(img)
    var body = panelBody()
    body.innerHTML = ''
    var hint = document.createElement('div')
    hint.className = 'pix-it-hint' + (isError ? ' pix-it-err' : '')
    hint.textContent = String(message || '')
    body.appendChild(hint)
    ensurePanel().dataset.show = '1'
  }

  function renderBlocks (img, blocks) {
    panelPosition(img)
    var body = panelBody()
    body.innerHTML = ''
    if (!blocks || !blocks.length) {
      var empty = document.createElement('div')
      empty.className = 'pix-it-hint'
      empty.textContent = '这张图里没有识别到可翻译的文字'
      body.appendChild(empty)
      ensurePanel().dataset.show = '1'
      return
    }
    blocks.forEach(function (b) {
      var row = document.createElement('div')
      row.className = 'pix-it-row'
      if (b.source) {
        var src = document.createElement('div')
        src.className = 'pix-it-src'
        src.textContent = b.source
        row.appendChild(src)
      }
      var dst = document.createElement('div')
      dst.className = 'pix-it-dst'
      dst.textContent = b.target
      row.appendChild(dst)
      body.appendChild(row)
    })
    ensurePanel().dataset.show = '1'
  }

  function translateCurrent () {
    if (busy) return
    var found = findPreviewImage()
    if (!found) return
    var img = found.el
    if (typeof window.__pixTranslateImage !== 'function') {
      renderMessage(img, '图片翻译不可用，请重启软件', true)
      return
    }
    busy = true
    if (btn) btn.dataset.busy = '1'
    renderLoading(img)
    var to = (window.__pixImageLang || 'zh')
    Promise.resolve()
      .then(function () { return window.__pixTranslateImage({ to: to }) })
      .then(function (res) {
        if (!res || !res.success) {
          renderMessage(img, (res && res.msg) || '图片翻译失败', true)
          return
        }
        renderBlocks(img, res.blocks || [])
      })
      .catch(function (err) {
        renderMessage(img, '图片翻译出错：' + ((err && err.message) || err), true)
      })
      .then(function () {
        busy = false
        if (btn) btn.dataset.busy = '0'
      })
  }

  // 快速预判：屏幕上有没有"可能是灯箱"的图片。
  //
  // 为什么需要这一步（性能，不是功能）：
  //
  // findPreviewImage 要对每张图调 getBoundingClientRect —— 那会强制
  // 浏览器同步重排。而 tick 的触发频率是：
  //
  //   · MutationObserver（子节点增删 / src 变化）—— 聊天气泡里每进来一条
  //     新消息都会触发；
  //   · 400ms 轮询。
  //
  // 一个聊天窗口有几百张图时，"每次都全量量一遍"会让宿主明显发涩 ——
  // 用户不会说"翻译软件卡"，只会说"WhatsApp 变卡了"。
  //
  // 所以先做一次零布局的预判：只看图元素的数量与 naturalWidth。
  // 聊天缩略图在 DOM 里通常是小图，只有灯箱那张是大于 MIN_EDGE 的自然尺寸。
  // 这一条能把绝大多数 tick 挡在昂贵的路径之外。
  function maybeHasPreview () {
    var imgs = document.images
    if (!imgs || imgs.length === 0) return false
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i]
      // naturalWidth/Height 是已解码图片的固有尺寸，**不触发重排**
      var nw = img.naturalWidth || 0
      var nh = img.naturalHeight || 0
      if (nw >= MIN_EDGE && nh >= MIN_EDGE) return true
    }
    return false
  }

  function tick () {
    if (!document.body) return
    ensureStyle()

    // 先走廉价预判。没有大图就只剩"收起"这一件事，别去量布局。
    if (!maybeHasPreview()) {
      if (buttonShown) {
        hideButton()
        buttonShown = false
      }
      if (panel && panel.dataset.show === '1') closePanel()
      return
    }

    var found = findPreviewImage()
    if (found) {
      ensureButton()
      placeButton(found.el)
      buttonShown = true
      // 图被关掉后（元素脱离文档）要收起面板，否则会留一个孤零零的框
      if (panel && panel.dataset.show === '1' && !found.el.isConnected) closePanel()
    } else {
      if (buttonShown) {
        hideButton()
        buttonShown = false
      }
      if (panel && panel.dataset.show === '1') closePanel()
    }
  }

  var pending = false
  function schedule () {
    if (pending) return
    pending = true
    requestAnimationFrame(function () {
      pending = false
      try { tick() } catch (e) {}
    })
  }

  try {
    var mo = new MutationObserver(schedule)
    // ★ 只监听真正会造成"图片出现/消失"的变化 ★
    //
    // 原来监听 attributes: true 且不过滤属性名 —— 宿主在滚动、悬停、
    // 加载气泡时都会改 class 和 style，那是高频的，等于每帧都跑一次 tick。
    //
    // 现在只留 src：灯箱打开时会把图片元素的 src 换成大图地址，
    // 这是"图片变了"最直接的信号。子节点增删仍然监听（灯箱本身是动态插入的）。
    //
    // 位置变化（滚动/缩放）由下面的 scroll/resize 监听覆盖，不靠 observer。
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    })
  } catch (e) {}
  window.addEventListener('resize', schedule, true)
  window.addEventListener('scroll', schedule, true)
  setInterval(function () { try { tick() } catch (e) {} }, POLL_MS)
  schedule()
})()
`
}

module.exports = { buildImageTranslateScript, MIN_EDGE, POLL_MS }
