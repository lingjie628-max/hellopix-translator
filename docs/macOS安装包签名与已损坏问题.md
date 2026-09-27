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

ad-hoc 签名**不证明开发者身份**，也无法公证，用户仍要右键一次。要让双击即开、
零提示，唯一的路是 Apple Developer Program（$99/年）：

1. 申请开发者账号，签发 **Developer ID Application** 证书，装进构建机的钥匙串；
2. 删掉 `desktop/package.json` mac 配置里的 `"identity": null`（让它自动发现证书）；
3. 构建时提供 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`。

`@electron/notarize` 已经作为 electron-builder 的依赖装在 `node_modules` 里，
**不需要新增依赖**。届时 electron-builder 的正式签名会跑在 `afterPack` 之后，
把 ad-hoc 签名覆盖掉，两者不冲突。

## 客户侧应急解法（当前仍需）

安装后在「终端」执行，清掉下载隔离标记：

```bash
xattr -cr /Applications/Hello\ Pix.app
```

官网下载区已放了一份折叠的图文说明（`src/components/Landing.vue` 里的
`.install-help`），客户不用找客服就能自助解决。
