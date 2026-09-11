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

mv "$APP/electron.exe" "$APP/HelloPixTelegram.exe"

echo ">> 打包到桌面"
rm -f "$OUT"
(cd "$STAGE" && zip -qry "$OUT" HelloPix-Telegram)
ls -lh "$OUT"
echo "完成: $OUT"
