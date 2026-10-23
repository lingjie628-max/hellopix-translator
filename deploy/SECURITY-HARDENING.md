# 安全加固清单（代码之外的那一半）

代码层面的漏洞已经修在仓库里了。但**有几类问题代码修不掉或修不全**，必须在
服务器 / 云账号 / 网络层做。这份清单按"不做的后果"排序，别跳过。

---

## 1. 强制 IMDSv2（最高优先，5 分钟能做完）

**为什么**：我们刚把 SSRF 堵死了三道闸（保存校验 / 请求前校验 / 建连校验）。
但 SSRF 防线的价值在于"**即使被绕过也拿不到东西**"。云元数据服务就是最后那个
"拿到就能接管整台机器"的东西。

**攻击方式**（搜到的真实案例：Capital One）：

```
GET http://169.254.169.254/latest/meta-data/iam/security-credentials/
→ 返回实例角色名
GET http://169.254.169.254/latest/meta-data/iam/security-credentials/<角色名>
→ 返回 AccessKeyId / SecretAccessKey / Token（临时凭据，可直接用 aws cli）
```

拿到的凭据能读 S3、改 IAM、开机器 —— 一个 SSRF 直接升格成云账号接管。

**做法**：IMDSv2 要求先 `PUT /latest/api/token` 带自定义 header 拿 session token，
再用该 token 发后续请求。SSRF **几乎不可能**伪造这个两段式流程（除非能完全控制
方法和 header）。

```bash
# AWS：把现有实例改成强制 IMDSv2
aws ec2 modify-instance-metadata-options \
  --instance-id i-xxxxxxxx \
  --http-tokens required \
  --http-endpoint enabled \
  --http-put-response-hop-limit 1

# 用启动模板/ASG 的话，在模板里设：
#   MetadataOptions.HttpTokens=required
#   MetadataOptions.HttpPutResponseHopLimit=1
```

`HttpPutResponseHopLimit=1` 这条也很关键：**容器里拿不到 token**，所以就算
应用跑在 Docker 里被反打，也读不到宿主的元数据。

阿里云 / 腾讯云对应：在实例"元数据"设置里开启"仅加固模式 / Token 强制"。

**验证**：在服务器上执行下面这条，应该返回 `401` 而不是角色名：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://169.254.169.254/latest/meta-data/iam/security-credentials/
# 期望：401
```

---

## 2. 出站防火墙（纵深防御）

应用服务器**不需要**主动连除了翻译厂商 / SMTP / 链上节点以外的地方。
用安全组或 iptables 把出站收紧，SSRF 就算绕过代码层也打不出去。

```bash
# 示例：只放行必要出站（AWS 安全组 egress 规则 / 或主机 iptables）
# 443 出站到翻译厂商与 SMTP 端口，其余拒绝
# 最关键的是**拒绝**这几类：
#   169.254.0.0/16   云元数据
#   10.0.0.0/8       内网
#   172.16.0.0/12    内网
#   192.168.0.0/16   内网
#   127.0.0.0/8      本机（Redis/PG 如果同机部署，用 unix socket 或显式放行端口）
```

注意：如果 Redis / PostgreSQL 和 Node 在同一台机器或同一 VPC，**必须显式放行
它们的端口**，否则收紧出站会把业务打死。先 `ss -tlnp` 看清在监听什么。

---

## 3. 后台会话的二次防线

已经做了：

- 会话绑定 IP 网段（/24、/48）
- 高危操作要 `X-Pix-Reauth` 二次密码
- 能力白名单 + fail-closed（未登记路由直接 500）

**还没做的（建议）**：

- 后台**不对外暴露公网入口**。用 VPN / 堡垒机 / Cloudflare Access，或者至少
  在 Nginx 层对 `/apis/admin/` 加 IP 白名单：

```nginx
location /apis/admin/ {
    allow 1.2.3.4;      # 办公室固定 IP
    allow 10.0.0.0/8;   # 内网 / VPN 段
    deny all;
    proxy_pass http://127.0.0.1:3000;
    # ... 其余 proxy_set_header 保持与主 location 一致
}
```

这一条能挡住"会话被偷"之后的所有后台操作 —— 比任何应用层鉴权都直接。

---

## 4. 密钥与凭据

- 翻译厂商密钥当前用 `PIX_CREDENTIAL_KEY`（`server/lib/credentials.js`）加密落库。
  **这个 key 必须存在环境变量/KMS，不能进仓库、不能进镜像**。
- 换过密钥后，旧密文解不开会报 `CREDENTIAL_KEY_MISSING`，需要在后台重填一次。
- Nginx 已改为 `X-Forwarded-For $remote_addr`（不再信任客户端传的 XFF），
  改完 `nginx -t && systemctl reload nginx` 生效。**这条不生效的话，IP 限流和
  会话网段绑定都能被伪造头绕过。**

```bash
# 验证 XFF 伪造是否被挡住：带一个假 XFF 请求，看后端日志里的 IP
curl -H 'X-Forwarded-For: 1.2.3.4' https://<你的域名>/apis/site/info
# 后端日志 [api] ... 里的来源 IP 必须是你的真实出口 IP，不是 1.2.3.4
```

---

## 5. 日志与告警

本次入侵（2026-10-23）最大的教训不是"漏洞"，是**事后 3 小时没人发现**。
以下事件必须触发告警（`server/lib/ops-alert.js` 已有通道）：

| 事件 | 为什么 |
|---|---|
| 新建 / 修改超管账号 | 攻击者干的第一件事 |
| 同一账号连续登录失败 ≥ 5 次 | 暴力破解 |
| 会话从一个网段跳到另一个网段 | 会话被偷（现在会直接作废，但要看得到） |
| `/admin/*` 报错 `CAPABILITY_NOT_DECLARED` | fail-closed 兜住了一次未登记路由（说明有人加路由忘了登记能力，或被探测到不存在的能力） |
| 新的登录 IP 首次出现 | 已在 `auth-service` 里做了审计，确保接上告警 |
| 出站请求被 SSRF 拦截（`SSRF_BLOCKED`） | 说明真的有人在打 SSRF |
| 二次认证失败 | 有人拿到了会话但没拿到密码 |

最后三条是这次新加的，需要确认告警通道真的收到。

---

## 6. 定期自查命令（贴上去就能跑）

```bash
# 1. 元数据是否已强制 IMDSv2（返回 401 才对）
curl -s -o /dev/null -w 'IMDS: %{http_code}\n' \
  http://169.254.169.254/latest/meta-data/iam/security-credentials/

# 2. 有没有人能绕过 Nginx 直接打 Node
ss -tlnp | grep -E ':3000|:8080'   # 应用端口监听地址必须是 127.0.0.1

# 3. 数据库/Redis 是否只监听内网
ss -tlnp | grep -E ':5432|:6379'

# 4. 全量安全测试（发布前必跑）
npm run test:security

# 5. 严格模式（要求真 PG/Redis，缺环境会失败而不是跳过）
eval "$(./scripts/test-env.sh up)"
npm run test:strict
```

---

## 与代码对应的三处修复

方便对着看：

| 层 | 文件 | 做了什么 |
|---|---|---|
| 保存时 | `server/routes/admin/clients.js` | endpoint 落库前做 DNS + 网段校验 |
| 请求前 | `server/lib/http-pool.js` `pooledFetch` | 每次出站前用解析结果再验一次（带缓存） |
| 建连时 | `server/lib/http-pool.js` `agentFor` | undici `connect` 钩子里拿到实际 IP 再验一次，封死 DNS rebinding |

校验逻辑全部集中在 `server/lib/outbound-guard.js`，测试在
`test/ssrf-guard.test.js`（含 IPv4-mapped IPv6 十六进制、尾点、短写等已知绕过手法）。
