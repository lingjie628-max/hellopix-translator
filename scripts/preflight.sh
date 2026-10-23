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

# systemd 自己要用到的脚本也必须检查。
#
# 2026-10-23 事故：deploy-code.sh 把 scripts/ 整目录替换成仓库版本，
# 而 preflight.sh 当时只存在于生产、仓库里没有 —— 被删掉之后
# ExecStartPre 指向一个不存在的文件，systemd 报 status=203/EXEC，
# 服务**根本起不来**，全站 API 返回 000。
#
# 也就是说：这个"启动前自检"脚本本身被删掉时，它没有机会自检。
# 补救办法有两个 ——
#   1. 把它纳入仓库（已做），脚本不再只活在生产
#   2. deploy-code.sh 保留生产独有文件（已做）
# 同时把 systemd 依赖的脚本也列进来，将来若再被误删，至少
# nginx/migrate 那一步能给出明确日志，而不是 203/EXEC。
require "scripts/migrate.js"              "systemd ExecStartPre 迁移入口"
require "scripts/preflight.sh"            "systemd ExecStartPre 启动自检"

if [ ! -d "$APP_DIR/node_modules" ]; then
  echo "[preflight] node_modules 不存在，请先 npm ci" >&2
fi

if [ "$missing" -gt 0 ]; then
  echo "[preflight] 自检失败：$missing 项缺失，拒绝启动。修复后执行 systemctl restart hello-pix" >&2
  exit 78   # EX_CONFIG
fi

echo "[preflight] 自检通过，启动 $APP_DIR"
exit 0
