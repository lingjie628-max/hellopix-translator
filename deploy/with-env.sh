#!/bin/bash
# 加载生产环境变量后执行命令。
# systemd 的 EnvironmentFile 语法对含特殊字符的值不友好（比如 DATABASE_URL
# 里的 # 与引号），而 systemctl 的 ExecStart 又不经过 shell，
# 所以统一用这个薄壳 source 一次，避免"环境变量少了一个导致任务静默失败"。
set -a
# shellcheck disable=SC1091
. /etc/hello-pix/hello-pix.env
set +a
exec "$@"
