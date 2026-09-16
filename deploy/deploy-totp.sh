#!/usr/bin/env bash
# 部署超管两步验证（TOTP）到生产。
#
# 两个踩过的坑，脚本里都规避了：
#   1. 短时间连开多个 scp/ssh 会触发服务器上的 fail2ban 而断连 —— 改为
#      一条 SSH 连接 + tar 管道传完。
#   2. 远程脚本不能走 heredoc：heredoc 会占用 stdin，和 tar 管道打架
#      （表现为 "tar: Write error" / "not in gzip format"）。所以远程脚本
#      也打进包里，先解包再执行。
#
# 顺序：先传+修权限 → 手工跑迁移并核对 → 再重启 → 真实请求验证。
# 迁移是 ExecStartPre，若文件权限不对会 EACCES 导致服务起不来。
set -euo pipefail

HOST=${PIX_HOST:?需要 PIX_HOST}
PORT=${PIX_PORT:-30071}
KEY=${PIX_KEY:?需要 PIX_KEY}
APP=/opt/hello-pix
SSH_OPTS="-p $PORT -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=no -o ServerAliveInterval=15"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

echo "== 1/3 暂存文件 =="
mkdir -p "$STAGE/server/lib" "$STAGE/server/services" "$STAGE/server/routes" \
         "$STAGE/server/repositories" "$STAGE/migrations" "$STAGE/dist"
cp server/lib/totp.js                            "$STAGE/server/lib/"
cp server/services/admin-totp-service.js         "$STAGE/server/services/"
cp server/services/auth-service.js               "$STAGE/server/services/"
cp server/routes/production.js                   "$STAGE/server/routes/"
cp server/repositories/production-repository.js  "$STAGE/server/repositories/"
cp migrations/009_admin_totp.js                  "$STAGE/migrations/"
cp -R dist/. "$STAGE/dist/"

cat > "$STAGE/deploy-remote.sh" <<'REMOTE'
set -euo pipefail
export LC_ALL=C.UTF-8
APP=/opt/hello-pix

cp -a "$APP/.incoming/server/."     "$APP/server/"
cp -a "$APP/.incoming/migrations/." "$APP/migrations/"

# 前端整体替换，避免新旧 chunk 混杂导致白屏
rm -rf "$APP/dist.old"
mv "$APP/dist" "$APP/dist.old"
mv "$APP/.incoming/dist" "$APP/dist"
rm -rf "$APP/.incoming"
rm -f "$APP/deploy-remote.sh"

# 迁移由 hello-pix 用户执行，必须可读（历史上踩过 600 导致 EACCES）
chown -R root:root "$APP/server" "$APP/migrations" "$APP/dist"
find "$APP/server" "$APP/migrations" -type f -exec chmod 644 {} +
find "$APP/dist" -type f -exec chmod 644 {} +
find "$APP/dist" -type d -exec chmod 755 {} +

echo "--- admins 列（迁移前）---"
su - postgres -c "psql -d hello_pix -tAc \"SELECT string_agg(column_name,',' ORDER BY column_name) FROM information_schema.columns WHERE table_name='admins';\""

echo "--- 执行迁移 ---"
cd "$APP" && runuser -u hello-pix -- /usr/bin/node scripts/migrate.js up 2>&1 | tail -6

echo "--- admins 列（迁移后）---"
su - postgres -c "psql -d hello_pix -tAc \"SELECT string_agg(column_name,',' ORDER BY column_name) FROM information_schema.columns WHERE table_name='admins';\""
echo -n "    新表: "
su - postgres -c "psql -d hello_pix -tAc \"SELECT coalesce(string_agg(tablename,','),'(无)') FROM pg_tables WHERE tablename IN ('admin_recovery_codes','admin_totp_events');\""

echo "--- 重启服务 ---"
systemctl restart hello-pix
sleep 4
echo "    状态: $(systemctl is-active hello-pix)"

echo "--- 真实请求验证 ---"
curl -s -o /dev/null -w "    首页 %{http_code}\n" http://127.0.0.1:3000/
curl -s -o /dev/null -w "    验证码接口 %{http_code}\n" http://127.0.0.1:3000/apis/user/captcha
curl -s -o /dev/null -w "    未登录 /apis/admin/totp = %{http_code}（期望 401）\n" http://127.0.0.1:3000/apis/admin/totp
curl -s -o /dev/null -w "    未登录 /apis/admin/login/totp = %{http_code}（期望 401）\n" -X POST http://127.0.0.1:3000/apis/admin/login/totp

echo "--- 启动日志报错 ---"
journalctl -u hello-pix --since "2 min ago" --no-pager | grep -iE "error|exception" | tail -5 || echo "    无"
REMOTE

echo "== 2/3 单连接上传并执行 =="
tar -C "$STAGE" -czf - . | ssh $SSH_OPTS root@$HOST \
  "mkdir -p $APP/.incoming && tar -C $APP/.incoming -xzf - && bash $APP/.incoming/deploy-remote.sh" \
  2>&1 | sed 's/^/  /'

echo "== 3/3 完成 =="
