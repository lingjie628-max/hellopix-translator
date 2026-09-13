#!/bin/zsh
# 本地后端重启脚本。
#
# 背景：本机后端原先是用手工注入的环境变量跑的，仓库里没有记录，进程一停就
# 无从恢复（数据库密码与厂商密钥加密密钥都随进程一起没了）。配置现在集中到
# .env.local（已 gitignore），脚本自动读取。
#
# 用法：
#   ./scripts/dev-backend.sh                                 # 读 .env.local
#   DATABASE_URL='postgres://...' ./scripts/dev-backend.sh   # 临时覆盖
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.env.local"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  echo "已加载 $ENV_FILE"
fi

if [ -z "$DATABASE_URL" ]; then
  echo "缺少 DATABASE_URL。请先创建 .env.local（参考 .env.example），或临时注入："
  echo "  DATABASE_URL='postgres://user:pass@127.0.0.1:55432/hello_pix' ./scripts/dev-backend.sh"
  exit 1
fi

export DATABASE_URL
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:56379/0}"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-3000}"
# 本地起的不算生产：生产模式会强制要求 DATABASE_URL 含凭据、并校验 CORS/HTTPS 等
export NODE_ENV="${NODE_ENV:-development}"

LOG=/tmp/pix-backend.log
echo "启动后端 -> $LOG"
echo "  PORT=$PORT"
echo "  DATABASE_URL=$(echo "$DATABASE_URL" | sed 's/:[^:@]*@/:***@/')"
echo "  REDIS_URL=$REDIS_URL"
echo "  PIX_CREDENTIAL_KEY=$([ -n "$PIX_CREDENTIAL_KEY" ] && echo '已配置' || echo '未配置（后台将无法保存厂商密钥）')"

nohup node server/index.js >> "$LOG" 2>&1 &
echo "PID: $!"

for i in $(seq 1 30); do
  sleep 1
  if curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "健康检查通过（${i}s）"
    curl -s -m 3 "http://127.0.0.1:$PORT/health"
    echo
    exit 0
  fi
  if ! kill -0 $! 2>/dev/null; then
    echo "进程已退出，日志尾部："
    tail -30 "$LOG"
    exit 1
  fi
done

echo "30s 内健康检查未通过，日志尾部："
tail -30 "$LOG"
exit 1
