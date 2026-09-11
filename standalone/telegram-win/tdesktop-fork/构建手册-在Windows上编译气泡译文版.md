# Hello Pix 气泡译文版 —— Windows 编译手册

> 目标：把桌面那份已改好的 tdesktop 源码，在 **Windows** 上编译出带 `[译文]` 气泡的 `Telegram.exe`，替换进多开启动器。
> 补丁对齐锚点：`v7.2.8`（commit `272f6f5c`，已对真实 tag 源码逐处验证 7/7 命中且幂等）。

---

## 一、你需要准备的三样东西

| 项目 | 说明 |
|---|---|
| **一台 Windows 电脑** | Win10/11，建议 ≥ 8 核、≥ 16GB 内存、**≥ 80GB 空闲磁盘**（准备 + 编译 + Qt 缓存吃得很凶） |
| **Visual Studio 2026** | 装「使用 C++ 的桌面开发」工作负载 + Windows 10/11 SDK (10.0.26100.0)。⚠️ tdesktop v7.2.8 **要求 VS2026**，VS2022 会缺工具链报错 |
| **C++ ATL（必装）** | 在 VS Installer →「单个组件」搜 `ATL`，勾上 **C++ ATL for latest v143 build tools (x86 & x64)**。不装的话 prepare 会在 breakpad 阶段报 `error C1083: Cannot open include file: 'atlbase.h'`（CI 上由 apply.py 自动补装，本机必须手动勾） |
| **API 凭据** | 到 [my.telegram.org](https://my.telegram.org) 登录 → API development tools → 申请你自己的 **api_id / api_hash**（官方让每个客户端用自己的，别拿别人的） |

另需软件（安装时勾选加入 PATH）：
- **Python 3.10.x**：https://www.python.org/downloads/
- **Git for Windows**：https://git-scm.com/download/win

> 若系统还装了新版 Python，去 `设置 → 应用 → 高级应用设置 → 应用执行别名` 把 `python.exe / python3.exe` 别名**关掉**，否则 prepare 会跑错版本。

---

## 二、开始（全程只开一个窗口）

打开 **"x64 Native Tools Command Prompt for VS 2026"**（开始菜单里搜得到；别用普通 CMD），然后：

### 方式 A：让脚本自己搞定（推荐）

把 `tdesktop-fork` 整个文件夹拷到 Windows（里面有 `apply.py`、补丁源码、`build-on-windows.bat`），在 VS 命令行里进到该目录执行：

```bat
build-on-windows.bat fresh
```

脚本会依次做：clone → 固定锚点 `v7.2.8` → 拉子模块 → `apply.py` 打补丁（并复核 HEAD 就是该 tag）→ 下载三方依赖 → 交互式让你填 api_id/api_hash → configure → msbuild 编译。**全程约 2~5 小时**（大头是下载依赖和编译），中途别关窗口。

- 不想交互填凭据：先在同目录建 `build-credentials.txt`，**一行写两个值，空格分隔**：`你的api_id 你的api_hash`（这个文件等同密钥，别外传别提交）。
- 源码若已就绪（跳过 clone/打补丁）：直接跑 `build-on-windows.bat`。

### 方式 B：手动分步（想看清每步干了啥）

```bat
:: 1) 建目录
mkdir D:\TBuild\ThirdParty
mkdir D:\TBuild\Libraries

:: 2) 拉源码并固定到已验证锚点（大,耐心等）
cd /d D:\TBuild
git clone --recursive https://github.com/telegramdesktop/tdesktop.git
cd tdesktop
git checkout -f refs/tags/v7.2.8
git submodule update --init --recursive --depth 1

:: 3) 打入 Hello Pix 补丁（用拷过来的 apply.py）
python D:\path\to\tdesktop-fork\apply.py %cd%

:: 4) 下载/准备三方依赖（首次 1~3 小时）
D:\TBuild\tdesktop\Telegram\build\prepare\win.bat

:: 5) 生成 VS 工程（换成你自己的 api_id / api_hash）
cd /d D:\TBuild\tdesktop\Telegram
configure.bat x64 -D TDESKTOP_API_ID=你的api_id -D TDESKTOP_API_HASH=你的api_hash

:: 6) 编译
cd /d D:\TBuild\tdesktop\out
msbuild Telegram.slnx /p:Configuration=Release /p:Platform=x64 /m /v:m
```

产物：`D:\TBuild\tdesktop\out\Release\Telegram.exe`（Debug 版在同级 `Debug\` 下）。

---

## 三、替换 + 首次验证

1. 把编译出的 `Telegram.exe` **替换**多开启动器安装包内的：`HelloPix-Telegram\Telegram\Telegram.exe`
   （若版本号警告/闪退，把整个 `HelloPix-Telegram\Telegram\` 文件夹一并换掉即可）
2. 打开启动器 → 登录一个账号 → 程序会在该实例的 `-workdir` 里写 `hello-pix-bridge.json`
3. 进一个**发外文消息**的会话，等 1~2 秒看气泡是否出现 `原文 + [译文]` 行
4. 验证扣费：去 Hello Pix 后台看该设备的字符余额有没有被扣（桥接里的 deviceId 对应你的计费设备）

**桥接 json 字段**（启动器写的，tdesktop 侧读的）：
```jsonc
{
  "apiBase":   "https://你的后端",     // 必填,末尾自动去斜杠
  "deviceId":  "...",                  // 计费设备标识,进 X-Pix-Device 头
  "cookies":   { "...": "..." },       // 转 Cookie 头
  "engine":    "youdao",               // 默认有道
  "lang":      "zh",                   // 目标语言,默认中文
  "transRecv": true,                   // 收消息翻译总开关
  "transSend": true,
  "transGroup": true                   // 群组/频道是否也翻(默认 true)
}
```

---

## 四、常见坑（按发生概率排）

1. **克隆/下载慢**：prepare 阶段走 GitHub 下载 Qt 等依赖，挂代理或换 `ghproxy` 前缀地址能快很多。
2. **磁盘爆了**：整个流程峰值占 40~80GB，务必 ≥ 80GB 空闲。
3. **`configure` 报 API 凭据错**：看 `Telegram/cmake/telegram_options.cmake` 第 16 行，两个 `-D` 都要传对。
4. **`msbuild` 找不到**：说明窗口不是 VS 环境，重新从 "x64 Native Tools Command Prompt" 打开再跑。
5. **VS2022 用户**：dev 分支要求 VS2026；硬要用 2022，需要手动 `-vcvars_ver=14.44` + SDK 26100，仍可能失败——建议直接装 VS2026 Community。
6. **编译报错定位**：先看报错文件是不是 `lang/hello_pix_translate_provider.*`。若是补丁本身问题，把报错整段截图给灵儿改；若是 tdesktop 自身源码报错，通常是 SDK/工具链版本不齐。

---

## 五、升级到新版本时怎么办

1. `git checkout 新tag` → `git submodule update --init --recursive`
2. 重新跑 `python apply.py %cd%`（apply.py 对每处修改都有锚点校验，**改不动会明确报错而不是静默破坏**）
3. 若报「找不到补丁锚点」，说明上游改动了大结构——把报错贴给灵儿，几分钟就能更新锚点。

---

## 六、GPL 提醒（一句话，别踩）

tdesktop 是 GPLv3。你分发**改过的 Telegram.exe** 时，按 GPL 需向拿到你 exe 的人**提供对应修改版完整源码**（比如给个指向本 fork 源码仓库的链接，附上补丁说明）。这是合规红线，别裸发 exe 不留源码入口。
