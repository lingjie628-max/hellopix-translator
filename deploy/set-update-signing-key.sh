#!/usr/bin/env bash
#
# 给生产环境加上 UPDATE_SIGNING_KEY（幂等、可重复执行）。
#
# 这份私钥是**更新通道的根信任**：它能签出任何安装包的合法清单，
# 而全球所有客户端都会一路放行（客户端验的正是这把钥签的东西）。
# 泄露 = 所有用户可被推任意代码。所以处理方式和普通 API Key 不同：
#
#   1. **只走 stdin**。私钥含换行（PEM），走 argv 会被远端 `ps` 一眼看到，
#      而且 base64/换行在命令行里极易被 shell 吃掉一个字符 —— 签出来
#      的清单客户端验不过，现象是"更新全部失败"，却看不出是传输坏了。
#   2. **先备份再写**。这个文件里躺着数据库口令，写坏了整站起不来。
#   3. **幂等**。轮换时替换而不是追加 —— 同名变量两行时生效顺序取决于
#      读取顺序，最容易出的错是"以为换掉了、其实还是旧的"。
#   4. **写完当场自检**。用写进去的私钥真签一份清单、再打印公钥指纹，
#      和客户端内置的公钥对得上才算成功。光看"写进去了"不算数。
#   5. **权限 600**。
#
# 用法：
#
#   ./deploy/set-update-signing-key.sh < keys/update-signing.key
#
# 跑完会打印私钥指纹（公钥的 sha256 前 16 位），**不会**回显私钥内容。
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/hello-pix/hello-pix.env}"
REMOTE_JS=/tmp/hello-pix-set-update-key.js

SSH_HOST="${SSH_HOST:-207.57.167.121}"
SSH_PORT="${SSH_PORT:-30071}"
SSH_KEY="$HOME/.ssh/pikesi_deploy"
SSH_OPTS=(-p "$SSH_PORT" -i "$SSH_KEY" -o BatchMode=yes
          -o ConnectTimeout=30 -o StrictHostKeyChecking=no)

if [ -t 0 ]; then
  echo "错误：私钥必须从 stdin 传入，例如：" >&2
  echo "  $0 < keys/update-signing.key" >&2
  exit 2
fi

KEY="$(cat)"
if [ -z "$KEY" ]; then
  echo "错误：stdin 里没有拿到私钥" >&2
  exit 2
fi

# 本地先验一遍：格式不对就别往生产上送。
# 这一步用临时文件而不是 -e 参数，避免私钥出现在本机进程表里。
TMPKEY=$(mktemp)
trap 'rm -f "$TMPKEY"' EXIT
printf '%s' "$KEY" > "$TMPKEY"
chmod 600 "$TMPKEY"
if ! node -e '
  const crypto = require("crypto")
  const fs = require("fs")
  const raw = fs.readFileSync(process.argv[1], "utf8").trim()
  const key = raw.includes("-----BEGIN")
    ? crypto.createPrivateKey(raw.replace(/\\n/g, "\n"))
    : crypto.createPrivateKey({ key: Buffer.from(raw, "base64"), format: "der", type: "pkcs8" })
  if (key.asymmetricKeyType !== "ed25519") {
    console.error("类型不是 ed25519，实际是 " + key.asymmetricKeyType)
    process.exit(1)
  }
  const pub = crypto.createPublicKey(key).export({ type: "spki", format: "der" })
  console.log("指纹 " + crypto.createHash("sha256").update(pub).digest("hex").slice(0, 16))
  console.log("单行 " + pub.toString("base64"))
' "$TMPKEY"; then
  echo "错误：私钥格式不对，已中止（生产环境未被改动）" >&2
  exit 2
fi

# 远端小工具。带引号的 heredoc，本地不展开任何变量。
ssh "${SSH_OPTS[@]}" "root@$SSH_HOST" "cat > $REMOTE_JS" <<'REMOTE_JS_EOF'
'use strict'
const fs = require('fs')
const crypto = require('crypto')

const file = process.argv[2]
let key = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { key += chunk })
process.stdin.on('end', () => {
  key = key.replace(/\r\n/g, '\n').trim()
  if (!key) { console.error('EMPTY_KEY'); process.exit(2) }

  // 写入前必须能解析成 ed25519 —— 否则服务会一直"签名失败"，
  // 而 findUpdate 只是不打清单，表面上一切正常，很难查。
  let pubB64 = ''
  try {
    const priv = key.includes('-----BEGIN')
      ? crypto.createPrivateKey(key.replace(/\\n/g, '\n'))
      : crypto.createPrivateKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'pkcs8' })
    if (priv.asymmetricKeyType !== 'ed25519') {
      console.error('KEY_TYPE_REJECTED：' + priv.asymmetricKeyType)
      process.exit(2)
    }
    pubB64 = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64')
  } catch (e) {
    console.error('KEY_PARSE_FAILED：' + e.message)
    process.exit(2)
  }

  // ── 写进环境文件 ──────────────────────────────────────────────
  //
  // 环境文件是 KEY=VALUE 逐行，值里不能有裸换行 —— 否则 systemd 的
  // EnvironmentFile 会把后续行当成新变量，私钥只进去半截，
  // 报错是"签名失败"，完全看不出是格式问题。
  //
  // 所以统一存成**单行 base64**（服务端 parsePrivateKey 本来就支持这种）。
  // 若传入是 PEM，就转成 PKCS8 DER 的单行 base64 再存。
  let stored = key
  if (key.includes('-----BEGIN')) {
    const priv = crypto.createPrivateKey(key.replace(/\\n/g, '\n'))
    stored = priv.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(stored)) {
    console.error('KEY_FORMAT_REJECTED：base64 里出现了非法字符')
    process.exit(2)
  }

  const before = fs.readFileSync(file, 'utf8')
  const line = `UPDATE_SIGNING_KEY=${stored}`
  const pattern = /^UPDATE_SIGNING_KEY=.*$/m
  const replaced = pattern.test(before)
  if (pattern.test(before.replace(pattern, ''))) {
    // 已经有两行同名变量 —— 先清干净，否则"哪一行生效"取决于解析顺序
    console.error('DUPLICATE_KEY_LINES：环境文件里已有多个 UPDATE_SIGNING_KEY，请人工清理')
    process.exit(2)
  }
  const after = replaced
    ? before.replace(pattern, line)
    : before.replace(/\n?$/, '\n') + line + '\n'

  const backup = `${file}.bak-${Date.now()}`
  fs.copyFileSync(file, backup)
  fs.writeFileSync(`${file}.tmp`, after, { mode: 0o600 })
  fs.chmodSync(`${file}.tmp`, 0o600)
  fs.renameSync(`${file}.tmp`, file)

  const fingerprint = crypto.createHash('sha256').update(Buffer.from(pubB64, 'base64')).digest('hex').slice(0, 16)
  console.log(`OK 替换=${replaced ? '是' : '否（新增）'} 长度=${stored.length} 指纹=${fingerprint}`)
  console.log(`公钥=${pubB64}`)
  console.log(`备份=${backup}`)
})
REMOTE_JS_EOF

echo "--- 写入 $ENV_FILE ---"
printf '%s' "$KEY" | ssh "${SSH_OPTS[@]}" "root@$SSH_HOST" "node $REMOTE_JS $ENV_FILE"

echo ""
echo "--- 复核：权限 600、恰好一行 ---"
ssh "${SSH_OPTS[@]}" "root@$SSH_HOST" \
  "ls -l $ENV_FILE; echo -n '  UPDATE_SIGNING_KEY 行数: '; grep -c '^UPDATE_SIGNING_KEY=' $ENV_FILE; rm -f $REMOTE_JS"

echo ""
echo "--- 下一步 ---"
echo "  1. 在客户端 trusted-keys.js 的 PRIMARY 填入上面打印的公钥"
echo "  2. systemctl restart hello-pix"
echo "  3. journalctl -u hello-pix -n 50 --no-pager | grep -i 签名"
