#!/usr/bin/env bash
# Hello Pix 双域名上线脚本（幂等，可重复执行）
#
#   pixfanyi.com  → 官网 + 商户端 + 桌面客户端 API
#   lindufyht.com → 超管后台（独立域名，公网域名上完全隐藏 /admin 入口）
#
# 安全设计：
#   1. 公网域名上 `location ^~ /admin` 直接 404 —— 扫描器在 pixfanyi.com 上
#      根本发现不了超管登录入口。这是纵深防御，不是替代鉴权。
#   2. 超管域名只放行 /admin、/apis 与静态资源，其余 404，
#      避免商户界面在管理域名下暴露。
#   3. X-Forwarded-For 必须透传真实客户端 IP（Cloudflare real_ip 已解析到
#      $remote_addr）—— 若照抄其他站点"清空 XFF"的写法，后端 req.ip 会全部
#      变成 127.0.0.1，应用层的按 IP 限流会退化成所有人共用一个计数桶。
#   4. 分两阶段：证书不存在时绝不写 ssl_certificate 指令，
#      否则 nginx -t 失败会导致整台机器上所有业务站点一起挂掉。
set -euo pipefail

WEBROOT=/var/www/acme
AVAIL=/etc/nginx/sites-available
ENABLED=/etc/nginx/sites-enabled
STAMP=$(date +%Y%m%d%H%M%S)

log() { printf '  %s\n' "$*"; }

install -d -m 755 "$WEBROOT/.well-known/acme-challenge"

# HTTP/2 的写法在 nginx 1.25.1 变了：
#   旧版（<=1.25.0，如 Ubuntu 22.04 自带的 1.18）：listen 443 ssl http2;
#   新版：listen 443 ssl; 再单独一行 http2 on;
# 在旧 nginx 上写新语法会直接 "unknown directive http2"，nginx -t 失败，
# 整机所有站点都起不来（实测踩过，靠回滚才没波及其他业务）。这里按版本择一。
NGINX_VER=$(nginx -v 2>&1 | sed -E 's#.*nginx/([0-9]+\.[0-9]+\.[0-9]+).*#\1#')
if [ "$(printf '%s\n%s\n' "1.25.1" "$NGINX_VER" | sort -V | head -1)" = "1.25.1" ]; then
  HTTP2_STYLE="新版"
  LISTEN443="    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;"
else
  HTTP2_STYLE="旧版"
  LISTEN443="    listen 443 ssl http2;
    listen [::]:443 ssl http2;"
fi
log "nginx $NGINX_VER，HTTP/2 采用${HTTP2_STYLE}写法"

# ---------------------------------------------------------------- HTTP 阶段
# 只为 ACME 校验与跳转服务，不含任何证书引用，可安全启用。
write_http_only() {
  local domain=$1
  cat > "$AVAIL/${domain}.conf" <<EOF
# Hello Pix · ${domain} · HTTP（ACME 校验 + 跳转）
# 由 deploy/nginx/setup-domains.sh 生成于 ${STAMP}
server {
    listen 80;
    listen [::]:80;
    server_name ${domain} www.${domain};
    server_tokens off;

    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type text/plain;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF
}

# ---------------------------------------------------------------- HTTPS 阶段
write_https() {
  local domain=$1 kind=$2
  local extra=""
  if [ "$kind" = "public" ]; then
    # 公网域名：隐藏整个超管面（页面 + 接口），其余全部反代。
    # 只挡 /admin 页面是不够的：/apis/admin/* 同样不该在公网域名上可达 ——
    # 少一个暴露面就少一批被扫描/爆破的目标。商户端与桌面客户端都不走这个前缀。
    extra='    # 纵深防御：公网域名上不暴露超管入口与超管接口
    location ^~ /admin {
        return 404;
    }
    location ^~ /apis/admin/ {
        return 404;
    }

    # 客户端安装包由 nginx 直接读盘发送（零拷贝）。
    # 交给 Node 应用发 = 让单进程事件循环去搬几百 MB，而同机还有其他业务。
    # 注意目录刻意放在 /opt/hello-pix/downloads（**不在 dist 下**）：
    # 每次发布都会整体替换 dist，放在里面会被一起换掉（实测丢过一次）。
    location ^~ /downloads/ {
        alias /opt/hello-pix/downloads/;
        sendfile on;
        tcp_nopush on;
        autoindex off;
        add_header Cache-Control "public, max-age=86400" always;
    }

    location / {
        include /etc/nginx/snippets/hello-pix-proxy.conf;
    }
'
  else
    # 超管域名：只放行后台相关路径。
    # 注意 location / 必须在这一段里给出（兜底 404），模板末尾不能再追加一个，
    # 否则 nginx 报 duplicate location "/" 整份配置拒绝加载。
    extra='    # 超管域名只服务后台：商户界面不在此暴露。
    #
    # 根路径必须**直接出页面**（反代拿 index.html），既不能 302 到 /admin/login，
    # 也不能 302 到 /#/admin/login：
    #   - 302 到 /admin/login：前端是 hash 路由，路径形式会被 SPA 当成"URL 里没有 hash"，
    #     从而落到默认路由（官网首页）—— 这正是打开 lindufyht.com 看到官网的原因；
    #   - 302 到 /#/admin/login：hash 不会回传服务器，浏览器会反复请求 "/"，
    #     形成无限重定向。
    # 正确做法是出页面，由前端按域名判断后跳转（见 src/router/index.js 的 ADMIN_HOSTS）。
    location = / {
        include /etc/nginx/snippets/hello-pix-proxy.conf;
    }

    # SPA 静态资源（构建产物按扩展名/目录区分）
    location ~* ^/(css|js|fonts|img|media|static)/ {
        include /etc/nginx/snippets/hello-pix-proxy.conf;
    }
    location = /favicon.ico {
        include /etc/nginx/snippets/hello-pix-proxy.conf;
    }
    # 后台页面同样出 index.html，交给前端路由接管
    location ^~ /admin {
        include /etc/nginx/snippets/hello-pix-proxy.conf;
    }
    location ^~ /apis/ {
        include /etc/nginx/snippets/hello-pix-proxy.conf;
    }
    location / {
        return 404;
    }
'
  fi

  cat > "$AVAIL/${domain}.conf" <<EOF
# Hello Pix · ${domain} · HTTPS
# 由 deploy/nginx/setup-domains.sh 生成于 ${STAMP}
server {
    listen 80;
    listen [::]:80;
    server_name ${domain} www.${domain};
    server_tokens off;

    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type text/plain;
    }
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
${LISTEN443}
    server_name ${domain} www.${domain};
    server_tokens off;

    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:HP_SSL:5m;
    ssl_session_timeout 1h;

    client_max_body_size 2m;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # 边缘限流，与应用层 Redis 限流互补（应用层仍是权威）
    limit_req zone=hp_general burst=60 nodelay;
    limit_req_status 429;

${extra}}
EOF
}

# 反代公共片段：真实 IP 透传是这里的重点
install -d -m 755 /etc/nginx/snippets
cat > /etc/nginx/snippets/hello-pix-proxy.conf <<'EOF'
# Hello Pix 反向代理公共参数（勿在此清空 X-Forwarded-For，见脚本顶部说明）
proxy_pass http://127.0.0.1:3000;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
# 已经由 real_ip 模块消费成 $remote_addr，清掉避免下游误信客户端伪造值
proxy_set_header CF-Connecting-IP "";
proxy_hide_header Server;
proxy_read_timeout 120s;
EOF

# 边缘限流 zone（只在 conf.d 里定义一次，否则 nginx -t 报 duplicate zone）
if ! grep -rqs "zone=hp_general" /etc/nginx/conf.d/; then
  cat > /etc/nginx/conf.d/hello-pix-limits.conf <<'EOF'
# Hello Pix 边缘限流（按真实客户端 IP，依赖 conf.d/cf-realip.conf 的 real_ip）
limit_req_zone $binary_remote_addr zone=hp_general:10m rate=20r/s;
limit_req_zone $binary_remote_addr zone=hp_login:10m rate=12r/m;
EOF
  log "已创建 conf.d/hello-pix-limits.conf"
fi

backup() {
  local f=$1
  [ -f "$f" ] && cp -a "$f" "${f}.bak.${STAMP}" && log "已备份 $(basename "$f")"
}

enable_site() {
  local domain=$1
  backup "$AVAIL/${domain}.conf"
  ln -sfn "$AVAIL/${domain}.conf" "$ENABLED/${domain}.conf"
}

test_and_reload() {
  if nginx -t 2>&1 | tail -2 | grep -q "successful"; then
    systemctl reload nginx
    log "nginx 配置校验通过并已重载"
    return 0
  fi
  log "!! nginx 配置校验失败，已回滚该站点链接"
  nginx -t 2>&1 | sed 's/^/     /'
  return 1
}

dns_ready() {
  local d=$1
  getent ahostsv4 "$d" >/dev/null 2>&1
}

# ================================================================= 主流程
log "阶段 1/3：写入 HTTP 配置（不含证书，可安全启用）"
write_http_only pixfanyi.com
write_http_only lindufyht.com
enable_site pixfanyi.com
enable_site lindufyht.com
test_and_reload || exit 1

log ""
log "阶段 2/3：检查 DNS"
ready=0
for d in pixfanyi.com lindufyht.com; do
  if dns_ready "$d"; then
    log "  $d 已解析 ✓"
    ready=$((ready + 1))
  else
    log "  $d 尚未解析 —— 需在 Cloudflare 添加 A 记录指向 128.241.245.172"
  fi
done

if [ "$ready" -lt 2 ]; then
  log ""
  log "DNS 未就绪，停在阶段 2。补好 A 记录后重新执行本脚本即可继续。"
  exit 0
fi

log ""
log "阶段 3/3：申请证书并切换到 HTTPS"
for d in pixfanyi.com lindufyht.com; do
  if [ -d "/etc/letsencrypt/live/$d" ]; then
    log "  $d 证书已存在，跳过申请"
  else
    if certbot certonly --webroot -w "$WEBROOT" -d "$d" -d "www.$d" \
        --non-interactive --agree-tos --register-unsafely-without-email \
        --keep-until-expiring >/tmp/certbot-$d.log 2>&1; then
      log "  $d 证书申请成功 ✓"
    else
      log "  $d 证书申请失败，日志尾部："
      tail -12 "/tmp/certbot-$d.log" | sed 's/^/     /'
      log "  保持 HTTP 配置不变，未做任何破坏性改动。"
      continue
    fi
  fi

  kind=public
  [ "$d" = "lindufyht.com" ] && kind=admin
  write_https "$d" "$kind"
  if test_and_reload; then
    log "  $d 已切换 HTTPS ✓"
  else
    backup "$AVAIL/${d}.conf"
    write_http_only "$d"
    test_and_reload || true
    log "  $d 已回滚为 HTTP"
  fi
done

log ""
log "完成。可用以下命令自检："
log "  curl -sI https://pixfanyi.com | head -3"
log "  curl -sI https://lindufyht.com/admin/login | head -3"
log "  curl -s -o /dev/null -w '%{http_code}\\n' https://pixfanyi.com/admin/login   # 期望 404"
