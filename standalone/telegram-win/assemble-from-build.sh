#!/bin/zsh
# assemble-from-build.sh — 用「云编译产出的魔改 Telegram.exe」组装 HelloPix Windows 安装包
# 用法: ./assemble-from-build.sh /path/to/Telegram.exe   （云编译 artifact 解压后的 exe）
# 产物: ~/Desktop/HelloPix-Telegram-Windows.zip
set -euo pipefail

CUSTOM_EXE="${1:-}"
if [ -z "$CUSTOM_EXE" ] || [ ! -f "$CUSTOM_EXE" ]; then
  echo "用法: $0 /path/to/Telegram.exe" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
CACHE="$ROOT/.cache"
STAGE="$ROOT/.stage"
OUT="${HOME}/Desktop/HelloPix-Telegram-Windows.zip"
ELECTRON_VER="33.2.1"

mkdir -p "$CACHE"
rm -rf "$STAGE"
mkdir -p "$STAGE"

EL_ZIP="$CACHE/electron-v${ELECTRON_VER}-win32-x64.zip"
EL_URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VER}/electron-v${ELECTRON_VER}-win32-x64.zip"

echo ">> Electron: $EL_URL"
[ -f "$EL_ZIP" ] || curl -fL --retry 3 -o "$EL_ZIP" "$EL_URL"

echo ">> 组装目录"
APP="$STAGE/HelloPix-Telegram"
mkdir -p "$APP"
unzip -q -o "$EL_ZIP" -d "$APP"
rm -rf "$APP/resources/default_app.asar" "$APP/LICENSE" "$APP/LICENSES.chromium.html" "$APP/version"
mkdir -p "$APP/resources/app"
cp "$ROOT/main.js" "$ROOT/preload.js" "$ROOT/package.json" "$ROOT/win-dock.ps1" "$APP/resources/app/"
cp -R "$ROOT/lib" "$ROOT/renderer" "$APP/resources/app/"
cp "$ROOT/使用说明.txt" "$APP/"

echo ">> 放入魔改 Telegram.exe（云编译产物）"
mkdir -p "$APP/Telegram"
cp "$CUSTOM_EXE" "$APP/Telegram/Telegram.exe"
ls -lh "$APP/Telegram/Telegram.exe"

# 补齐官方的运行时文件集：官方便携包除了 exe 还带
# Telegram/modules/x64/d3d/d3dcompiler_47.dll，tdesktop 的 build.bat 也是从这里取的：
#   xcopy "%ReleasePath%\modules\%Platform%\d3d\d3dcompiler_47.dll" ...
# 而我们的云编译产物只有一个 Telegram.exe。Win10/11 的 System32 自带这个 DLL，
# 所以多数机器上缺了也能跑；但 tdesktop 仍支持 Win7（这正是要 -vcvars_ver=14.44 的原因），
# 那里没有 —— 缺了就可能是"电报打不开/渲染异常"这类难查的问题。
# 与其赌测试机是 Win10+，不如让运行时文件集与官方完全一致。
#
# 拿的是官方便携包里的那份，它是微软的可再发行 DLL，与电报版本无关，混用安全。
# 取不到就跳过（不阻断出包），但要明确说出来。
echo ">> 补齐官方运行时文件（modules/）"
TG_ZIP="$(ls -t "$CACHE"/tportable-x64.*.zip 2>/dev/null | head -1 || true)"
if [ -z "$TG_ZIP" ]; then
  echo "   ⚠️ .cache 里没有官方便携包，跳过 modules/。"
  echo "      本机测试通常无妨（Win10/11 自带 d3dcompiler_47.dll）；"
  echo "      要保证一致就先跑一次 ./assemble-windows.sh 把官方便携包拉到 .cache。"
else
  echo "   用 $TG_ZIP"
  rm -rf "$CACHE/telegram-unpack"
  mkdir -p "$CACHE/telegram-unpack"
  unzip -q -o "$TG_ZIP" -d "$CACHE/telegram-unpack"
  SRC_MODULES=""
  [ -d "$CACHE/telegram-unpack/Telegram/modules" ] && SRC_MODULES="$CACHE/telegram-unpack/Telegram/modules"
  [ -z "$SRC_MODULES" ] && [ -d "$CACHE/telegram-unpack/modules" ] && SRC_MODULES="$CACHE/telegram-unpack/modules"
  if [ -n "$SRC_MODULES" ]; then
    cp -R "$SRC_MODULES" "$APP/Telegram/"
    find "$APP/Telegram/modules" -type f -exec ls -lh {} \; | awk '{print "   + " $9 " (" $5 ")"}'
  else
    echo "   ⚠️ 官方便携包里没有 modules/，跳过。"
  fi
fi

mv "$APP/electron.exe" "$APP/HelloPixTelegram.exe"

echo ">> 打包到桌面"
rm -f "$OUT"
(cd "$STAGE" && zip -qry "$OUT" HelloPix-Telegram)
ls -lh "$OUT"
echo "完成: $OUT"
