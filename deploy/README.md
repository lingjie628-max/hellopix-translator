# Hello Pix 单机 HTTPS 部署

PostgreSQL 16、Redis 7 和正式核心 API 已经接入。生产进程只注册持久化后端：
认证、用户/子账号、工单、字符余额、翻译账本、管理员和站点核心接口走数据库与 Redis。
支付、注册找回、导出、短链、助手等未迁移模块返回 `503 / NOT_MIGRATED`，不得用于正式收费。

## 启动 PostgreSQL 与 Redis

1. 在部署机创建仅 root 可读的环境文件，例如 `/etc/hello-pix/hello-pix.env`：

   ```sh
   NODE_ENV=production
   HOST=127.0.0.1
   PORT=3000
   ALLOWED_ORIGINS=https://pix.example.com
   DATABASE_URL=postgres://hello_pix:替换为随机数据库密码@127.0.0.1:5432/hello_pix
   DATABASE_SSL_MODE=disable
   REDIS_URL=redis://:替换为随机Redis密码@127.0.0.1:6379/0
   REDIS_KEY_PREFIX=
   ```

2. 分别生成至少 32 字节随机密码，不要提交到仓库：

   ```sh
   openssl rand -hex 32
   ```

3. 启动容器（变量值必须与上一步 URL 内的密码一致）：

   ```sh
   export POSTGRES_PASSWORD='数据库密码'
   export REDIS_PASSWORD='Redis密码'
   docker compose -f deploy/docker-compose.yml up -d
   docker compose -f deploy/docker-compose.yml ps
   ```

服务只绑定 `127.0.0.1:5432` 和 `127.0.0.1:6379`，数据保存于命名卷。
远程 PostgreSQL 不得使用 `DATABASE_SSL_MODE=disable`；应使用 `verify-full` 并设置
`DATABASE_SSL_CA_FILE`。

## 安装、迁移与建号

1. 将项目放到 `/opt/hello-pix`，安装 Node.js 20 或更高版本，执行：

   ```sh
   npm ci
   npm run build
   set -a; . /etc/hello-pix/hello-pix.env; set +a
   npm run db:migrate
   ```

2. 迁移只预置套餐、翻译引擎和非敏感设置，不创建用户或管理员。首次管理员必须手动创建：

   ```sh
   install -m 600 /dev/null /run/hello-pix-admin-password
   { openssl rand -base64 24 | tr -d '\n'; printf '!Aa9'; } > /run/hello-pix-admin-password
   ADMIN_USERNAME=your-admin \
   ADMIN_NICKNAME='系统管理员' \
   ADMIN_ROLE=superadmin \
   ADMIN_PASSWORD_FILE=/run/hello-pix-admin-password \
   npm run seed:admin
   rm -f /run/hello-pix-admin-password
   ```

密码必须为 16-128 位，同时包含大小写字母、数字和特殊字符，且不能包含用户名。
脚本拒绝覆盖已有管理员。

回滚最近一个迁移使用 `npm run db:rollback`。生产回滚前必须备份；Schema 回滚会删表，
不得在有业务数据时执行。

启动前会检查 PostgreSQL、Redis 和迁移版本；任一失败即拒绝启动。探活：

```sh
curl -sS http://127.0.0.1:3000/health
```

备份示例：

```sh
pg_dump "$DATABASE_URL" | gzip > /var/backups/hello-pix-$(date +%F).sql.gz
redis-cli -u "$REDIS_URL" --rdb /var/backups/hello-pix-$(date +%F).rdb
```

## systemd 与 HTTPS

1. 创建不可登录的系统用户：`sudo useradd --system --home /opt/hello-pix --shell /usr/sbin/nologin hello-pix`。
2. 把 `deploy/hello-pix.service` 安装到 `/etc/systemd/system/`，并执行
   `sudo chmod 600 /etc/hello-pix/hello-pix.env`。
3. 安装 Nginx 和 Certbot，先把 `deploy/nginx/hello-pix.conf` 内的 `pix.example.com` 替换为正式域名。
4. 申请证书：`sudo certbot certonly --nginx -d 正式域名`。
5. 检查并加载配置：`sudo nginx -t && sudo systemctl reload nginx`。
6. 验证：公网只能访问 80/443，3000 端口不得开放；`curl -I https://正式域名` 应包含 HSTS。

正式 Electron 线路必须使用 `https://正式域名`，不得使用 HTTP 或服务器 IP。

## 上线前强制事项

- 用 `npm run db:migrate` 和 `npm run seed:admin` 完成空库初始化，不得加载内存 Mock。
- 删除演示账号 `pix/demo/admin`；开发环境也必须显式设置 `PIX_ENABLE_DEMO_DATA=1` 才能加载。
- 关闭验证码演示回显，配置真实邮箱服务后再开放注册/找回。
- 支付默认关闭；接入官方回调验签、幂等键和数据库事务前不得开放。
- Electron 正式线路和下载地址必须列入 `PIX_ALLOWED_API_HOSTS` /
  `PIX_ALLOWED_DOWNLOAD_HOSTS`，并使用 HTTPS。
- 翻译通道默认 `wired=false`；配置厂商凭据前不得把引擎标为已接通。
