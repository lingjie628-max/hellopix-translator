@echo off
setlocal enabledelayedexpansion

rem ===========================================================================
rem  Hello Pix 气泡译文版 Telegram.exe —— Windows 一键构建驱动
rem  适用 tdesktop 源码锚点: v7.2.8 (commit 272f6f5c, 补丁锚点已 7/7 验证)
rem
rem  前提: 已安装 Git for Windows + Python 3.10(勾选 Add to PATH) + VS2026
rem        已初始化 VS x64 环境(建议直接用 "x64 Native Tools Command Prompt
rem        for VS 2026" 打开本脚本), 已有 my.telegram.org 的 api_id/api_hash
rem
rem  用法:
rem    build-on-windows.bat fresh    从零克隆源码->打补丁->构建(网络耗时最长)
rem    build-on-windows.bat          源码已就绪(D:\TBuild\tdesktop 已含补丁)
rem ===========================================================================

set "BUILD=D:\TBuild"
set "SRC=%BUILD%\tdesktop"
set "KIT=%~dp0"
set "PIN=v7.2.8"

rem ---------- 0. 环境自检 ----------
echo.
echo === [0/6] 环境自检 ===

if not defined Platform (
  echo [错误] 请勿在普通 CMD 运行本脚本。
  echo        请打开 "x64 Native Tools Command Prompt for VS 2026" 再执行,
  echo        或先执行:  vcvars64.bat -vcvars_ver=14.44
  exit /b 1
)
echo [OK] VS x64 环境已就绪 (Platform=%Platform%)

where git >nul 2>&1
if errorlevel 1 ( echo [错误] 未找到 git,请先安装 Git for Windows & exit /b 1 )
echo [OK] git

rem 找一个可用的 python(3.10)
set "PYEXE="
if exist "%LocalAppData%\Programs\Python\Python310\python.exe" set "PYEXE=%LocalAppData%\Programs\Python\Python310\python.exe"
if not defined PYEXE if exist "%ProgramFiles%\Python310\python.exe" set "PYEXE=%ProgramFiles%\Python310\python.exe"
if not defined PYEXE if exist "%ProgramFiles(x86)%\Python310\python.exe" set "PYEXE=%ProgramFiles(x86)%\Python310\python.exe"
if not defined PYEXE if exist "C:\Python310\python.exe" set "PYEXE=C:\Python310\python.exe"
if not defined PYEXE (
  where py >nul 2>&1
  if not errorlevel 1 (
    py -3.10 --version >nul 2>&1 && set "PYEXE=py -3.10"
  )
)
if not defined PYEXE (
  echo [错误] 未找到 Python 3.10。
  echo        到 https://www.python.org/downloads/ 安装 3.10.x,
  echo        安装时务必勾选 "Add python.exe to PATH";如为系统管理员安装请选 for all users。
  echo        若系统里同时有新版 Python,请在"应用执行别名"里关掉 python.exe/python3.exe 别名。
  exit /b 1
)
echo [OK] Python: %PYEXE%
"%PYEXE%" --version

rem ---------- 1. 源码就绪(fresh 模式自动 clone+patch) ----------
echo.
echo === [1/6] 源码就绪 ===
mkdir "%BUILD%\ThirdParty" 2>nul
mkdir "%BUILD%\Libraries" 2>nul

set "MODE=%1"
if /i "%MODE%"=="fresh" goto fresh
if exist "%SRC%\Telegram\CMakeLists.txt" goto mode_check
echo [提示] %SRC% 下没发现 tdesktop 源码。
set /p GOFRESH=是否自动 clone 一份并打补丁?(y/n):
if /i not "!GOFRESH!"=="y" ( echo 请把已打补丁的 tdesktop 放到 %SRC% 后重试 & exit /b 1 )
:fresh
echo [开始] 从 GitHub 克隆 tdesktop 并固定到已验证锚点 %PIN%
if exist "%SRC%\.git" (
  echo [跳过] 已存在源码目录,不重复 clone
) else (
  git clone --recursive https://github.com/telegramdesktop/tdesktop.git "%SRC%"
  if errorlevel 1 ( echo [错误] clone 失败,请检查网络/代理 & exit /b 1 )
)
cd /d "%SRC%"
git checkout -f refs/tags/%PIN%
if errorlevel 1 ( echo [错误] 切到锚点 %PIN% 失败 & exit /b 1 )
git submodule update --init --recursive --depth 1
if errorlevel 1 ( echo [错误] 子模块拉取失败 & exit /b 1 )
echo [OK] 已固定到 %PIN%

:mode_check
if not exist "%SRC%\Telegram\SourceFiles\lang\hello_pix_translate_provider.cpp" (
  echo [补丁] 检测到未打补丁,执行 apply.py ...
  "%PYEXE%" "%KIT%apply.py" "%SRC%"
  if errorlevel 1 ( echo [错误] apply.py 打补丁失败,见上方提示 & exit /b 1 )
  echo [OK] 补丁已打入
) else (
  echo [跳过] 源码已含 Hello Pix 补丁
)

rem ---------- 2. 下载/准备三方依赖(仅首次,可能 1~3 小时) ----------
echo.
echo === [2/6] 准备三方依赖 (prepare) ===
call "%SRC%\Telegram\build\prepare\win.bat"
if errorlevel 1 ( echo [错误] prepare 失败 & exit /b 1 )

rem ---------- 3. api_id / api_hash ----------
echo.
echo === [3/6] API 凭据 ===
set "AID="
set "AHASH="
rem 优先读本文件旁的 build-credentials.txt: 一行两个值, 空格分隔 "api_id api_hash"
if exist "%KIT%build-credentials.txt" (
  for /f "usebackq tokens=1* delims= " %%a in ("%KIT%build-credentials.txt") do (
    if not defined AID set "AID=%%a"
    if not defined AHASH set "AHASH=%%b"
  )
)
if not defined AID (
  echo 请输入 my.telegram.org 申请到的 api_id / api_hash:
  set /p AID=api_id:
  set /p AHASH=api_hash:
)
if not defined AID ( echo [错误] api_id 不能为空 & exit /b 1 )
echo [OK] 将使用 api_id=%AID%

rem ---------- 4. configure 生成 VS 工程 ----------
echo.
echo === [4/6] configure ===
cd /d "%SRC%\Telegram"
configure.bat x64 -D TDESKTOP_API_ID=%AID% -D TDESKTOP_API_HASH=%AHASH%
if errorlevel 1 ( echo [错误] configure 失败 & exit /b 1 )

rem ---------- 5. 编译 ----------
echo.
echo === [5/6] 编译 (Release, 1~3 小时, 别关窗口) ===
cd /d "%SRC%\out"
if exist Telegram.slnx (
  msbuild Telegram.slnx /p:Configuration=Release /p:Platform=x64 /m /v:m
  if errorlevel 1 (
    echo [提示] 命令行编译失败,请用 VS2026 打开 %SRC%\out\Telegram.slnx
    echo        在解决方案资源管理器右键 Telegram 项目 -^> 生成(选 Release x64)
    goto final
  )
) else (
  echo [提示] 未找到 Telegram.slnx,请手动用 VS2026 打开 %SRC%\out 下的工程并编译
  goto final
)

rem ---------- 6. 产物 ----------
:final
echo.
echo === [6/6] 完成 ===
if exist "%SRC%\out\Release\Telegram.exe" (
  echo [成功] 产物: %SRC%\out\Release\Telegram.exe
  echo 请用它替换多开启动器安装包里的 HelloPix-Telegram\Telegram\Telegram.exe
  echo 若只做功能验证,Debug 版在 %SRC%\out\Debug\Telegram.exe
) else if exist "%SRC%\out\Debug\Telegram.exe" (
  echo [成功] 产物: %SRC%\out\Debug\Telegram.exe
  echo 请用它替换多开启动器安装包里的 HelloPix-Telegram\Telegram\Telegram.exe
) else (
  echo [错误] 没找到编译产物,请回到第 5 步检查 VS 编译是否成功
)
pause
exit /b 0
