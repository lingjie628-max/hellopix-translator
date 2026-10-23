# 部署脚本依赖的线上文件清单

这些文件**不在** `server/` `migrations/` `dist/` `scripts/` 的推送范围里，
但生产环境必须有。早先它们只存在于服务器上、仓库里没有副本，
2026-10-22 那次部署把 `scripts/` 整个覆盖掉，`preflight.sh` 消失，
systemd `ExecStartPre` 找不到可执行文件，服务 `status=203/EXEC` 起不来。

现在**原件放在本目录**（`deploy/ops-scripts/`），作为唯一可信来源：

| 文件 | 线上位置 | 用途 |
| --- | --- | --- |
| `preflight.sh` | `/opt/hello-pix/scripts/preflight.sh` | systemd `ExecStartPre` 启动前自检 |
| `probe-vendor-latency.js` | `/opt/hello-pix/scripts/probe-vendor-latency.js` | 上游厂商延迟探针 |

## 新环境首次部署

```bash
scp deploy/ops-scripts/* root@<host>:/opt/hello-pix/scripts/
ssh root@<host> 'chmod +x /opt/hello-pix/scripts/preflight.sh && chown hello-pix:hello-pix /opt/hello-pix/scripts/*'
```

## 部署脚本现在怎么保护它们

`deploy-code.sh` 解包到 `.incoming` 后、覆盖线上目录前，会把**线上有而仓库里没有**
的 `scripts/*` 一并搬进 `.incoming` —— 所以就算有人往服务器上临时放了脚本，
也不会被下一次部署冲掉。

## 改动 preflight.sh 的流程

1. 改本目录下的 `preflight.sh`
2. 手动 `scp` 到线上（它不在自动推送范围里）
3. 确认 `systemctl is-active hello-pix` 仍是 `active`

不这么做的话，改完后线上跑的还是旧版本，排查时会怀疑到怀疑人生。
