#!/usr/bin/env bash
# hello-pix 启动前自检：核心依赖文件缺失时快速失败并留下清晰日志，
# 避免 systemd 以 auto-restart 反复拉起（上次 NRestarts=19）。
set -uo pipefail

APP_DIR="${1:-/opt/hello-pix}"
missing=0

# require <相对路径> <说明>
require() {
  local path="$APP_DIR/$1"
  if [ ! -e "$path" ]; then
    echo "[preflight] 缺失关键文件: $path  ($2)" >&2
    missing=$((missing + 1))
  fi
}

require "server/index.js"            "服务入口"
require "server/services/core-service.js" "核心服务"
require "desktop/shared/platforms.js"     "core-service 启动依赖的平台清单"
require "package.json"                    "依赖清单"
require "node_modules"                    "已安装依赖"

if [ ! -d "$APP_DIR/node_modules" ]; then
  echo "[preflight] node_modules 不存在，请先 npm ci" >&2
fi

if [ "$missing" -gt 0 ]; then
  echo "[preflight] 自检失败：$missing 项缺失，拒绝启动。修复后执行 systemctl restart hello-pix" >&2
  exit 78   # EX_CONFIG
fi

echo "[preflight] 自检通过，启动 $APP_DIR"
exit 0
