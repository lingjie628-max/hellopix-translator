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
#   4. 版本号匹配必须用**精确模式**（见 release_files），禁止 "*${v}*" 这类子串：
#      0.1.2 是 0.1.25 的前缀，子串匹配会把**正在分发**的 0.1.25 安装包一起删掉。
#      另有 assert_no_keeper_matches_doomed 兜底，命中保留版本即中止。
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

# 列出某版本的安装包文件。额外参数原样传给 find（如 -delete）。
#
# ★ 必须用精确模式，禁止 "*${v}*" ★
#   子串匹配会误伤"版本号是它前缀"的活跃版本：v=0.1.2 时 "*0.1.2*" 会匹到
#   0.1.25 的四个产物，一执行 --apply 就把**正在分发**的安装包删掉，官网
#   下载立刻 404，而数据库里 0.1.25 仍是 enabled。
#   注意这个坑只在特定组合下出现 —— 0.1.2 是 0.1.25 的**前缀**（会中招），
#   而 0.1.5 不是 0.1.15 的前缀（不中招），所以肉眼很难发现。
release_files() {
  local v="$1"; shift
  find "$DOWNLOADS" -maxdepth 1 -type f \
    \( -name "HelloPix-Setup-${v}.exe" \
       -o -name "HelloPix-${v}-*.dmg" \
       -o -name "HelloPix-${v}-*.exe" \) "$@" 2>/dev/null
}

# 兜底断言：删除清单里不得出现任何**保留**版本（最近 N 个或启用中）的产物。
# 万一将来有人把 release_files 改回宽松匹配，这里会先拦住，绝不会误删线上包。
assert_no_keeper_matches_doomed() {
  local v f base k bad=0
  for v in "${DOOMED[@]}"; do
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      base="$(basename "$f")"
      for k in "${KEEPERS[@]}" "${ACTIVE[@]:-}"; do
        [ -n "$k" ] || continue
        if [[ "$base" == *"$k"* ]]; then
          echo "  ✗ 删除清单里出现保留版本 $k 的文件：$base" >&2
          bad=1
        fi
      done
    done < <(release_files "$v")
  done
  if [ "$bad" -ne 0 ]; then
    echo "删除清单命中保留版本，已中止（未做任何改动）。" >&2
    exit 3
  fi
}

assert_no_keeper_matches_doomed

echo "将删除以下版本:"
TOTAL=0
for v in "${DOOMED[@]}"; do
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
    TOTAL=$((TOTAL + sz))
    awk -v n="$(basename "$f")" -v b="$sz" 'BEGIN { printf "  %-44s %6.1f MB\n", n, b/1048576 }'
  done < <(release_files "$v")
  echo "    └─ 数据库记录 $v"
done
awk -v b="$TOTAL" 'BEGIN { printf "  合计可释放 %.0f MB\n\n", b/1048576 }'

if [ "$APPLY" -ne 1 ]; then
  echo "（干跑模式，未做任何改动。加 --apply 才真正执行）"
  exit 0
fi

echo "执行清理..."
for v in "${DOOMED[@]}"; do
  release_files "$v" -delete
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
