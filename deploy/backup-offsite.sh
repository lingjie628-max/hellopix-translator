#!/bin/bash
# 数据库备份异地同步。2026-11-12 建立。
# 背景：11 月旧机整机房断网 + 重新编址，26 小时失联。当时备份只在出事的那台机器上，
# 等于没有备份。数据库备份必须至少有一份在另一台物理机上。
set -u
SRC=/var/backups/hello-pix/
DST_HOST=45.201.215.25
DST_PORT=30071
DST_PATH=/root/offsite-hello-pix-backups/
KEY=/root/.ssh/migrate_key
LOG=/var/log/hello-pix/backup-offsite.log
mkdir -p $(dirname $LOG)
echo "[$(date '+%F %T')] 开始异地同步" >> $LOG

# 先确保远端目录存在
ssh -p $DST_PORT -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i $KEY root@$DST_HOST "mkdir -p $DST_PATH" >> $LOG 2>&1 || {
  echo "[$(date '+%F %T')] 远程目录创建失败，中止" >> $LOG; exit 1; }

# 推最近的 dump，并清理远端超过 14 天的旧档
for f in $SRC*.dump; do
  [ -f "$f" ] || continue
  rsync -av --timeout=600 -e "ssh -p $DST_PORT -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -i $KEY" "$f" root@$DST_HOST:$DST_PATH >> $LOG 2>&1
  rc=$?
  if [ $rc -eq 0 ]; then echo "[$(date '+%F %T')] 已推送 $(basename $f) rc=$rc" >> $LOG
  else echo "[$(date '+%F %T')] 推送失败 $(basename $f) rc=$rc" >> $LOG; fi
done

ssh -p $DST_PORT -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i $KEY root@$DST_HOST   "find $DST_PATH -name '*.dump' -mtime +14 -delete" >> $LOG 2>&1
echo "[$(date '+%F %T')] 异地同步结束，远端现有 $(ssh -p $DST_PORT -o StrictHostKeyChecking=no -i $KEY root@$DST_HOST "ls -1 $DST_PATH 2>/dev/null | wc -l") 份" >> $LOG
