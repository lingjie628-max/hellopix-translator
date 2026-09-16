#!/usr/bin/env bash
#
# 数据库备份。
#
# 为什么必须有：充值记录就是钱。磁盘故障、误操作、迁移写错，
# 任何一种都能让数据永久消失，而没有备份就没有恢复手段。
#
# 为什么不能只 dump 完就完事：
# **没验证过的备份不算备份。** 一个被截断的 dump、一个权限不对的 dump、
# 一个 dump 到一半磁盘满的文件，平时看不出来，等真要用的时候才发现打不开。
# 所以这里做两级验证：
#   · 每次：pg_restore --list 确认归档可读（快，能抓截断）
#   · 每周：真的恢复到临时库并比对表行数（慢，能抓逻辑损坏）
#
# 用法：
#   ./backup-db.sh              # 正常备份
#   ./backup-db.sh --verify     # 额外做一次完整恢复演练
#
set -euo pipefail

DEST=/var/backups/hello-pix
KEEP_DAYS=30
DB=hello_pix
STAMP=$(date +%Y%m%d-%H%M%S)
FILE="$DEST/${DB}-${STAMP}.dump"
LOG="$DEST/backup.log"

export LC_ALL=C.UTF-8
mkdir -p "$DEST"
chmod 700 "$DEST"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

fail() {
  log "✗ 失败: $*"
  # 备份失败必须让人知道 —— 静默失败的备份是最危险的东西：
  # 你以为有，实际没有，直到需要它的那一天
  exit 1
}

# ---------------------------------------------------------------------------
# 1. 导出
# ---------------------------------------------------------------------------
log "开始备份 $DB"

# 用 custom 格式（-Fc）：自带压缩、支持并行恢复、支持选择性恢复单表。
#
# 走管道而不是让 pg_dump 自己写文件：备份目录是 root 700，
# postgres 用户写不进去；而放宽目录权限会把**整库数据（含密码哈希）**
# 暴露给 postgres 可写的任何进程。让 pg_dump 输出到 stdout、
# 由 root 重定向落盘，文件与目录都能保持 root 独有。
if ! su - postgres -c "pg_dump -Fc -d $DB" > "$FILE" 2>>"$LOG"; then
  rm -f "$FILE"
  fail "pg_dump 执行失败"
fi
chmod 600 "$FILE"

SIZE=$(stat -c%s "$FILE")
log "导出完成: $(basename "$FILE") ($((SIZE / 1024 / 1024)) MB)"

# 空文件或极小文件基本说明导出没成功（正常至少几 MB）
if [ "$SIZE" -lt 10240 ]; then
  rm -f "$FILE"
  fail "备份文件过小（$SIZE 字节），疑似导出异常"
fi

# ---------------------------------------------------------------------------
# 2. 每次验证：归档完整性
# ---------------------------------------------------------------------------
# 同样走管道：文件是 root 600，postgres 读不到
if ! su - postgres -c "pg_restore --list" < "$FILE" >/dev/null 2>>"$LOG"; then
  fail "归档不可读（可能被截断），已保留现场: $FILE"
fi
log "归档完整性检查通过"

# ---------------------------------------------------------------------------
# 3. 每周演练：真的恢复一次
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--verify" ] || [ "$(date +%u)" = "7" ]; then
  TMPDB="${DB}_restore_check"
  log "开始恢复演练 → $TMPDB"

  su - postgres -c "dropdb --if-exists $TMPDB" 2>>"$LOG" || true
  su - postgres -c "createdb $TMPDB" 2>>"$LOG" || fail "临时库创建失败"

  # --no-owner 避免因角色差异失败；这本来就是"能不能读出数据"的验证
  if ! su - postgres -c "pg_restore --no-owner -d $TMPDB" < "$FILE" 2>>"$LOG"; then
    su - postgres -c "dropdb --if-exists $TMPDB" 2>/dev/null || true
    fail "恢复演练失败 —— 备份文件实际不可用！"
  fi

  # 比对核心表的行数：恢复出来是空的也算失败
  MISMATCH=""
  for t in users orders recharges messages customers; do
    SRC=$(su - postgres -c "psql -d $DB -tAc 'SELECT count(*) FROM $t'" 2>/dev/null | tr -d '[:space:]')
    DST=$(su - postgres -c "psql -d $TMPDB -tAc 'SELECT count(*) FROM $t'" 2>/dev/null | tr -d '[:space:]')
    if [ "$SRC" != "$DST" ]; then
      MISMATCH="$MISMATCH $t($SRC→$DST)"
    fi
  done

  su - postgres -c "dropdb --if-exists $TMPDB" 2>>"$LOG" || true

  if [ -n "$MISMATCH" ]; then
    fail "恢复后行数不一致:$MISMATCH"
  fi
  log "恢复演练通过（5 张核心表行数一致）"
fi

# ---------------------------------------------------------------------------
# 4. 清理过期备份
# ---------------------------------------------------------------------------
# 保留 30 天。删除前先确认剩下的备份里**至少有一个通过了完整性检查** ——
# 否则"清理"可能把最后的可用备份也删掉。
REMAIN=$(find "$DEST" -name "${DB}-*.dump" -type f | wc -l)
if [ "$REMAIN" -gt "$KEEP_DAYS" ]; then
  find "$DEST" -name "${DB}-*.dump" -type f -mtime +"$KEEP_DAYS" -delete
  log "已清理 $KEEP_DAYS 天前的备份"
fi

TOTAL=$(find "$DEST" -name "${DB}-*.dump" -type f | wc -l)
DISK=$(df -h "$DEST" | tail -1 | awk '{print $5}')
log "备份成功。当前保留 $TOTAL 份，分区占用 $DISK"
