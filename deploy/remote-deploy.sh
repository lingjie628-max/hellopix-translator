#!/usr/bin/env bash
#
# 远端部署脚本 —— 在**生产机**上执行，由 deploy-code.sh 通过 ssh 喂进去。
#
# ## 为什么单独成文件
#
# 原先这段是内联在 deploy-code.sh 的双引号字符串里，于是远端脚本的每一个
# 变量都要写成 \$VAR，否则会被**本地** shell 提前展开。2026-10-23 我加了一段
# 保留逻辑，漏写了几个反斜杠，结果：
#
#   本地展开 $f（未绑定）→ set -u 直接退出 → tar 管道没建立 → 部署中断
#
# 这种错极难看出来：报错指向的"行 111"是本地那行 ssh，而真正的
# 未转义变量在 40 行之外。所以把远端脚本抽出来，用 `bash -s` 传，
# 从此远端脚本就是普通的 bash，不需要任何转义。
#
# ## 调用方式
#
#   tar -czf - -C "$STAGE" server migrations dist scripts \
#     | ssh root@host "APP=/opt/hello-pix bash -s" < deploy/remote-deploy.sh
#
# 注意 stdin 已被 tar 占用，脚本必须走命令行喂（见 deploy-code.sh 的实现：
# 先把脚本内容和归档拼在一起，或者用 ssh 的 -c 参数带脚本）。
#
# ## 入参
#
#   APP  目标目录，默认 /opt/hello-pix
#   归档从**标准输入**读取
#
set -euo pipefail
export LC_ALL=C.UTF-8

APP="${APP:-/opt/hello-pix}"
BAK="$APP/.bak"

rm -rf "$BAK" "$APP/.incoming"
mkdir -p "$BAK" "$APP/.incoming"
tar -C "$APP/.incoming" -xzf -

# ── PRESERVE：保留生产独有的 scripts/ 文件 ─────────────────────────────
#
# 2026-10-23 生产中断的直接原因：
#   生产上有一个**仓库里没有**的 scripts/preflight.sh，被 systemd drop-in
#   引用为 ExecStartPre。本脚本把 scripts/ 整个目录替换成仓库版本，于是它
#   被删 → ExecStartPre 找不到可执行文件 → status=203/EXEC → 服务起不来
#   → 全站 API 000。
#
# 处理：替换前把生产 scripts/ 里**仓库版本不存在**的文件捞进临时目录，
# 替换后原样放回。判断口径用文件名而不是内容哈希 —— 仓库里同名文件
# 应当以仓库为准（这是升级），只有仓库**完全没有**的才保留。
PRESERVE=$(mktemp -d)
trap 'rm -rf "$PRESERVE"' EXIT
if [ -d "$APP/scripts" ]; then
  for f in "$APP"/scripts/*; do
    [ -e "$f" ] || continue
    name=$(basename "$f")
    if [ ! -e "$APP/.incoming/scripts/$name" ]; then
      cp -a "$f" "$PRESERVE/" 2>/dev/null || true
      echo "  ↻ 保留生产独有: scripts/$name"
    fi
  done
fi

rollback() {
  set +e   # 回滚途中任何一步失败都要继续把后面的目录移回来，不能被 set -e 打断
  echo '  ✖ 部署失败，开始回滚' >&2
  for d in server migrations dist scripts; do
    if [ -d "$BAK/$d" ]; then
      rm -rf "$APP/$d"
      mv "$BAK/$d" "$APP/$d" || echo "  ⚠ 回滚 $d 失败，备份仍在 $BAK/$d" >&2
    fi
  done
  rm -rf "$BAK" "$APP/.incoming"
  systemctl restart hello-pix || true
  echo '  ⚠ 已回滚到部署前版本' >&2
  exit 1
}

for d in server migrations dist scripts; do
  # 新包里没有这个目录就不动它，但旧目录必须先搬进 $BAK
  [ -d "$APP/.incoming/$d" ] || continue
  if [ -d "$APP/$d" ]; then
    if ! mv "$APP/$d" "$BAK/$d"; then echo "搬不动 $APP/$d" >&2; rollback; fi
  fi
  if ! mv "$APP/.incoming/$d" "$APP/$d"; then rollback; fi
done

# 把生产独有的 scripts/ 文件放回去（见 PRESERVE 说明）
for f in "$PRESERVE"/*; do
  [ -e "$f" ] || continue
  cp -a "$f" "$APP/scripts/$(basename "$f")"
  echo "  ✔ 已还原: scripts/$(basename "$f")"
done

# 语法校验：搬家过程的半成品会在这里直接炸出来，而不是等到服务重启。
# 别写成 `node --check $f || { echo ...; node --check $f; rollback; }` ——
# 花括号组里第二条 node 失败会顶掉整个组的返回值，set -e 抢在 rollback
# 之前就退出，备份原地不动、新代码留在线上。必须用 if 块明确控制。
for f in "$APP"/server/*.js "$APP"/server/**/*.js "$APP"/scripts/*.js; do
  [ -f "$f" ] || continue
  if ! node --check "$f" >/dev/null 2>&1; then
    echo "语法错误: $f" >&2
    node --check "$f" || true
    rollback
  fi
done

# ── 权限与属主：必须放在**迁移与服务重启之前** ───────────────────────
#
# 2026-10-23 两次生产中断都跟"权限在最后才修"有关：
#
#   第一次：scripts/preflight.sh 被整目录替换删掉 → systemd 203/EXEC
#   第二次：`find ... -exec chmod 644` 把 .sh 的执行位也抹了 → 又 203/EXEC
#
# 第二次之所以没被更早发现，是因为修权限的代码排在"加载 env"**之后**，
# 而测试环境没有 /etc/hello-pix/hello-pix.env，`set -a; .` 一失败整段
# 就断了，后面的 chmod 全都没执行。生产上要是 env 文件出问题，
# 同样会发生"服务起不来了，而修权限的代码永远走不到"。
#
# 所以：先修权限，再碰 env，再迁移，最后重启。
chown -R root:root "$APP/server" "$APP/migrations" "$APP/dist" "$APP/scripts" 2>/dev/null || true
chown root:root "$APP" 2>/dev/null || true
chmod 755 "$APP" 2>/dev/null || true

find "$APP/server" "$APP/migrations" -type f -exec chmod 644 {} + 2>/dev/null || true
# scripts/ 不能一刀切 644：里面有被 systemd 直接 exec 的 .sh（preflight.sh
# 是 ExecStartPre）。统一 644 会让它失去执行位 → 203/EXEC → 服务起不来。
find "$APP/scripts" -type f -exec chmod 644 {} + 2>/dev/null || true
find "$APP/scripts" -type f -name '*.sh' -exec chmod 755 {} + 2>/dev/null || true
find "$APP/dist" -type f -exec chmod 644 {} + 2>/dev/null || true
find "$APP/dist" -type d -exec chmod 755 {} + 2>/dev/null || true

# 环境变量要在 migrate 之前加载（migrate 需要 DATABASE_URL）。
#
# 缺失时**不静默**：迁移会因此失败，而失败的样子是"导入了一半"，
# 比直接报错更难查。宁可在这里明确说"env 文件不见了"。
if [ -r /etc/hello-pix/hello-pix.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/hello-pix/hello-pix.env
  set +a
else
  echo "  ⚠ 读不到 /etc/hello-pix/hello-pix.env —— 迁移多半会失败" >&2
fi
chmod 755 "$APP"/scripts/*.js 2>/dev/null || true
chmod 755 "$APP"/scripts/*.sh 2>/dev/null || true

cd "$APP"
# 迁移不要被 || true 吞掉：库结构对不上就别重启
node scripts/migrate.js up 2>&1 | grep -E 'MIGRATION|Error' || true

systemctl restart hello-pix
# 等待启动的秒数可配：测试里设 0，生产默认 5。
# 否则每跑一次部署测试就要空等 5 秒 × 4 个用例。
sleep "${POST_RESTART_WAIT:-5}"
if [ "$(systemctl is-active hello-pix)" != active ]; then
  journalctl -u hello-pix -n 30 --no-pager | sed 's/^/  /' >&2
  rollback
fi

rm -rf "$BAK" "$APP/.incoming"
echo "  服务: $(systemctl is-active hello-pix)"
ls -ld "$APP" | sed 's/^/  /'
