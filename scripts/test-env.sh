#!/usr/bin/env bash
#
# 起一套**可丢弃的**本地测试依赖：PostgreSQL + Redis。
#
# 为什么需要这个：`test/` 下 10 个文件、14 处测试靠 `PIX_TEST_DATABASE_URL`
# 判断"要不要跳过"。本地没配库时它们**静默 skip**，于是 `npm run test:security`
# 永远显示"全绿" —— 碰钱的测试一个都没跑过。这不是测试通过，这是测试不存在。
#
# 用法：
#   ./scripts/test-env.sh up      启库 + 迁移 + 打印 export 语句
#   eval "$(./scripts/test-env.sh up)"        # 直接进当前 shell
#   ./scripts/test-env.sh down    停库 + 删数据目录（数据全丢，这是故意的）
#   ./scripts/test-env.sh status  看状态
#
# 数据目录在 /tmp 下，机器重启自动清空。**永远不要指向生产库。**

set -euo pipefail

# 默认端口刻意避开常见范围：
#   55432 / 56379 在本机被 Docker 转发占用过（lsof 里是 com.docke），
#   脚本如果只看"端口有人听"就会误判成"可以复用"，实际 psql 一连就炸。
PG_PORT="${PIX_TEST_PG_PORT:-55433}"
REDIS_PORT="${PIX_TEST_REDIS_PORT:-56380}"
DATA_DIR="${PIX_TEST_DATA_DIR:-/tmp/hellopix-test-env}"
PGDATA="$DATA_DIR/pg"
REDIS_DIR="$DATA_DIR/redis"
DB_NAME="${PIX_TEST_DB_NAME:-hellopix_test}"
DB_USER="${PIX_TEST_DB_USER:-postgres}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# macOS 上 PostgreSQL 的 CLI 不在默认 PATH 里，得自己找。
find_pg_bin() {
  if command -v initdb >/dev/null 2>&1; then
    dirname "$(command -v initdb)"
    return
  fi
  local candidate
  for candidate in \
    /opt/homebrew/opt/postgresql@17/bin \
    /opt/homebrew/opt/postgresql@16/bin \
    /opt/homebrew/opt/postgresql/bin \
    /usr/local/opt/postgresql@17/bin \
    /usr/lib/postgresql/17/bin \
    /usr/lib/postgresql/16/bin; do
    if [ -x "$candidate/initdb" ]; then
      echo "$candidate"
      return
    fi
  done
  echo ""
}

PG_BIN="$(find_pg_bin)"

# macOS 的 locale 检测在 initdb / postgres 启动时会对非 C locale 炸掉
# （"postmaster became multithreaded during startup"）。统一钉成 C。
export LC_ALL=C LANG=C

port_open() {
  # 探测 127.0.0.1:$1 上是否真有人接 TCP。
  #
  # 不要用 `exec 3<>/dev/tcp/...` —— zsh 不支持，bash 在某些环境下
  # 对"连接被拒绝"的处理也不一致，会出现"报告有人在听、实际连不上"
  # 的假阳性。node 一定在（整个项目就是 node），用它的 net 模块最可靠。
  node -e '
    const net = require("net")
    const socket = net.connect({ host: "127.0.0.1", port: Number(process.argv[1]) })
    socket.setTimeout(400)
    socket.on("connect", () => { socket.destroy(); process.exit(0) })
    socket.on("timeout", () => { socket.destroy(); process.exit(1) })
    socket.on("error", () => process.exit(1))
  ' "$1" >/dev/null 2>&1
}

require_pg() {
  if [ -z "$PG_BIN" ]; then
    echo "✗ 找不到 PostgreSQL 可执行文件（initdb / pg_ctl / psql）。" >&2
    echo "  macOS: brew install postgresql@17" >&2
    echo "  或指定 PIX_TEST_PG_BIN=/path/to/bin" >&2
    exit 1
  fi
}

require_redis() {
  if ! command -v redis-server >/dev/null 2>&1; then
    echo "✗ 找不到 redis-server。macOS: brew install redis" >&2
    exit 1
  fi
}

start_pg() {
  require_pg
  # "端口有人听"不等于"这是我的 PG"。`lsof` 里 `com.docke` 占着 127.0.0.1:55432
  # 这种情况真实存在过：脚本以为可以复用，psql 一连就报 socket 不存在。
  # 所以必须**握手成功**才复用，否则换端口。
  if "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U "$DB_USER" -d postgres \
       -tAc 'SELECT 1' >/dev/null 2>&1; then
    echo "· PostgreSQL 已在 $PG_PORT 上可用，直接复用" >&2
    return
  fi
  if port_open "$PG_PORT"; then
    echo "✗ 端口 $PG_PORT 被别的进程占着，且不是可用的 PostgreSQL。" >&2
    echo "  用 PIX_TEST_PG_PORT=xxxxx 换个端口重试。" >&2
    exit 1
  fi
  if [ ! -d "$PGDATA" ]; then
    echo "· 初始化 PostgreSQL 数据目录 $PGDATA" >&2
    mkdir -p "$DATA_DIR"
    "$PG_BIN/initdb" -D "$PGDATA" -U "$DB_USER" --auth=trust -E UTF8 --locale=C >/dev/null
  fi
  echo "· 启动 PostgreSQL :$PG_PORT" >&2
  "$PG_BIN/pg_ctl" -D "$PGDATA" \
    -o "-p $PG_PORT -k /tmp -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off" \
    -l "$DATA_DIR/pg.log" start >/dev/null

  local waited=0
  until "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U "$DB_USER" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; do
    sleep 0.3
    waited=$((waited + 1))
    if [ "$waited" -gt 100 ]; then
      echo "✗ PostgreSQL 30 秒内没起来，看 $DATA_DIR/pg.log" >&2
      tail -20 "$DATA_DIR/pg.log" >&2 || true
      exit 1
    fi
  done
}

start_redis() {
  require_redis
  # 同理，必须 PING 通才算复用。
  if command -v redis-cli >/dev/null 2>&1 \
     && [ "$(redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping 2>/dev/null)" = "PONG" ]; then
    echo "· Redis 已在 $REDIS_PORT 上可用，直接复用" >&2
    return
  fi
  if port_open "$REDIS_PORT"; then
    echo "✗ 端口 $REDIS_PORT 被别的进程占着，且不是可用的 Redis。" >&2
    echo "  用 PIX_TEST_REDIS_PORT=xxxxx 换个端口重试。" >&2
    exit 1
  fi
  mkdir -p "$REDIS_DIR"
  echo "· 启动 Redis :$REDIS_PORT" >&2
  redis-server \
    --port "$REDIS_PORT" \
    --bind 127.0.0.1 \
    --dir "$REDIS_DIR" \
    --save '' \
    --appendonly no \
    --daemonize yes \
    --logfile "$DATA_DIR/redis.log"
  local waited=0
  until [ "$(redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping 2>/dev/null)" = "PONG" ]; do
    sleep 0.2
    waited=$((waited + 1))
    if [ "$waited" -gt 50 ]; then
      echo "✗ Redis 10 秒内没起来，看 $DATA_DIR/redis.log" >&2
      exit 1
    fi
  done
}

ensure_database() {
  local exists
  # 用 TCP 连，不用 unix socket —— socket 路径在不同发行版 / 容器里不固定，
  # 而 127.0.0.1 + 端口的语义是确定的。
  exists="$("$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U "$DB_USER" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" || true)"
  if [ "$exists" != "1" ]; then
    echo "· 建库 $DB_NAME" >&2
    "$PG_BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" -U "$DB_USER" "$DB_NAME"
  fi
}

migrate() {
  # 迁移需要 PIX_CREDENTIAL_KEY（TOTP 密钥加密）。测试环境用固定假密钥：
  # 每次都变会导致已加密的行再也解不开，反而让重跑失败。
  local db_url="postgres://$DB_USER@127.0.0.1:$PG_PORT/$DB_NAME"
  echo "· 跑迁移" >&2
  (
    cd "$PROJECT_ROOT"
    DATABASE_URL="$db_url" \
    PIX_CREDENTIAL_KEY="${PIX_CREDENTIAL_KEY:-0000000000000000000000000000000000000000000000000000000000000000}" \
    JWT_SECRET="${JWT_SECRET:-test-only-secret-do-not-use-in-production}" \
      node scripts/migrate.js up >/dev/null
  )
}

print_env() {
  echo "export PIX_TEST_DATABASE_URL=\"postgres://$DB_USER@127.0.0.1:$PG_PORT/$DB_NAME\""
  echo "export PIX_TEST_REDIS_URL=\"redis://127.0.0.1:$REDIS_PORT/0\""
  echo "export DATABASE_URL=\"postgres://$DB_USER@127.0.0.1:$PG_PORT/$DB_NAME\""
  echo "export REDIS_URL=\"redis://127.0.0.1:$REDIS_PORT/0\""
  echo "export PIX_CREDENTIAL_KEY=\"${PIX_CREDENTIAL_KEY:-0000000000000000000000000000000000000000000000000000000000000000}\""
  echo "export JWT_SECRET=\"${JWT_SECRET:-test-only-secret-do-not-use-in-production}\""
}

cmd_up() {
  start_pg
  start_redis
  ensure_database
  migrate
  print_env
}

cmd_down() {
  if [ -n "$PG_BIN" ] && [ -d "$PGDATA" ]; then
    "$PG_BIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
  fi
  if command -v redis-cli >/dev/null 2>&1; then
    redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  fi
  rm -rf "$DATA_DIR"
  echo "· 已停库并删除 $DATA_DIR" >&2
}

cmd_status() {
  if port_open "$PG_PORT"; then echo "PostgreSQL :$PG_PORT  UP"; else echo "PostgreSQL :$PG_PORT  DOWN"; fi
  if port_open "$REDIS_PORT"; then echo "Redis      :$REDIS_PORT  UP"; else echo "Redis      :$REDIS_PORT  DOWN"; fi
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *)
    echo "用法: $0 {up|down|status}" >&2
    echo "" >&2
    echo "  eval \"\$(./scripts/test-env.sh up)\"   # 起环境并导出变量" >&2
    echo "  ./scripts/test-env.sh down          # 全清" >&2
    exit 1
    ;;
esac
