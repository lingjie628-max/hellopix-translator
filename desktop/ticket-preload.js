'use strict'

/**
 * 计数工单页的启动前置：写入 Vue 路由守卫需要的当前用户快照。
 *
 * Cookie 由主进程复制到该 WebContentsView 分区；这里只补 sessionStorage。
 * 参数只含用户名、套餐和权益，不含密码、Token 或 Cookie。
 */

const PREFIX = '--pix-ticket-user='
try {
  const arg = process.argv.find(item => String(item).indexOf(PREFIX) === 0)
  if (arg) {
    const user = JSON.parse(decodeURIComponent(arg.slice(PREFIX.length)))
    window.sessionStorage.setItem('user', JSON.stringify(user || {}))
  }
} catch (error) {
  // 预加载失败时页面会回落到登录页；不能因此把整个客户端带崩。
}
