#!/bin/zsh
# 本地后端常驻启动。
#
# 为什么需要它：交互式 shell 里 `nohup node ... &` 起的进程会随会话回收
# （macOS 上父进程退出后子进程被清理），表现为"启动成功 → 下一条命令就查不到进程"。
# 交给 launchd 托管后进程与终端解耦。
#
# ★ 路径必须全程 ASCII ★
# launchd 无法正确打开中文路径的脚本（退出码 127 + 乱码文件名），
# 所以统一通过 /tmp/pixapp 软链接访问项目目录，见 runner.sh。
set -u
ROOT="/tmp/pixapp"
cd "$ROOT" || exit 1

ENV_FILE="$ROOT/.env.local"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  echo "[$(date '+%F %T')] 已加载 $ENV_FILE"
else
  echo "[$(date '+%F %T')] 缺少 $ENV_FILE" >&2
  exit 1
fi

export DATABASE_URL
export REDIS_URL
export PIX_CREDENTIAL_KEY
export PIX_USE_PERSISTENT_BACKEND=1
export HOST=0.0.0.0
export PORT="${PORT:-3000}"
export NODE_ENV=development

echo "[$(date '+%F %T')] 启动 hello-pix 后端 PORT=$PORT"
NODE_BIN="/opt/homebrew/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
exec "$NODE_BIN" "$ROOT/server/index.js"
