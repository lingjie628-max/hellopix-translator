# 渲染层结构地图

`renderer/` 原来是一个 3101 行的 `app.js`。现在拆成 7 个脚本，`app.js` 只剩**编排与事件绑定**。

## 加载方式与顺序（最重要的一件事）

渲染层用的是**传统 `<script>`，没有 module**。它们共享同一个全局作用域，
靠 `index.html` 里的**标签顺序**保证依赖。

    theme.js → dom.js → pure.js → proxy-panel.js → tabs.js → add-app.js → trans-bar.js → app.js

规则只有一条：**`app.js` 永远在最后**，其余模块的顶层声明必须先就位。

顺序错了就是**白屏**，而且不一定会报错——顶层 `const` 重复声明会直接
`SyntaxError`，整页起不来。这不是理论风险：拆分 `pure.js` 时就因为
`LANG_PRIORITY` 复制了一份没删干净，真的白屏过。

所以有两道闸：

| 手段 | 抓什么 |
| --- | --- |
| `test/renderer-assets.test.js` | 脚本顺序、跨文件重复声明、id 是否存在、CSP |
| `cd desktop && node verify-renderer.js` | **真实渲染**：加载 index.html，检查符号可达、页面非白屏、无顶层异常 |

改完渲染层，两条都要跑。

## 目录

| 文件 | 职责 | 为什么单独放 |
| --- | --- | --- |
| `dom.js` | 182 个元素句柄 | 纯取值，零耦合，却占了原文件前 194 行 |
| `pure.js` | 纯函数 + 语种表（189 条） | 不碰 DOM，能被 node 直接测 |
| `proxy-panel.js` | 编辑已存在线路的代理 | 只改这一条线路，不新建 partition、不动 usedCount |
| `tabs.js` | 标签栏：渲染、拖拽、重命名、滚轮 | 坑最多的一块，注释密集 |
| `add-app.js` | 新增应用弹窗 | 两条会造成**真实扣费**的规则在里面 |
| `trans-bar.js` | 聊天翻译工具条 | `authoritativeEngine` 的优先级规则 |
| `app.js` | 登录、外壳、事件绑定、编排 | 剩下的都在这 |

## 跨模块的共享状态

没有模块系统，所以状态仍挂在全局作用域上。**这是现状，不是设计**：

- `tabs.js` 读 `lastTabs` / `selectedId` / `editingTabId` / `checkedIds`（`app.js` 维护）
- `add-app.js` 的 `addAppItem` 被 `app.js` 的保存/更新按钮读写
- `trans-bar.js` 的 `engineRows` / `canSwitchEngine` / `authoritativeEngine`
  由 `app.js` 的 `enterShell` 写入，`add-app.js` 也会读

**反向依赖是安全的，前提是只在函数体内调用。** 比如 `tabs.js` 调用
`app.js` 里的 `confirmAction`、`trans-bar.js` 调用 `engineToShow`——
它们都发生在事件回调里，那时 `app.js` 早加载完了。但如果谁在
**顶层**调用另一个文件的函数，就是 `ReferenceError`。

## 测试怎么跟上

很多测试是"在源码里找某段实现"。以前它们直接读 `app.js`，于是每拆一次
模块就坏一片，导致没人敢继续拆。

现在统一走 `test/helpers/renderer-src.js`：

```js
const rendererSrc = require('./helpers/renderer-src')
const appSrc = rendererSrc.all()   // 按 index.html 真实顺序拼接的全部源码
```

测试就与文件划分解耦了。**新写的源码断言请用它**，别再 `readFileSync('app.js')`。

## 历史事故索引

| 位置 | 事故 |
| --- | --- |
| `pure.js` `cmpVer` | `'v1.2.3'.split(/[^\d]+/)` 开头产生空段被当成 0，同一版本被判成更旧 → 更新检查永远说"已是最新" |
| `index.html` 脚本顺序 | `pure.js` 复制了一份 `LANG_PRIORITY` 没删，重复 `const` → 整页白屏 |
| `tabs.js` `attachTabsWheel` | 浏览器只在纵向也溢出时才映射垂直滚轮，所以横向标签栏的滚轮**完全无效**，用户只能拖滚动条 |
| `tabs.js` `keepActiveTabVisible` | 不自动滚进视野 → 新建的窗口"看不见"，观感是点了没反应 |
| `add-app.js` `groupModeUiValue` | 缺省回落 `inherit` 会把"手动"悄悄改成"跟随账号自动"，账号级开着自动就是预期外扣费 |
| `trans-bar.js` `engineToShow` | 直接显示账号里存的通道，用户看到 GPT 却按 DeepSeek 扣费 |
