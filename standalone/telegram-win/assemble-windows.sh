#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CACHE="$ROOT/.cache"
STAGE="$ROOT/.stage"
OUT="${HOME}/Desktop/HelloPix-Telegram-Windows.zip"
ELECTRON_VER="33.2.1"

mkdir -p "$CACHE"
rm -rf "$STAGE" "$CACHE/telegram-unpack"
mkdir -p "$STAGE"

echo ">> 查询官方 Telegram 最新 Windows 便携版"
curl -fsSL "https://api.github.com/repos/telegramdesktop/tdesktop/releases/latest" -o "$CACHE/tdesktop-latest.json"
TG_URL="$(python3 -c '
import json
from pathlib import Path
data = json.loads(Path("'"$CACHE"'/tdesktop-latest.json").read_text())
for asset in data["assets"]:
    if asset["name"].startswith("tportable-x64.") and asset["name"].endswith(".zip"):
        print(asset["browser_download_url"])
        raise SystemExit
raise SystemExit("未找到 tportable-x64.zip")
')"
TG_ZIP="$CACHE/$(basename "$TG_URL")"
EL_ZIP="$CACHE/electron-v${ELECTRON_VER}-win32-x64.zip"
EL_URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VER}/electron-v${ELECTRON_VER}-win32-x64.zip"

echo ">> Telegram: $TG_URL"
echo ">> Electron: $EL_URL"
[ -f "$TG_ZIP" ] || curl -fL --retry 3 -o "$TG_ZIP" "$TG_URL"
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
cp "$ROOT/诊断.ps1" "$APP/"
# 这条路径拿的是官方原版 Telegram，气泡不会出译文；而 使用说明.txt 描述的是
# 魔改版（assemble-from-build.sh 组装的）。这里显式追一句，别让用户拿着
# 原版包去对照说明里"气泡会显示 [译文]"，又变成一次"没报错但没效果"。
cat >> "$APP/使用说明.txt" <<'EOF'

【本包说明】本包里的 Telegram 是官方原版，不含气泡译文魔改。
要气泡里直接出 [译文]，请用 assemble-from-build.sh 组装云编译产出的魔改 Telegram.exe。
EOF
mkdir -p "$APP/Telegram" "$CACHE/telegram-unpack"
unzip -q -o "$TG_ZIP" -d "$CACHE/telegram-unpack"
if [ -f "$CACHE/telegram-unpack/Telegram.exe" ]; then
  cp -R "$CACHE/telegram-unpack/." "$APP/Telegram/"
elif [ -f "$CACHE/telegram-unpack/Telegram/Telegram.exe" ]; then
  cp -R "$CACHE/telegram-unpack/Telegram/." "$APP/Telegram/"
else
  echo "未在便携包里找到 Telegram.exe"
  find "$CACHE/telegram-unpack" -maxdepth 3 -name 'Telegram.exe' || true
  exit 1
fi
mv "$APP/electron.exe" "$APP/HelloPixTelegram.exe"

echo ">> 打包到桌面"
rm -f "$OUT"
(cd "$STAGE" && zip -qry "$OUT" HelloPix-Telegram)
ls -lh "$OUT"
echo "完成: $OUT"
