/**
 * 主题预热 —— 必须在 <head> 里、样式表之前同步执行。
 *
 * 为什么单独一个文件、且放在最前：
 *   1. 页面 CSP 是 script-src 'self'，不允许内联脚本，所以只能外链；
 *   2. 只有在这里（首帧绘制之前）把 data-theme 打上，浅色用户开窗才不会先闪
 *      一下深色。app.js 是 defer 的，等它跑到就已经晚了。
 *
 * 这里读 localStorage 只是"快速路径"：真正的权威值在主进程 config.json
 * （换机、清缓存都不丢），app.js 起来后会用它校正并回写本缓存。
 * 主进程侧刻意不做注入 —— 那样会违反"主进程不向页面注入代码"的安全约定
 * （test/desktop-security.test.js 有断言守着）。
 */
;(function preloadTheme() {
  try {
    if (localStorage.getItem('pix-theme') === 'light') {
      document.documentElement.setAttribute('data-theme', 'light')
    }
  } catch (e) {
    /* localStorage 不可用时保持默认深色，不影响启动 */
  }
})()
