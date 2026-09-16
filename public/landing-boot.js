/**
 * 官网入口的 hash 分流。
 *
 * 官网与主应用是两个 HTML 入口：`/` → landing.html，`/index.html` → 主应用。
 * 但前端是 **hash 路由**，而 hash 不会发送给服务器 ——
 * 用户访问 `/#/login` 时服务器只看到 `/`，会把官网发给他，登录页就没了。
 *
 * 所以必须在首帧之前把"带 hash 的访问"转交给主应用。
 *
 * 用 location.replace 而不是 href：不留历史记录，
 * 用户按返回键不会在两个入口之间来回弹。
 *
 * 放在 <head> 里同步执行，早于样式与业务 bundle，避免先闪一下官网再跳走。
 */
(function () {
  var hash = window.location.hash
  // 空 hash 与 '#/' 都表示"就是要看官网"，不跳
  if (!hash || hash === '#' || hash === '#/') return
  window.location.replace('/index.html' + hash)
})()
