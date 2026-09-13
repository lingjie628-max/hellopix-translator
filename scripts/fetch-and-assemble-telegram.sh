#!/bin/zsh
# fetch-and-assemble-telegram.sh — 从 CI 取回魔改 Telegram.exe 并组装成 Windows 安装包
#
# 存在的理由：最后一步是手工的（去 Actions 页面点 Artifacts、下载、解压、再喂给
# assemble-from-build.sh），而这一步最容易出的错是**拿错 exe** —— 比如抓到一轮
# 用官方测试凭据编的包，或者抓到旧的官方原版。装错了的现象是气泡不出译文，
# 和"编译失败"完全一样，又要排查一轮。
#
# 这个脚本只认"带 Telegram-exe 产物的成功运行"，并且组装前后都把 SHA256 打出来，
# 方便和验收文档里的比对。
#
# 用法：
#   ./scripts/fetch-and-assemble-telegram.sh              # 取最近一次成功的产物
#   ./scripts/fetch-and-assemble-telegram.sh <run-id>     # 指定 run
set -euo pipefail

REPO="lingjie628-max/hellopix-tdesktop-build"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WIN_DIR="$ROOT/standalone/telegram-win"
WORK="$(mktemp -d)"

RUN_ID="${1:-}"
if [ -z "$RUN_ID" ]; then
  echo ">> 找最近一次成功的运行"
  RUN_ID="$(gh run list --repo "$REPO" --workflow build-hellopix-telegram \
    --status success --limit 1 --json databaseId --jq '.[0].databaseId')"
  if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
    echo "没有成功的运行。先确认仓库密钥 TDESKTOP_API_ID / TDESKTOP_API_HASH 已配置，"
    echo "再触发一轮：gh workflow run build-hellopix-telegram --repo $REPO"
    exit 1
  fi
fi
echo ">> run: $RUN_ID"

echo ">> 下载 artifact（只下载成功产物；测试凭据那轮本来就不上传）"
gh run download "$RUN_ID" --repo "$REPO" -n Telegram-exe -D "$WORK"

EXE="$(find "$WORK" -name Telegram.exe -type f | head -1)"
if [ -z "$EXE" ]; then
  echo "artifact 里没有 Telegram.exe，实际内容："
  find "$WORK" -type f | head -20
  exit 1
fi

echo "\n>> 产物信息"
ls -lh "$EXE" | awk '{print "   大小: " $5}'
echo "   SHA256: $(shasum -a256 "$EXE" | cut -d' ' -f1)"

echo "\n>> 组装安装包"
cd "$WIN_DIR"
zsh ./assemble-from-build.sh "$EXE"

OUT="$HOME/Desktop/HelloPix-Telegram-Windows.zip"
echo "\n>> 确认包里的 exe 就是刚下载的那个"
IN_ZIP="$(unzip -p "$OUT" HelloPix-Telegram/Telegram/Telegram.exe | shasum -a256 | cut -d' ' -f1)"
IN_SRC="$(shasum -a256 "$EXE" | cut -d' ' -f1)"
if [ "$IN_ZIP" = "$IN_SRC" ]; then
  echo "   ✅ 一致 ($IN_ZIP)"
else
  echo "   ❌ 不一致：包里 $IN_ZIP / 下载的 $IN_SRC"
  exit 1
fi

echo "\n完成: $OUT"
echo "验收按 docs/电报独立版验收步骤.md 走（第四节是 Windows 真机清单）。"
