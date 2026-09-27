# macOS 安装包签名与「已损坏」问题

## 现象

用户从官网下载 `HelloPix-0.1.6-arm64.dmg`，双击后 macOS 弹：

> 「Hello Pix.app」已损坏，无法打开。你应该将它移到废纸篓。

**文件没有损坏。** 这是 Gatekeeper 的拦截，而且是最麻烦的那一种。

## 根因

`desktop/package.json` 的 mac 配置里写着 `"identity": null` —— 这是**显式关闭签名**。
electron-builder 于是完全跳过 `codesign`，bundle 里连 `_CodeSignature/` 目录都没有，
只剩 Electron 二进制自带的 linker 签名。那个签名是针对**原始 Electron.app** 的，
与 electron-builder 改造过的 bundle 对不上，`codesign --verify` 直接报：

```
code has no resources but signature indicates they must be present
```

实测 0.1.6 产物：

```
Identifier=Electron            ← 应该是 com.hellopix.desktop
Info.plist=not bound           ← Info.plist 未被签名覆盖
Sealed Resources=none          ← 完全没有资源封印
```

## 为什么「签名无效」比「没有签名」更糟

macOS 对**下载来的**（带 `com.apple.quarantine`）应用分两种判定，
差别恰恰在于**用户能不能自己救回来**：

| 签名状态 | 系统提示 | 用户能否自救 |
|---|---|---|
| **无效**（0.1.6 的情况） | 「已损坏，应移到废纸篓」 | **不能** —— Gatekeeper 走无旁路的代码路径，右键「打开」也没用，只能开终端 |
| **有效但不受信任**（ad-hoc） | 「无法验证开发者」 | **能** —— 右键点 App → 打开，一次即可 |
| 有效 + 已公证 | 无任何提示 | 不需要 |

所以修复的第一步不是"消除警告"，而是**把用户从"必须开终端"降到"右键打开"**。

## 已实施的修复

新增 `desktop/scripts/after-pack.js`，通过 electron-builder 的 `afterPack` 钩子
对 `.app` 做正规 ad-hoc 签名（`codesign --force --deep --sign - --timestamp=none`）。

该钩子是 **fail-closed** 的：签完必须再过一次 `--verify --deep --strict`，
并断言以下三项，任何一项不满足就**中断构建**：

1. `Identifier` 不能还是 `Electron`；
2. `Sealed Resources` 必须出现 `version=N`（异常时才是 `=none`）；
3. `Info.plist` 必须出现 `entries=N`（未被覆盖时是 `=not bound`）。

理由：签名失败若只打个警告，就会**静默产出**一个"已损坏"的安装包 ——
那正是本文要修的 bug，等于把它原样再发一遍。宁可发不出包，也不要发一个装不上的包。

> 两个踩过的坑，改代码前先看一眼：
> - `codesign -dv` 把信息写在 **stderr**。用 `execFileSync` 在成功时拿不到，
>   会导致断言静默失效（fail-open）。必须用 `spawnSync` 同时收 stdout + stderr。
> - 资源封印正常时输出是 `Sealed Resources version=2 rules=13 files=10`
>   （**没有 `=`**），只有异常时才是 `Sealed Resources=none`。两者不能套同一个正则。

## 怎么验证一次构建是好的

不用装、不用双击，两条命令即可：

```bash
# 1. 签名结构自洽（无输出 = 通过）
codesign --verify --deep --strict "/path/to/Hello Pix.app"

# 2. 身份与封印正确
codesign -dv --verbose=4 "/path/to/Hello Pix.app" | grep -E "Identifier|Signature|Info.plist|Sealed Resources"
```

期望看到：

```
Identifier=com.hellopix.desktop
Signature=adhoc
Info.plist entries=31
Sealed Resources version=2 rules=13 files=10
```

**注意**：只跑 `codesign -dv` 看 `Signature=adhoc` 是**不够**的 ——
0.1.6 也显示 `Signature=adhoc`，但 `Identifier=Electron`、封印为 `none`。
必须看 `Identifier` 和 `Sealed Resources`。

## 构建 macOS 安装包

```bash
cd desktop
npx electron-builder --mac dmg --x64 --arm64 --publish never
```

`--x64 --arm64` 不能省：只写 `--mac dmg` 时 electron-builder 只出当前机器架构的包。

## 彻底解决：Developer ID + 公证

ad-hoc 签名**不证明开发者身份**，也无法公证，用户首次打开仍要进系统设置放行一次。
要让双击即开、零提示，唯一的路是 Apple Developer Program（$99/年）→
**Developer ID Application** 证书 → 签名 + 公证。

### 代码侧：已经铺好了（无需再改）

| 位置 | 状态 |
|---|---|
| `desktop/package.json` mac.identity | **已移除** `null`（留空 = 自动发现证书） |
| `desktop/build/entitlements.mac.plist` | 已新增（Electron 必需的 3 条 entitlement） |
| `desktop/package.json` mac.hardenedRuntime | 已显式设为 `true`（公证强制要求） |
| `desktop/package.json` mac.notarize | 已显式设为 `true` |
| `desktop/scripts/after-pack.js` | 已能**自动判断**：有证书就让位正式签名，没证书才 ad-hoc 兜底 |
| `desktop/scripts/after-sign.js` | 已新增：签名/公证状态的 fail-closed 复核 |

> **为什么必须删掉 `identity: null`**：electron-builder 的 `sign()` 在
> `qualifier === null` 时**直接 return**，而 `notarizeIfProvided()` 排在其后 ——
> 也就是说留着那三个字，**公证永远不可能发生**。这是它必须被移除的原因。

### 账号与证书：需要你准备的部分

1. **Apple Developer Program**（$99/年）
   - 个人身份：需开启两步验证的 Apple ID + 实名信息，通常 **1–2 天** 通过
   - 公司身份：另需 **D-U-N-S 编码（邓白氏）**，可能 **1–2 周**，是最长的等待项
2. **Developer ID Application 证书**（注意不是 "Apple Development"、也不是
   "Mac App Distribution"）：生成 CSR → developer.apple.com 签发 → 导入构建机
   钥匙串 → 导出 `.p12` 备份（换机器要用）
3. **Team ID**（10 位，账号页可见）
4. **公证凭据**，三选一（推荐第 1 种，权限最小）：

   | 方式 | 环境变量 |
   |---|---|
   | App Store Connect API Key（推荐） | `APPLE_API_KEY`（**.p8 文件路径**）、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER` |
   | App 专用密码 | `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` |
   | 钥匙串 profile | `APPLE_KEYCHAIN_PROFILE`（本机专用，不适合 CI） |

   `APPLE_APP_SPECIFIC_PASSWORD` 是在 appleid.apple.com 单独生成的专用密码，
   不是 Apple ID 登录密码。`.p8` 只能下载一次，务必备份。

### 拿到证书后怎么发版

```bash
cd desktop
npm run pack:mac:release     # = PIX_REQUIRE_NOTARIZED=1 electron-builder --mac
```

`PIX_REQUIRE_NOTARIZED=1` 会让「没公证」的构建**直接失败**，而不是照样产出安装包。

### 两个守卫，以及它们防的是什么

electron-builder 在**拿不到公证凭据时只打一条 warning 就跳过公证**，构建照样成功。
后果是你会发出一个「签了名但没公证」的包，**用户照样看到「无法验证」那张图**，
而构建日志末尾看不出异常 —— 与 0.1.6 那次「静默产出已损坏安装包」是同一种病。

所以加了两个 fail-closed 守卫：

| 环境变量 | 行为 |
|---|---|
| `PIX_REQUIRE_NOTARIZED=1` | 未公证 → **构建失败**（发版时用） |
| `PIX_ADHOC_SIGN=0` | 本机无 Developer ID 证书 → **构建失败** |
| `PIX_ADHOC_SIGN=1` | 强制走 ad-hoc（调试用，即使有证书） |

另外 `after-sign.js` 在**配了公证凭据却没钉上票据**时一定失败 —— 这是最危险的一种，
因为它看起来"配置齐全"。

### 怎么验收（别在构建机上测）

Gatekeeper 有缓存，**必须在一台从没见过这个 App 的机器**、或新建用户账号上测：

```bash
# 1) 身份与团队：期望 Authority=Developer ID Application: xxx
codesign -dv --verbose=4 "/Applications/Hello Pix.app"

# 2) 票据已钉上（离线也能开）：期望 "The validate action worked!"
xcrun stapler validate "/Applications/Hello Pix.app"

# 3) Gatekeeper 终判：期望 accepted  source=Notarized Developer ID
spctl -a -vvv -t install "/Applications/Hello Pix.app"
```

第 3 条出现 `source=Notarized Developer ID` 才算成了 —— 这时
安装包里的《首次打开说明》与本节下面的放行引导**都可以删掉**。

## 客户侧放行步骤（当前仍需，且**随系统版本不同**）

> **最容易踩的坑**：很多网上流传的教程、甚至我们官网上第一版写的都是
> 「右键点 App → 打开 → 再点打开」。这条路在 **macOS 15 Sequoia 已被 Apple 移除**。
> Apple 官方原文：
>
> > "In macOS Sequoia, users will no longer be able to Control-click to override
> > Gatekeeper when opening software that isn't signed correctly or notarized.
> > They'll need to visit System Settings > Privacy & Security to review security
> > information for software before allowing it to run."
>
> 照旧教程写引导，客户会**照着做却打不开**，然后认定我们的软件有问题。

**macOS 15 Sequoia 及更新**（当前主流）：

1. 先把 App 拖进「应用程序」文件夹，从那里双击（直接在 dmg / 「下载」里运行会触发
   App Translocation，被当作临时文件）；
2. 出现「无法验证开发者」提示，点「完成」关掉；
3. 系统设置 → 隐私与安全性 → 向下滚到「安全性」一节 → 点「仍要打开」；
4. 输入开机密码。此后双击即可打开。

「仍要打开」按钮**只在尝试打开后约一小时内出现**，超时要重来一次第 2 步。

**macOS 14 及更早**：在「应用程序」里右键点 App → 打开 → 再点「打开」。

**通用快捷解法**（任何版本，跳过图形界面）：

```bash
xattr -cr /Applications/Hello\ Pix.app
```

原理是去掉 `com.apple.quarantine` 隔离标记 —— Gatekeeper 的启动检查正是由它触发的。
注意 macOS 的放行例外按**签名身份（cdhash）缓存**，同一签名的 App 一旦放行过，
之后哪怕重新下载、重新打隔离属性也不会再拦。这会让本地复现"被拦"变得困难
（实测踩过：同一版本先成功打开过一次，后续测试就无法复现拦截态）。

官网下载区已放了一份折叠的分版本说明（`src/components/Landing.vue` 里的
`.install-help`），客户不用找客服就能自助解决。
