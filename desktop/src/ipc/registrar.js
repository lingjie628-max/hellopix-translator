'use strict'

/**
 * IPC 注册器。
 *
 * ## 为什么要有这一层
 *
 * main.js 里的 handler 原来长这样：
 *
 *     ipcMain.handle('config:setTheme', (event, value) => {
 *       if (!isMainSender(event)) return rejectUntrustedSender()
 *       ...
 *     })
 *
 * 安全性完全依赖**每一处都记得**写 `isMainSender` 守卫。漏一个就是
 * 任意页面（包括多开窗里那些第三方网页）都能调用的越权入口。
 * 把守卫收进注册器，就再也写不出"忘记守卫"的 handler。
 *
 * ## 两种注册方式
 *
 *   handle(channel, fn)        —— 只接受主界面发来的调用，自动守卫
 *   handleUnsafe(channel, fn)  —— 不校验来源，只给确实需要的那几个频道
 *
 * 后者的每一次使用都是一次显式决策，code review 时一眼能看见。
 */

/**
 * @param {object} deps
 * @param {object} deps.ipcMain                  Electron ipcMain
 * @param {(event:object) => boolean} deps.isMainSender
 * @param {(msg?:string) => any} deps.rejectUntrustedSender
 */
function createIpcRegistrar (deps) {
  const { ipcMain, isMainSender, rejectUntrustedSender } = deps
  const registered = new Set()

  function assertUnique (channel) {
    if (registered.has(channel)) {
      // 重复注册在 Electron 里会直接抛错，但错误信息看不出是谁重复的。
      // 拆分 handler 时这是高频事故（两个模块都以为自己负责这个频道）。
      throw new Error('IPC 频道重复注册：' + channel)
    }
    registered.add(channel)
  }

  function handle (channel, fn) {
    assertUnique(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isMainSender(event)) return rejectUntrustedSender()
      return fn(event, ...args)
    })
  }

  function handleUnsafe (channel, fn) {
    assertUnique(channel)
    ipcMain.handle(channel, (event, ...args) => fn(event, ...args))
  }

  return {
    handle,
    handleUnsafe,
    channels: () => [...registered]
  }
}

module.exports = { createIpcRegistrar }
