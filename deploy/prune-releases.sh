#!/usr/bin/env bash
#
# 清理旧版客户端安装包，只保留最近 N 个版本。
#
# 为什么需要：每版 4 个产物约 360MB（Windows 安装版 + 免安装版 +
# macOS 双架构 dmg）。官网只引用"每个平台最新一条"，旧版纯粹是回滚余地，
# 留一两版足够 —— 全留着会一直涨。
#
# 安全约束（任何一条不满足就拒绝执行）：
#   1. 当前 **启用中** 的版本永远不删，哪怕它不在最近 N 个里；
#   2. 默认只**干跑**，必须显式加 --apply 才真删；
#   3. 数据库记录与磁盘文件一起处理 —— 只删文件会留下 404 的死链接，
#      只删记录会留下永远不会被清理的孤儿文件。
#
# 用法：
#   ./prune-releases.sh              # 干跑，列出会删什么
#   ./prune-releases.sh --apply      # 真删
#   KEEP=2 ./prune-releases.sh --apply
#
set -euo pipefail

KEEP="${KEEP:-2}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

DOWNLOADS=/opt/hello-pix/downloads
ENV_FILE=/etc/hello-pix/hello-pix.env
PSQL="su - postgres -c"

# 全部版本号，按语义序倒排（0.1.10 要排在 0.1.9 前面，不能按字符串排）
mapfile -t VERSIONS < <(
  $PSQL "psql -d hello_pix -tAc \"SELECT version FROM client_releases GROUP BY version\"" 2>/dev/null \
  | sed '/^$/d' | sort -t. -k1,1nr -k2,2nr -k3,3nr
)

if [ "${#VERSIONS[@]}" -le "$KEEP" ]; then
  echo "只有 ${#VERSIONS[@]} 个版本，无需清理（保留数 $KEEP）"
  exit 0
fi

# 启用中的版本，永远不删
mapfile -t ACTIVE < <(
  $PSQL "psql -d hello_pix -tAc \"SELECT DISTINCT version FROM client_releases WHERE enabled\"" 2>/dev/null \
  | sed '/^$/d'
)

KEEPERS=("${VERSIONS[@]:0:$KEEP}")
is_keeper() {
  local v="$1"
  for k in "${KEEPERS[@]}"; do [ "$k" = "$v" ] && return 0; done
  for a in "${ACTIVE[@]:-}"; do [ "$a" = "$v" ] && return 0; done
  return 1
}

echo "保留版本: ${KEEPERS[*]}${ACTIVE[*]:+（启用中: ${ACTIVE[*]}，无论如何不删）}"
echo

DOOMED=()
for v in "${VERSIONS[@]}"; do
  is_keeper "$v" || DOOMED+=("$v")
done

if [ "${#DOOMED[@]}" -eq 0 ]; then
  echo "没有需要清理的版本"
  exit 0
fi

echo "将删除以下版本:"
TOTAL=0
for v in "${DOOMED[@]}"; do
  # 匹配该版本的全部产物：HelloPix-Setup-<v>.exe / HelloPix-<v>-*.dmg / -portable.exe
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
    TOTAL=$((TOTAL + sz))
    awk -v n="$(basename "$f")" -v b="$sz" 'BEGIN { printf "  %-44s %6.1f MB\n", n, b/1048576 }'
  done < <(find "$DOWNLOADS" -maxdepth 1 -type f -name "*${v}*" 2>/dev/null)
  echo "    └─ 数据库记录 $v"
done
awk -v b="$TOTAL" 'BEGIN { printf "  合计可释放 %.0f MB\n\n", b/1048576 }'

if [ "$APPLY" -ne 1 ]; then
  echo "（干跑模式，未做任何改动。加 --apply 才真正执行）"
  exit 0
fi

echo "执行清理..."
for v in "${DOOMED[@]}"; do
  find "$DOWNLOADS" -maxdepth 1 -type f -name "*${v}*" -delete 2>/dev/null || true
done

# 记录与文件一起删：只删文件会留下 404 的死链接
LIST=$(printf "'%s'," "${DOOMED[@]}"); LIST="${LIST%,}"
$PSQL "psql -d hello_pix -c \"DELETE FROM client_releases WHERE version IN ($LIST)\"" 2>/dev/null

echo
echo "清理后:"
ls -1 "$DOWNLOADS" | sed 's/^/  /'
echo
$PSQL "psql -d hello_pix -tAc \"SELECT version||' '||count(*)||' 条记录' FROM client_releases GROUP BY version ORDER BY version DESC\"" 2>/dev/null | sed 's/^/  /'
echo -n "  目录占用: "; du -sh "$DOWNLOADS" | cut -f1
