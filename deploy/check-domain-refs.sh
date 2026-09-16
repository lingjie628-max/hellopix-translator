#!/usr/bin/env bash
# 检查生产库里是否残留占位/本地域名（客户端更新地址、远程线路等容易漏改）
set -euo pipefail
export LC_ALL=C.UTF-8

# 从 env 里解析连接信息，避免在命令行明文写密码
DB_URL=$(grep -E '^DATABASE_URL=' /etc/hello-pix/hello-pix.env | cut -d= -f2-)
PGUSER=$(printf '%s' "$DB_URL" | sed -E 's|.*://([^:]+):.*|\1|')
PGPASS=$(printf '%s' "$DB_URL" | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')
export PGPASSWORD="$PGPASS"
PSQL="psql -h 127.0.0.1 -U $PGUSER -d hello_pix -tA"

echo "=== 全库扫描：含 example.com / pending / 127.0.0.1 的文本列 ==="
found=0
while IFS='|' read -r tbl col; do
  [ -z "${tbl:-}" ] && continue
  cnt=$($PSQL -c "SELECT count(*) FROM \"$tbl\" WHERE \"$col\"::text LIKE '%example.com%' OR \"$col\"::text LIKE '%pending%' OR \"$col\"::text LIKE '%127.0.0.1%';" 2>/dev/null || echo 0)
  if [ "${cnt:-0}" != "0" ]; then
    echo "  $tbl.$col -> $cnt 行"
    found=$((found + 1))
  fi
done < <($PSQL -c "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND data_type IN ('character varying','text') ORDER BY table_name, column_name;")

[ "$found" -eq 0 ] && echo "  ✓ 无残留"

echo
echo "=== client_lines（客户端远程线路下发）==="
$PSQL -c "SELECT coalesce(string_agg(id||' | '||name||' | '||url||' | enabled='||enabled, E'\n'), '(空表)') FROM client_lines;" 2>/dev/null | sed 's/^/  /'

echo
echo "=== client_versions（客户端更新下载地址）==="
$PSQL -c "SELECT coalesce(string_agg(id||' | '||platform||' | '||version||' | '||coalesce(download_url,'(null)'), E'\n'), '(空表)') FROM client_versions;" 2>/dev/null | sed 's/^/  /'

echo
echo "=== site settings 内是否含域名 ==="
$PSQL -c "SELECT coalesce(string_agg(key||' = '||left(value::text, 120), E'\n'), '(空)') FROM site_settings WHERE value::text ~* 'http|domain|url';" 2>/dev/null | sed 's/^/  /'
