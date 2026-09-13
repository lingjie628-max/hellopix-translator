/**
 * 网页端主题预热 —— 必须在首帧前执行。
 *
 * 为什么是独立文件而不是 HTML 内联：
 *   服务端响应头带 CSP `script-src 'self'`，内联脚本会被浏览器直接拦掉
 *   （实测：预热逻辑写在 index.html 里完全不执行，且不报错，极难发现）。
 *   放在 <head> 里、样式表与业务 bundle 之前的外链脚本则在首帧前同步执行，
 *   同样能避免夜间用户刷新时先闪一下日间。
 *
 * 规则：默认日间；只有用户手动切过夜间（localStorage 存了 dark）才挂 data-theme。
 */
;(function preloadWebTheme() {
  try {
    if (localStorage.getItem('pix-web-theme') === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark')
    }
  } catch (e) {
    /* localStorage 不可用时按默认日间处理，不影响页面 */
  }
})()
