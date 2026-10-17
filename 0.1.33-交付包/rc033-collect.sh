#!/usr/bin/env bash
#
# 0.1.33 真机取证（macOS）—— 只读，不改任何东西。
#
# 本轮改的是**节点检测**（用户报：「仍然显示节点连不上」）。
#
# 三处改动：
#   ① 多目标并发预检：以前只 CONNECT 一个固定目标（api.ipify.org），一次失败就判
#      "节点连不上"。真机抓到的节点对不同目标回不同应答码（1.1.1.1→0x01，
#      8.8.8.8/域名→0x08），单目标判定太脆弱。现在并发试 4 个目标
#      （含 web.whatsapp.com，用户真正要开的站），任一成功即判可用。
#   ② 0x08 文案改准确：以前写「可能只支持 IPv4」，但真机上同一节点对纯 IPv4
#      字面量也拒绝 —— 这个解释是错的。改成「节点拒绝了连接（可能是流量用尽、
#      套餐到期或 IP 白名单未加），请联系代理服务商」。
#   ③ 同节点复用中继：以前一窗口一中继，开 60 个窗口 = 向节点开 60 条连接，
#      可能触发代理商的并发上限。现在按 host/port/账密池化 + 引用计数，
#      最后一个窗口关掉才真正关闭。
#
# 本轮要采的六件事（详见《0.1.33-真机复测手册.md》）：
#   ① ★核心★ 好节点必须判可用（不能被新逻辑误杀 —— 这是回归红线）
#   ② ★核心★ 坏节点 1~2 秒内报错，且提示里不能有「IPv4」和 reply=数字
#   ③ 慢节点不被提前判死
#   ④ ★核心★ 20 个窗口共用中继；关掉 5 个后剩下 15 个仍正常；
#             日志/端口里只应看到一个中继端口
#   ⑤ 改节点即时生效，且不影响其他窗口
#   ⑥ 退出后端口全部释放
#
# 说明：节点检测的结果不写日志（只走 UI），所以 ①②③ 以肉眼 + 截图验收为主。
#       本脚本采的是"主干没坏"的证据 + 环境与版本 + 本地监听端口 + 网络出口。
#
# 用法（建议按顺序采，每采一次都会追加到同一个文件）：
#   bash rc033-collect.sh before
#   # ① 用能用的节点做一次检测
#   bash rc033-collect.sh after-good-node
#   # ② 用坏节点做一次检测
#   bash rc033-collect.sh after-bad-node
#   # ④ 开 20 个窗口，关掉 5 个
#   bash rc033-collect.sh after-multi-window
#   # ⑥ 完全退出前再采一次
#   bash rc033-collect.sh before-quit
#
# 产出：./rc033-evidence-<电脑名>.txt（多次调用**追加**，不覆盖）
#       把这个文件整个发回即可；它只读、不含口令。
#
# 安全：绝不打印口令。auth.json 只报用户名；proxyPass 一律不打印。
# ---------------------------------------------------------------------------
set -uo pipefail

LABEL="${1:-snapshot}"
APPDIR="$HOME/Library/Application Support/Hello Pix"
OUT="./rc033-evidence-$(scutil --get ComputerName 2>/dev/null || hostname -s).txt"

fill () { printf '%*s' "${2:-60}" '' | tr ' ' "${1:--}"; }
title () { echo; echo "$(fill '=' 78)"; echo " $*"; echo "$(fill '=' 78)"; }

{
  title "0.1.33 取证 · label=$LABEL"
  echo " 时间 : $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo " 主机 : $(scutil --get ComputerName 2>/dev/null || hostname)"
  echo " 系统 : $(sw_vers -productVersion 2>/dev/null) / $(uname -m)"

  echo
  echo "---- 1. 已安装版本（必须是 0.1.33）----"
  for app in "/Applications/Hello Pix.app" "$HOME/Applications/Hello Pix.app"; do
    if [ -d "$app" ]; then
      echo "  $app"
      echo "    版本: $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || echo '读不到')"
    fi
  done

  echo
  echo "---- 2. 进程（看开了几个副本 + 运行时版本）----"
  ps -Ao pid,etime,comm,args 2>/dev/null | grep -iE "Hello ?Pix|hello-pix" | grep -v grep | sed 's/^/  /' || echo "  （没有在跑）"

  echo
  echo "---- 3. auth.json（只报用户名，绝不打印口令）----"
  if [ -f "$APPDIR/auth.json" ]; then
    python3 - "$APPDIR/auth.json" <<'PY' 2>&1 | sed 's/^/  /'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
print('  username    =', d.get('username'))
print('  passwordEnc =', '有（内容不打印）' if d.get('passwordEnc') else '无')
PY
  else
    echo "  （无 auth.json）"
  fi

  LOGDIR="$APPDIR/logs"
  TODAY="$LOGDIR/hello-pix-$(date '+%Y-%m-%d').log"

  echo
  echo "---- 4. 桥健康（没有 [preload] 翻译桥已就绪 = 立刻停止并回传）----"
  if [ -f "$TODAY" ]; then
    grep -aE "\[preload\]|翻译桥|PIX_TRACE" "$TODAY" 2>/dev/null \
      | grep -avE "static\.whatsapp\.net|preloaded using link preload" \
      | tail -20 | sed 's/^/  /' || echo "  （没有记录）"
    echo "  （以上应含：[preload] 翻译桥已就绪；以及各条发送链的 [PIX_TRACE]）"
  else
    echo "  （今天还没有日志文件：$TODAY）"
  fi

  if [ "$LABEL" = "before" ]; then
    echo
    echo "---- 5. before：只记行数，不贴内容 ----"
    [ -f "$TODAY" ] && echo "  今日日志行数: $(wc -l < "$TODAY")" || echo "  （无日志）"
  else
    echo
    echo "---- 5. ★主干未坏★ 翻译调用（服务端实际用的通道 / 来源）----"
    if [ -f "$TODAY" ]; then
      grep -aE "source_text=|\[translate\]|engine=" "$TODAY" 2>/dev/null | tail -40 | sed 's/^/  /' || echo "  （没有翻译调用记录）"

      echo
      echo "  --- 翻译来源占比（私聊自动 / 手动点译 / 发送翻译）---"
      python3 - "$TODAY" <<'PY' 2>&1 | sed 's/^/  /'
import re, sys
counts = {}
try:
    with open(sys.argv[1], encoding='utf-8', errors='replace') as f:
        for line in f:
            m = re.search(r'trigger=([a-z_]+)', line)
            if m:
                counts[m.group(1)] = counts.get(m.group(1), 0) + 1
except FileNotFoundError:
    pass
total = sum(counts.values()) or 1
for name in ('auto_receive', 'manual_click', 'manual_send'):
    n = counts.get(name, 0)
    print('    %-14s %4d 次  (%d%%)' % (name, n, round(n * 100.0 / total)))
for extra in sorted(k for k in counts if k not in ('auto_receive', 'manual_click', 'manual_send')):
    print('    %-14s %4d 次' % (extra, counts[extra]))
print('    ── 私聊：auto_receive 应 > 0；点「译」：manual_click 应 > 0；发送翻译：manual_send 应 > 0')
PY

      echo
      echo "  --- ★发送链未坏★ 原生输入链 + 正文校验 ---"
      grep -aE "NATIVE_INPUT_BEGIN|COMPOSER_CLEARED|NATIVE_TEXT_INSERTED|LEXICAL_SETTLED|FINAL_TEXT_VALIDATED|PROGRAMMATIC_SEND|SEND_FAIL_CLOSED|SEND_BODY_MISMATCH_DETAIL" "$TODAY" 2>/dev/null | tail -60 | sed 's/^/  /' || echo "  （本轮没有发送链记录：没做发送验收）"

      echo
      echo "  --- 失败 chip 的真实错误类别（若本轮点了失败消息）---"
      grep -aE "TRANSLATE_FAILED|MANUAL_ROW_LOST|TRANSLATION_RENDER_TARGET_MISSING|MANUAL_CLIENT_EXCEPTION" "$TODAY" 2>/dev/null | tail -30 | sed 's/^/  /' || echo "  （本轮没有翻译失败记录）"

      echo
      echo "  --- 最近 20 行（看启动版本 / 报错）---"
      tail -20 "$TODAY" | sed 's/^/  /'
    fi
  fi

  echo
  echo "---- 6. 剪辑板自检（辅助：确认复制动作确实写入了剪辑板）----"
  echo "  （客户端**绝不**主动写剪辑板；这里只看当前剪辑板是否非空，供你对照手动复制结果）"
  echo "  剪辑板前 40 字: $(pbpaste 2>/dev/null | head -c 40 | tr '\n' ' ')"

  echo
  echo "---- 7. 网络出口 ----"
  echo "  本机直连出口: $(curl -s --max-time 8 https://api.ipify.org 2>/dev/null || echo '取不到')"
  echo "  到后端可达性: $(curl -s -o /dev/null -w '%{http_code} / %{time_total}s' --max-time 10 https://pixfanyi.com/apis/client/lines 2>/dev/null || echo '连不上')"

  echo
  echo "$(fill '=' 78)"
  echo " 采集结束 label=$LABEL"
  echo "$(fill '=' 78)"
} >> "$OUT" 2>&1

echo
echo "已追加到：$OUT"
echo "（把这个文件整个发我；它只读、不含口令）"
echo "提醒：复制/选中是浏览器内置行为，不产生应用日志 —— 本轮以肉眼验收为主，"
echo "      另有真 Electron 自动验收：在 desktop/ 下跑 npm run verify:copy（应 8/8）。"
echo "本地也可跑分诊：node scripts/rc-trace-triage.js $OUT"
