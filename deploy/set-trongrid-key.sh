#!/usr/bin/env bash
#
# 给生产环境加上 TRONGRID_API_KEY（幂等、可重复执行）。
#
# 为什么单独写一个脚本而不是随手 sed：
#
#   1. **Key 不能进 argv**。`sh -c "... $KEY ..."` 会把密钥暴露在远端进程表里
#      （同机器任何用户 `ps` 都能看到）。这里 Key 只走 **stdin**，
#      远端用 node 读 stdin 再写文件 —— 全程不进命令行。
#   2. **必须先备份**。环境文件里同时躺着数据库口令与各类密钥，改坏了
#      整个站起不来（server 与 watcher 都 source 它）。
#   3. **幂等**。Key 会轮换，重复执行要替换而不是追加出第二行 ——
#      两行同名变量时生效顺序取决于读取顺序，很容易误判。
#   4. **权限**。文件含密钥，写完必须仍是 600。
#
# 用法（Key 从 stdin 进，不要当参数传）：
#
#   printf '%s' '<你的Key>' | ./deploy/set-trongrid-key.sh
#
# 跑完会打印 Key 的长度与后 4 位用于核对，**不会**回显完整 Key。
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/hello-pix/hello-pix.env}"
REMOTE_JS=/tmp/hello-pix-set-trongrid-key.js

SSH_HOST="${SSH_HOST:-207.57.167.121}"
SSH_PORT="${SSH_PORT:-30071}"
SSH_KEY="$HOME/.ssh/pikesi_deploy"
SSH_OPTS=(-p "$SSH_PORT" -i "$SSH_KEY" -o BatchMode=yes
          -o ConnectTimeout=30 -o StrictHostKeyChecking=no)

if [ -t 0 ]; then
  echo "错误：Key 必须从 stdin 传入，例如：" >&2
  echo "  printf '%s' '<你的Key>' | $0" >&2
  exit 2
fi

KEY="$(cat)"
if [ -z "$KEY" ]; then
  echo "错误：stdin 里没有拿到 Key" >&2
  exit 2
fi

# 先把这个小工具送到远端。用带引号的 heredoc，本地不展开任何变量。
ssh "${SSH_OPTS[@]}" "root@$SSH_HOST" "cat > $REMOTE_JS" <<'REMOTE_JS_EOF'
'use strict'
const fs = require('fs')
const file = process.argv[2]
let key = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { key += chunk })
process.stdin.on('end', () => {
  key = key.trim()
  // TronGrid 的 Key 形如 UUID（十六进制 + 连字符）。这里刻意只做宽松校验：
  // 过严的规则会在厂家改格式时把正确 Key 拒掉，反而逼人去绕开校验。
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
    console.error('KEY_FORMAT_REJECTED：Key 含空白/换行或非法字符，或长度不对')
    process.exit(2)
  }
  const before = fs.readFileSync(file, 'utf8')
  const line = `TRONGRID_API_KEY=${key}`
  const pattern = /^TRONGRID_API_KEY=.*$/m
  const replaced = pattern.test(before)
  const after = replaced
    ? before.replace(pattern, line)
    : before.replace(/\n?$/, '\n') + line + '\n'

  const backup = `${file}.bak-${Date.now()}`
  fs.copyFileSync(file, backup)
  // 先写临时文件再改名：写到一半断电不会留下半个环境文件
  fs.writeFileSync(`${file}.tmp`, after, { mode: 0o600 })
  fs.chmodSync(`${file}.tmp`, 0o600)
  fs.renameSync(`${file}.tmp`, file)

  console.log(`OK 替换=${replaced ? '是' : '否（新增）'} 长度=${key.length} 尾号=...${key.slice(-4)}`)
  console.log(`备份=${backup}`)
})
REMOTE_JS_EOF

echo "--- 写入 $ENV_FILE ---"
printf '%s' "$KEY" | ssh "${SSH_OPTS[@]}" "root@$SSH_HOST" "node $REMOTE_JS $ENV_FILE"

echo ""
echo "--- 复核：权限应为 600、且只有一行 TRONGRID_API_KEY ---"
ssh "${SSH_OPTS[@]}" "root@$SSH_HOST" \
  "ls -l $ENV_FILE; echo -n '  行数: '; grep -c '^TRONGRID_API_KEY=' $ENV_FILE; rm -f $REMOTE_JS"

echo ""
echo "--- 下一轮 watcher 就会带上这个 Key（定时器每 1 分钟一轮） ---"
echo "  想立刻验证：systemctl start hello-pix-recharge-watcher.service"
echo "  看日志    ：journalctl -u hello-pix-recharge-watcher -n 30 --no-pager"
