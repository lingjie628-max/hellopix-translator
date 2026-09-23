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
set -euo pipefail

APP=/opt/hello-pix
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE"
[ -d server ] && cp -a server "$STAGE/"
[ -d migrations ] && cp -a migrations "$STAGE/"
[ -d dist ] && cp -a dist "$STAGE/"
# scripts/ 也要推：migrate.js 被 systemd 的 ExecStartPre 调用，
# recharge-watcher.js 被 cron 调用 —— 漏推会让它们在生产上缺失或过期
[ -d scripts ] && cp -a scripts "$STAGE/"

tar -czf - -C "$STAGE" server migrations dist scripts 2>/dev/null \
  | ssh -p "${SSH_PORT:-30071}" -i "$HOME/.ssh/pikesi_deploy" \
      -o BatchMode=yes -o ConnectTimeout=30 -o StrictHostKeyChecking=no \
      "root@${SSH_HOST:-128.241.245.172}" "
set -e; export LC_ALL=C.UTF-8
rm -rf $APP/.incoming && mkdir -p $APP/.incoming
tar -C $APP/.incoming -xzf -
for d in server migrations dist scripts; do
  [ -d $APP/.incoming/\$d ] || continue
  rm -rf $APP/.tmp-\$d && mv $APP/\$d $APP/.tmp-\$d 2>/dev/null || true
  mv $APP/.incoming/\$d $APP/\$d
done
rm -rf $APP/.incoming
# 属主与权限必须修回来：服务以 hello-pix 用户运行
chown -R root:root $APP/server $APP/migrations $APP/dist $APP/scripts 2>/dev/null || true
chown root:root $APP && chmod 755 $APP
find $APP/server $APP/migrations $APP/scripts -type f -exec chmod 644 {} + 2>/dev/null || true
find $APP/dist -type f -exec chmod 644 {} + 2>/dev/null || true
find $APP/dist -type d -exec chmod 755 {} + 2>/dev/null || true
cd $APP; set -a; . /etc/hello-pix/hello-pix.env; set +a
chmod 755 $APP/scripts/*.js 2>/dev/null || true
node scripts/migrate.js up 2>&1 | grep -E 'MIGRATION|Error' || true
systemctl restart hello-pix && sleep 5
echo \"  服务: \$(systemctl is-active hello-pix)\"
ls -ld $APP | sed 's/^/  /'
"
