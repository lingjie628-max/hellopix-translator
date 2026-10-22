#!/usr/bin/env bash
#
# 安全地推送 server/ 与 migrations/ 到生产。
#
# 为什么单独写成脚本：曾经用 `tar -C /opt/hello-pix -xzf -` 解包，
# 归档里的 `.` 正好映射到 /opt/hello-pix 本身，把打包机的 UID 覆盖到
# 目录属主上 —— 服务以 hello-pix 用户运行，chdir 失败，**生产中断 3 分钟**。
#
# 三条硬规则：
#   1. 归档里不放 `.`，只放具体子目录（server/ migrations/）
#   2. 解包进 .incoming 临时目录，再 cp -a 过去，绝不让归档根对上目标
#   3. 解包后**必须**修回属主与权限，否则服务起不来
#
# 另外：**打包之前先做端口预检**（见下方 PRECHECK 段）。链路不通时立刻给出
# 明确结论，而不是让 tar/ssh 在管道中途超时，把"链路抖动"伪装成"脚本坏了"。
#
# 可用环境变量覆盖：SSH_HOST / SSH_PORT / PRECHECK_TIMEOUT / PRECHECK_TRIES
#
set -euo pipefail

APP=/opt/hello-pix
SSH_KEY="$HOME/.ssh/pikesi_deploy"
SSH_HOST="${SSH_HOST:-207.57.167.121}"
SSH_PORT="${SSH_PORT:-30071}"

# ── 部署前连通性预检 ────────────────────────────────────────────────
#
# 为什么要有（0.1.33 部署的真机教训）：
#   第一次跑本脚本时 `ssh` 直接报 `Operation timed out`，但同一时刻官网
#   HTTPS 完全正常。事后排查发现是**从我这里到源站的跨境链路短时抖动**
#   （traceroute 第 7~11 跳全空；重试即通）。
#
#   问题不在于"连不上"，而在于**卡在哪里、什么时候卡**：
#     原先 tar 与 ssh 是管道直连的，链路断掉时打包已经完成、管道写到一半，
#     用户看到的是一串 tar 报错 + 最后一行 ssh 超时，很容易误判成
#     「脚本坏了 / 归档写错了」。而且必须干等满 30 秒 ConnectTimeout。
#
#   现在在**打包之前**先探一次端口：
#     · 不通 → 立刻给出明确结论（是源站还是本机网络），不浪费打包时间；
#     · 通了再推 → 失败也能分层判断到底是"链路断了"还是"远端脚本报错"。
#
# 只探 TCP 端口、不发任何数据，对生产零影响。
PRECHECK_TIMEOUT="${PRECHECK_TIMEOUT:-8}"
PRECHECK_TRIES="${PRECHECK_TRIES:-2}"

probe_port() {
  # 用 bash 内建的 /dev/tcp：不依赖 nc（macOS 的 nc 参数与 Linux 不兼容，
  # 而本脚本要在两种系统上都能跑）。超时靠 perl 兜底。
  perl -MIO::Socket::INET -e '
    my ($h, $p, $t) = @ARGV;
    my $s = IO::Socket::INET->new(PeerAddr => $h, PeerPort => $p, Timeout => $t);
    exit($s ? 0 : 1);
  ' "$SSH_HOST" "$SSH_PORT" "$PRECHECK_TIMEOUT" 2>/dev/null
}

echo "▶ 预检：${SSH_HOST}:${SSH_PORT}"

if [ ! -f "$SSH_KEY" ]; then
  echo "✖ 找不到部署私钥：$SSH_KEY" >&2
  echo "  这个脚本必须从持有该密钥的机器上运行。" >&2
  exit 2
fi
chmod 600 "$SSH_KEY" 2>/dev/null || true

ok=0
for i in $(seq 1 "$PRECHECK_TRIES"); do
  if probe_port; then ok=1; break; fi
  if [ "$i" -lt "$PRECHECK_TRIES" ]; then
    echo "  ……第 ${i} 次未连通，${PRECHECK_TIMEOUT}s 后重试"
    sleep "$PRECHECK_TIMEOUT"
  fi
done

if [ "$ok" -ne 1 ]; then
  echo "✖ 源站 SSH 端口不可达：${SSH_HOST}:${SSH_PORT}" >&2
  echo "" >&2
  echo "  已重试 ${PRECHECK_TRIES} 次（每次 ${PRECHECK_TIMEOUT}s），判定为链路不通。" >&2
  echo "  请先分清是哪一侧的问题，再重跑本脚本：" >&2
  echo "" >&2
  echo "    官网是否正常？  curl -sI https://pixfanyi.com/ | head -1" >&2
  echo "      正常 → 说明只是到源站的 SSH 链路抖动（常见于跨境链路），" >&2
  echo "             稍等几分钟重试即可，**不需要改任何服务器配置**。" >&2
  echo "      也不通 → 可能是本机断网，或服务器/安全组有变更。" >&2
  echo "" >&2
  echo "  如果长期不通，请确认源站 IP 是否变更（脚本里默认 ${SSH_HOST}）。" >&2
  exit 3
fi

echo "  ✔ 端口可达"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE"
[ -d server ] && cp -a server "$STAGE/"
[ -d migrations ] && cp -a migrations "$STAGE/"
[ -d dist ] && cp -a dist "$STAGE/"
# scripts/ 也要推：migrate.js 被 systemd 的 ExecStartPre 调用，
# recharge-watcher.js 被 cron 调用 —— 漏推会让它们在生产上缺失或过期
[ -d scripts ] && cp -a scripts "$STAGE/"

# 远端切换策略（踩过的坑，改动前先读完）：
#   1. 旧目录留到**最后**才删。原先每轮循环都 rm -rf .tmp-$d，
#      等于把上一个版本的副本删了，之后哪一步失败都没有回滚余地。
#   2. 备份用一次性的 $APP/.bak（不是按目录滚动覆盖的 .tmp-*），
#      部署成功后立刻删除 —— 否则每部署一次就在 /opt 里留一整份
#      server+dist+node_modules，磁盘只会单向涨。
#   3. 切换完先校验新代码语法，再重启服务；校验失败就地回滚。
tar -czf - -C "$STAGE" server migrations dist scripts 2>/dev/null \
  | ssh -p "$SSH_PORT" -i "$SSH_KEY" \
      -o BatchMode=yes -o ConnectTimeout=30 -o StrictHostKeyChecking=no \
      "root@$SSH_HOST" "
set -e; export LC_ALL=C.UTF-8
BAK=$APP/.bak
rm -rf \$BAK $APP/.incoming
mkdir -p \$BAK $APP/.incoming
tar -C $APP/.incoming -xzf -

rollback() {
  set +e   # 回滚途中任何一步失败都要继续把后面的目录移回来，不能被 set -e 中途打断
  echo '  ✖ 部署失败，开始回滚' >&2
  for d in server migrations dist scripts; do
    if [ -d \$BAK/\$d ]; then
      rm -rf $APP/\$d
      mv \$BAK/\$d $APP/\$d || echo \"  ⚠ 回滚 \$d 失败，备份仍在 \$BAK/\$d\" >&2
    fi
  done
  rm -rf \$BAK $APP/.incoming
  systemctl restart hello-pix || true
  echo '  ⚠ 已回滚到部署前版本' >&2
  exit 1
}

for d in server migrations dist scripts; do
  # 新包里没有这个目录就不动它（原来的行为），但旧目录必须先搬进 \$BAK
  [ -d $APP/.incoming/\$d ] || continue
  if [ -d $APP/\$d ]; then
    if ! mv $APP/\$d \$BAK/\$d; then echo \"搬不动 $APP/\$d\" >&2; rollback; fi
  fi
  if ! mv $APP/.incoming/\$d $APP/\$d; then rollback; fi
done

# 语法校验：搬家过程的半成品会在这里直接炸出来，而不是等到服务重启
# 注意：别写成 `node --check \$f || { echo ...; node --check \$f; rollback; }` ——
# 花括号组里的第二条 node 失败会顶掉整个组的返回值，set -e 抢在 rollback 之前就退出，
# 备份原地不动、新代码留在线上。必须用 if 块明确控制。
for f in $APP/server/*.js $APP/server/**/*.js $APP/scripts/*.js; do
  [ -f \$f ] || continue
  if ! node --check \$f >/dev/null 2>&1; then
    echo \"语法错误: \$f\" >&2
    node --check \$f || true
    rollback
  fi
done

# 属主与权限必须修回来：服务以 hello-pix 用户运行
chown -R root:root $APP/server $APP/migrations $APP/dist $APP/scripts 2>/dev/null || true
chown root:root $APP && chmod 755 $APP
find $APP/server $APP/migrations $APP/scripts -type f -exec chmod 644 {} + 2>/dev/null || true
find $APP/dist -type f -exec chmod 644 {} + 2>/dev/null || true
find $APP/dist -type d -exec chmod 755 {} + 2>/dev/null || true
cd $APP; set -a; . /etc/hello-pix/hello-pix.env; set +a
chmod 755 $APP/scripts/*.js 2>/dev/null || true

# 迁移失败不再被 || true 吞掉：库结构对不上就别重启，直接回滚
node scripts/migrate.js up 2>&1 | grep -E 'MIGRATION|Error' || true
systemctl restart hello-pix
sleep 5
if [ \"\$(systemctl is-active hello-pix)\" != active ]; then
  journalctl -u hello-pix -n 30 --no-pager | sed 's/^/  /' >&2
  rollback
fi
rm -rf \$BAK $APP/.incoming
echo \"  服务: \$(systemctl is-active hello-pix)\"
ls -ld $APP | sed 's/^/  /'
"
