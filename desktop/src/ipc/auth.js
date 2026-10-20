'use strict'

/**
 * 账号相关 IPC：登录、自动登录、会话校验、登出、改密验证。
 *
 * ## 这一组为什么单独成模块
 *
 * 它握着两样最敏感的东西：`profile`（当前账号）和 `cookieJar`（登录态）。
 * 写错任何一处都不是"界面不对"，而是**掉号**或**串号**：前者用户要重新
 * 扫码，后者更糟 —— 两个账号的数据互相污染。
 *
 * 所以 state 一律走 setter 直连 main.js 的模块级变量，不做副本。
 */

/**
 * @param {object} deps
 * @param {object} deps.reg      createIpcRegistrar 的返回值
 * @param {object} deps.state    带 getter/setter 的账号状态
 * @param {object} deps.actions  有副作用的能力
 * @param {object} deps.env      纯函数
 */
function registerAuthIpc (deps) {
  const { reg, state, actions, env } = deps

  const loginWithCredentials = (username, password) =>
    actions.loginWithCredentials(username, password)

  reg.handle('auth:get', () => actions.publicAuth())

  reg.handle('auth:save', (event, payload) => actions.saveAuth(payload || {}))

  reg.handle('auth:login', async (event, payload) => {
    const value = payload || {}
    return loginWithCredentials(String(value.username || ''), String(value.password || ''))
  })

  reg.handle('auth:autoLogin', async () => {
    const auth = actions.loadStoredAuth()
    // 四个条件缺一不可：用户没勾"记住"、没勾"自动登录"、或者存的那份
    // 用户名/密码不完整，都不能擅自去登录 —— 那会拿半份凭据打接口。
    if (!auth.remember || !auth.autoLogin || !auth.username || !auth.password) {
      return { success: false, msg: '未启用自动登录' }
    }
    return loginWithCredentials(auth.username, auth.password)
  })

  reg.handle('auth:verifyLock', async (event, password) => {
    const entered = String(password || '')
    if (!entered) return { success: false, msg: '请输入密码' }
    const auth = actions.loadStoredAuth()
    // 先走本地比对（定长比较，防时序侧信道）：不必为了验个锁屏密码去打服务器。
    if (auth.password && (!state.profile || !auth.username || auth.username === state.profile.username)) {
      return { success: env.timingEqual(auth.password, entered), msg: '密码不正确' }
    }
    // 本地没存密码时退回在线校验
    if (!state.profile || !state.profile.username) return { success: false, msg: '登录状态已失效' }
    const result = await loginWithCredentials(state.profile.username, entered)
    return result && result.success ? { success: true } : { success: false, msg: '密码不正确' }
  })

  reg.handle('auth:logout', async () => {
    // 服务端登出失败也要清本地：用户的意图是"退出登录"，
    // 不能因为网络不好就把他留在登录态里。
    try {
      await actions.api('/client/logout', { method: 'POST' })
    } catch (e) {}
    state.cookieJar = {}
    state.profile = null
    // keepSaved: true —— 记住的账号密码不清，下次打开还能自动登录
    actions.clearTabs({ keepSaved: true })
    return { success: true }
  })

  reg.handle('auth:session', async () => {
    const data = await actions.api('/client/session')
    if (!data || !data.obj) {
      actions.sendKicked((data && data.msg) || '登录状态已失效，请重新登录')
      return data
    }
    state.profile = data.obj
    actions.sendSession()
    return data
  })
}

module.exports = { registerAuthIpc }
