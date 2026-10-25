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

  /**
   * 同步 handler（对应渲染/预加载侧的 `ipcRenderer.sendSync`）。
   *
   * ## 为什么需要它
   *
   * 沙箱里的 preload（`sandbox: true`）只能 require('electron')，读不到
   * 本地文件。要让 preload 拿到"由主进程读进来的本地资源"，最直接的办法
   * 就是 sendSync —— 它在 preload 启动阶段**同步**返回，不引入 async 竞态。
   *
   * ## 为什么守卫要可选
   *
   * 主界面来的同步调用用 isMainSender；**客页 preload** 来的不是主界面
   * （它是 WebContentsView），用 isMainSender 会一律拒掉 —— 那个功能会
   * 静默失效。所以这里接受调用方传入的 isTrusted。
   *
   * ## 必须遵守的三条
   *
   *   1. **一定** setReturnValue：任何分支都不能漏，否则渲染进程会一直挂着；
   *   2. 只返回**不含密钥的静态资源**，绝不在这里读用户数据/凭据；
   *   3. 宁可返回 null 也不要抛 —— 同步通道抛错的表现是整个页面卡住。
   */
  function handleSync (channel, fn, isTrusted) {
    assertUnique(channel)
    ipcMain.on(channel, (event, ...args) => {
      let value = null
      try {
        const trusted = typeof isTrusted === 'function'
          ? isTrusted(event)
          : isMainSender(event)
        if (!trusted) {
          try { rejectUntrustedSender() } catch (e) {}
        } else {
          value = fn(event, ...args)
        }
      } catch (e) {
        value = null
      }
      try { event.returnValue = value } catch (e) {}
    })
  }

  return {
    handle,
    handleUnsafe,
    handleSync,
    channels: () => [...registered]
  }
}

module.exports = { createIpcRegistrar }
