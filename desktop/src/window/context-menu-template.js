'use strict'

/**
 * 右键菜单模板的构建 —— 纯函数，不碰 Electron。
 *
 * ## 为什么要单独成文件
 *
 * 这段逻辑原来长在 `installEditSupport` 里，和 `wc.on('context-menu')` 绑死。
 * 结果是**只能靠肉眼看**：没法单测（要造整个 Electron 环境），真机脚本又得
 * 按花括号从 main.js 里切源码片段（脆、且一改就崩）。
 *
 * 2026-10-25 用户报"图片放大后右键没反应"，我第一次修就吃这个亏 ——
 * 改完没法证明它真的好了。所以把决策部分抽出来：
 *
 *   · 进来：Electron 给的 `params` + 一组动作回调；
 *   · 出去：`Menu.buildFromTemplate` 认的模板数组。
 *
 * 副作用（复制、保存、重新加载）全部由调用方以回调注入，这里只决定
 * "该显示哪些项、按什么顺序" —— 这部分才是容易错的地方。
 */

/**
 * 从 Electron 的 context-menu params 判断"这是不是一个图片场景"。
 *
 * ## 三种情况
 *
 *   1. `<img>`：`mediaType === 'image'`，`srcURL` 是图片地址 —— 最正常。
 *   2. `data:` 图：有些页面把图内联成 data URL，`mediaType` 可能是 'none'。
 *   3. `blob:` 图：灯箱常用 blob URL，同样可能 `mediaType === 'none'`。
 *
 * ## 判不出来的情况（重要）
 *
 * CSS `background-image` 和 `<canvas>` 上右键，Electron 给的是
 * `mediaType: 'none'` + `srcURL: ''` —— **没有任何图片信息**。
 * 这时候只能靠兜底项（见 buildContextMenuTemplate 末尾），
 * 或者在页面里自己去猜（saveImageFromPage）。
 */
function isImageContext (params) {
  const mediaType = params && params.mediaType
  const srcURL = String((params && params.srcURL) || '')
  if (mediaType === 'image') return true
  if (/^data:image\//i.test(srcURL)) return true
  if (mediaType === 'none' && /^blob:/i.test(srcURL)) return true
  return false
}

/**
 * 构建右键菜单模板。
 *
 * @param {object} params Electron `context-menu` 事件给的参数
 * @param {object} actions 动作回调（全部由调用方注入，这里不关心实现）
 * @param {Function} actions.copyImage      (url) => void
 * @param {Function} actions.saveImage      (url) => void
 * @param {Function} actions.openImage      (url) => void
 * @param {Function} actions.saveFromPage   () => void   兜底：从页面里自己找图
 * @param {Function} actions.copyText       () => void
 * @param {Function} actions.cut            () => void
 * @param {Function} actions.paste          () => void
 * @param {Function} actions.selectAll      () => void
 * @param {Function} actions.reload         () => void
 * @returns {Array} Menu.buildFromTemplate 的模板。**保证非空。**
 */
function buildContextMenuTemplate (params, actions) {
  const act = actions || {}
  const call = (name) => { try { if (typeof act[name] === 'function') act[name]() } catch (e) {} }

  const template = []
  const hasSelection = !!(params && params.selectionText)
  const isEditable = !!(params && params.isEditable)
  const srcURL = String((params && params.srcURL) || '')

  // ── 图片优先 ───────────────────────────────────────────
  // 顺序刻意放在最前：图片上不该出现"粘贴"，那会让菜单看起来像输入框的菜单。
  if (isImageContext(params)) {
    const isDataUrl = /^data:/i.test(srcURL)
    if (srcURL && !isDataUrl) {
      template.push({ label: '复制图片', accelerator: 'CmdOrCtrl+C', click: () => call('copyImage') })
      template.push({ label: '图片另存为…', click: () => call('saveImage') })
      template.push({ label: '在新窗口打开图片', click: () => call('openImage') })
    } else if (srcURL) {
      // data: URL 存下来多半是缩略图占位，不如让用户直接复制走。
      template.push({ label: '复制图片', accelerator: 'CmdOrCtrl+C', click: () => call('copyImage') })
    }
    if (hasSelection) {
      template.push({ type: 'separator' })
      template.push({ label: '复制文字', accelerator: 'CmdOrCtrl+C', click: () => call('copyText') })
    }
    template.push({ type: 'separator' })
    template.push({ label: '重新加载', click: () => call('reload') })
    return template
  }

  // ── 文字 / 输入框 ──────────────────────────────────────
  if (hasSelection) {
    template.push({ label: '复制', accelerator: 'CmdOrCtrl+C', click: () => call('copyText') })
  }
  if (isEditable) {
    template.push({ label: '剪切', accelerator: 'CmdOrCtrl+X', click: () => call('cut') })
    template.push({ label: '粘贴', accelerator: 'CmdOrCtrl+V', click: () => call('paste') })
  }
  if (hasSelection || isEditable) {
    template.push({ type: 'separator' })
    template.push({ label: '全选', accelerator: 'CmdOrCtrl+A', click: () => call('selectAll') })
  }

  // ★ 兜底：任何情况下都给出可用项 ★
  //
  // 原来 template 为空就 return，等于空白处右键毫无反应 ——
  // 用户会怀疑应用卡死了。
  //
  // ★ 图片灯箱拿不到 srcURL 的情况（2026-10-25 补）★
  //
  // 灯箱把图铺在 <div> 的 background-image 上、或画在 <canvas> 里时，
  // Electron 给的是 mediaType='none' + srcURL=''，上面判不出图片，
  // 于是菜单里只剩「重新加载」—— 用户在图片上右键，看到的却是一个
  // 跟图片毫无关系的菜单，体感就是"右键没反应"。
  //
  // 所以兜底里必须有「保存图片…」：它走页面内嗅探，不依赖 srcURL。
  // 这也是一个信号 —— 至少用户知道右键是活的。
  if (!template.length) {
    template.push({ label: '保存图片…', click: () => call('saveFromPage') })
    template.push({ type: 'separator' })
    template.push({ label: '重新加载', click: () => call('reload') })
  }

  return template
}

module.exports = { isImageContext, buildContextMenuTemplate }
