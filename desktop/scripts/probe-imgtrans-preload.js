'use strict'
/**
 * 探针用的**真实 preload** —— 和 guest-inject.js 的注入路径等价。
 *
 * 只保留「翻译图片」相关的三条：
 *   1. contextBridge 暴露 __pixTranslateImage（唯一需要跨世界的函数）
 *   2. contextBridge 暴露只读 __pixEnv.lang
 *   3. 按 patch → host → guard 顺序插 pix:// 脚本
 *
 * 真机验证这样做的必要性：直接 `window.__x = …` 在 contextIsolation 下
 * 页面世界读不到（见 scripts/probe-image-translate-ui.js 的历史输出）。
 */
const { ipcRenderer, contextBridge } = require('electron')

contextBridge.exposeInMainWorld('__pixTranslateImage', (payload) => {
  return Promise.resolve({
    success: true,
    blocks: [{ source: 'HELLO', target: '你好 ' + ((payload && payload.to) || 'zh') }]
  })
})

contextBridge.exposeInMainWorld('__pixEnv', {
  get lang () { return 'zh' },
  get version () { return '1' }
})

function inject () {
  let urls = null
  try { urls = ipcRenderer.sendSync('translate:pageScripts') } catch (e) { urls = null }
  if (!urls || !urls.patch || !urls.main || !urls.guard) return
  const list = [['patch', urls.patch], ['host', urls.main], ['guard', urls.guard]]
  for (const [name, src] of list) {
    try {
      const el = document.createElement('script')
      el.src = src
      el.setAttribute('data-pix', name)
      document.documentElement.appendChild(el)
    } catch (e) {}
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', inject, { once: true })
} else {
  inject()
}
