#!/bin/zsh
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$ROOT/.tools/node/bin:$PATH"
cd "$ROOT"
if [ ! -x "$ROOT/.tools/node/bin/node" ]; then
  echo "未找到本项目自带的 Node。请先安装 Node.js 20+，或将 Node 放到 .tools/node 后重试。"
  exit 1
fi
npm run serve
