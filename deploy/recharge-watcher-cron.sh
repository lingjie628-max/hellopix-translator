#!/bin/bash
#
# ChainWatcher 的 cron 包装。
#
# 为什么不让 cron 直接调 node：
#
#   1. **单实例锁**。扫描间隔 60 秒，而一轮可能因为上游慢而拖到 60 秒以上。
#      没有锁的话第二轮会和第一轮并发跑，两者争抢同一个游标 ——
#      最坏情况是其中一个把游标推到自己还没处理完的位置，那就是丢单。
#      用 flock -n：拿不到锁**直接跳过本轮**，不排队、不等待。
#      跳过是安全的 —— 下一轮会从 checkpoint 继续，而 checkpoint 只进不退。
#
#   2. **单轮超时**。上游卡住时不能让进程一直挂着。
#      50 秒后 TERM，10 秒后 KILL。超时被杀**不会丢单**：
#      游标推进与交易落库在同一个事务里，事务没提交就是没推进，
#      下一轮从原处重扫，重复由 TXID 唯一约束消解。
#
#   3. **环境变量与日志**。cron 的环境极简，必须显式 source。
#
# 用法（cron 调用，不需要手动跑）：
#   * * * * * root /opt/hello-pix/deploy/recharge-watcher-cron.sh
#
set -u

APP=/opt/hello-pix
LOG_DIR=/var/log/hello-pix
LOG="$LOG_DIR/recharge-watcher.log"
LOCK=/var/lock/hello-pix-recharge-watcher.lock
TIMEOUT_SECONDS=50

mkdir -p "$LOG_DIR"

# 日志自愈：logrotate 之外再加一道保险。
# 万一 logrotate 没配好，也不至于把磁盘写满 —— 磁盘满会让整个服务以
# 各种奇怪的方式失败，比日志丢失严重得多。
if [ -f "$LOG" ]; then
  SIZE=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt $((50 * 1024 * 1024)) ]; then
    mv "$LOG" "$LOG.oversize" 2>/dev/null || true
    echo "$(date -Is) 日志超过 50MB，已截断（logrotate 可能未生效，请检查）" >> "$LOG"
  fi
fi

# 单实例锁：FD 9 上的 flock 会一直持有到脚本退出
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -Is) 上一轮仍在运行，跳过本轮（不影响正确性：下一轮从 checkpoint 继续）" >> "$LOG"
  exit 0
fi

cd "$APP" || { echo "$(date -Is) 目录不存在: $APP" >> "$LOG"; exit 1; }
set -a
# shellcheck disable=SC1091
. /etc/hello-pix/hello-pix.env
set +a

echo "--- $(date -Is) 开始扫描 ---" >> "$LOG"
timeout --signal=TERM --kill-after=10 "$TIMEOUT_SECONDS" \
  /usr/bin/node scripts/recharge-watcher.js >> "$LOG" 2>&1
CODE=$?

if [ "$CODE" -eq 124 ] || [ "$CODE" -eq 137 ]; then
  echo "$(date -Is) 单轮超时（${TIMEOUT_SECONDS}s）被终止 —— 事务未提交，游标未推进，下一轮重扫" >> "$LOG"
elif [ "$CODE" -ne 0 ]; then
  echo "$(date -Is) 本轮有失败，退出码 $CODE（游标未推进，下轮重试）" >> "$LOG"
fi

exit "$CODE"
