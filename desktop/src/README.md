# 主进程结构地图

`main.js` 现在只做三件事：**接线、编排、生命周期**。
具体能力都在 `src/` 下，每块都能单独测。

贡献代码前先看这张表，别往 `main.js` 里塞新逻辑。

## 目录

| 目录 | 职责 | 典型文件 |
| --- | --- | --- |
| `src/ipc/` | 所有 IPC 通道 | `registrar.js`、`config.js`、`auth.js`、`translate.js`、`tabs.js`、`app.js` |
| `src/window/` | 窗口 / 视图 / 标签生命周期 | `main-window.js`、`web-view.js`、`open-platform.js`、`tab-context-menu.js`、`hidden-tabs.js`、`background-mode.js` |
| `src/proxy/` | 代理、隧道、节点检测 | `detect.js`、`socks-relay.js`、`ssh-tunnel.js`、`ip-geo.js`、`proxy-settings.js` |
| `src/translate/` | 翻译桥、引擎、解析 | `bridge.js`、`probe-page.js`、`engines.js` |
| `src/stability/` | 崩溃、看门狗、资源 | `health-guard.js`、`log-file.js`、`tab-budget.js`、`load-error-page.js` |
| `src/net/` | 网络请求底座 | `api-net.js` |
| `src/storage/` | 异步落盘 | `async-store.js` |
| `src/config/` | 配置读取与校验 | — |

## 三条硬规矩

### 1. IPC 一律走 registrar

```js
registrar.handle('app:xxx', async (event, ...args) => { ... })   // 只认主窗口
registrar.handleUnsafe('translate:run', (...))                   // guest 用，需自己校验来源
```

`handle` 自动拒绝非主窗口来源。`handleUnsafe` 只给 guest 上下文，
**必须**在里面自己调 `trustedTabSender` 之类做二次校验。
重复注册会立刻抛错，不会静默覆盖。

### 2. 状态用 getter 传，别传快照

```js
state: { get tabs () { return tabs }, set nextTab (v) { nextTab = v } }
```

传 `tabs`（快照）会让模块看到旧数组。凡是会增删改的状态，
一律走 getter / setter。

### 3. 工厂的 const 声明位置会咬人

IPC 的 `actions` 对象在 `main.js` 中间就取用了后面才声明的工厂函数。
直接引用会撞 **TDZ**（`Cannot access X before initialization`），
所以那里用惰性包装：

```js
popupTabContextMenu: payload => popupTabContextMenu(payload)
```

同样，`clientLog`、`screen` 这类**启动后才可用**的东西，
必须惰性取，不能在建工厂时直接传值 —— 否则永远是 `null` / `undefined`。

## 历史事故索引

这些注释写在对应文件顶部，改代码前务必读一遍：

| 位置 | 事故 |
| --- | --- |
| `proxy/detect.js` | 直接开窗探测卡在 SOCKS5 握手，弄坏渲染基础设施，应用再也起不了窗口（0.1.29） |
| `proxy/detect.js` | 预检越权否决，同一个节点"以前能过、修完就过不了"（0.1.29~0.1.33） |
| `window/web-view.js` | `backgroundThrottling: false` 让隐藏窗口跑满定时器（用户喊卡的主因之一） |
| `window/web-view.js` | 错误页自己触发 `did-finish-load` → 无限重画 |
| `window/web-view.js` | 实例渲染进程崩溃不留痕（`oom` 与 `crashed` 是两个排查方向） |
| `window/main-window.js` | 无托盘还拦截关窗 → 进程成了用户关不掉的僵尸 |
| `window/tab-context-menu.js` | 隐藏放进"关闭"那一组 → 误点把收消息的窗口藏掉 |

## 已知的哑炮（已修）

记下来是因为**同类错误很容易再犯**：

- 代理预检日志引用作用域外的 `log`，外面裹 `catch(ignore){}`，
  所以不崩，但**一行日志都没写进去过**。而那段代码正是为了
  "真机出问题时手上只有一张截图"才加的。
- `errorCodeOf` 读 `e.pix.code`，但 `api-net.js` 把码放在 `e.code`，
  于是所有网络错误都落回 `TRANSLATE_FAILED`。

教训：`catch (e) {}` 之前先问一句"这里静默失败，事后还能查得出来吗"。
