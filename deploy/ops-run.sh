#!/bin/bash
#
# 运维任务的统一包装。
#
# 为什么需要它：systemd 的 oneshot 服务默认只把输出丢进 journal，
# 而运维任务需要的是**能直接翻的独立日志**，且每条记录自带
# 执行时间 / 退出码 / 耗时 —— 出问题时第一眼要看的就是这三个。
#
# 用法：
#   ops-run.sh <任务名> <日志文件> <命令...>
#
# 行为：
#   - 开始与结束各写一行带时间戳的记录，结束行含退出码与耗时
#   - 子命令的全部输出同时写入日志文件
#   - 日志超过 50MB 自动截断（logrotate 之外的第二道保险）
#   - 退出码原样透传给 systemd，失败不会被吞掉
#
# 静默失败是运维最危险的形态：任务挂了但没人知道，
# 直到需要备份/分区那天才发现它们从来不存在。所以这里
# 宁可把日志写啰嗦，也不允许"跑了但看不出跑没跑成"。

set -u

NAME="${1:?用法: ops-run.sh <任务名> <日志文件> <命令...>}"
LOG="${2:?缺少日志文件参数}"
shift 2

[ "$#" -gt 0 ] || { echo "缺少要执行的命令" >&2; exit 2; }

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

# 日志体积保护。logrotate 配好了这步不会触发；配错了或没生效时，
# 它就是防止磁盘被写满的最后一道 —— 磁盘满会让整个服务以各种
# 奇怪的方式失败，比丢日志严重得多。
MAX_BYTES=$((50 * 1024 * 1024))
if [ -f "$LOG" ]; then
  SIZE=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt "$MAX_BYTES" ]; then
    mv "$LOG" "$LOG.oversize" 2>/dev/null || true
    echo "$(date -Is) 日志超过 50MB，已另存为 $(basename "$LOG").oversize（logrotate 可能未生效）" >> "$LOG"
  fi
fi

START_MS=$(date +%s%3N)

{
  echo "--- $(date -Is) 开始 $NAME ---"
  "$@"
} >> "$LOG" 2>&1
CODE=$?

END_MS=$(date +%s%3N)
DURATION=$((END_MS - START_MS))
echo "--- $(date -Is) 结束 $NAME 退出码=$CODE 耗时=${DURATION}ms ---" >> "$LOG"

# 同时往 stdout 写一行摘要 —— 它会进 systemd journal，
# 这样 journalctl 也能一眼看出每次执行的结果，不用去翻日志文件
echo "$NAME 退出码=$CODE 耗时=${DURATION}ms"

exit "$CODE"
