#!/usr/bin/env bash
#
# 0.1.27 真机取证（macOS）—— 只读，不改任何东西。
#
# 本轮修的是**功能缺陷**（用户报）：「译文没办法复制粘贴」。
#   真机现象（0.1.26）：聊天窗口里的中文译文看得见、却选不中，复制更是没反应。
#   根因（两层，缺一不可）：
#     · 第 1 层（guest-inject.js）：译文框是宿主气泡的后代，宿主在气泡容器上打
#       user-select: none；Chromium 在 user-select:none 的子树里**拒绝建立任何选区**。
#       `.pix-trans` 缺 !important，压不过宿主 → 选都选不中。
#     · 第 2 层（main.js）：聊天应用在 WebContentsView 里，Electron **不会**把
#       Cmd+C/V/A 自动作用到嵌入 webContents；应用隐藏菜单栏、从未注册编辑角色，
#       WebContentsView 又默认不弹右键菜单 → 三条通道全缺 → 选中了也复制不出来。
#   修法：CSS 抢回选中权（两层前缀 + !important）+ 每个 view 的 before-input-event
#         与右键菜单 + macOS 应用菜单编辑角色。
#
# 本轮要采的四件事：
#   ① ★核心★ 译文能拖动选中（肉眼 + 截图）
#   ② ★核心★ 选中后 Cmd+C 能复制、粘到别处 = 译文
#   ③ ★核心★ Cmd+A / 右键「复制」也能用
#   ④ ★护栏★ 翻译主干没被碰坏：私聊自动翻 / 手动「译」/ 发送翻译仍正常
#
# 说明：复制/选中是**浏览器内置行为**，不产生应用日志。所以本轮以肉眼验收为主，
#       再加真 Electron 自动验收（desktop 下 npm run verify:copy，8/8）。
#       本脚本采的是"主干没坏"的证据 + 环境与版本 + 网络出口。
#
# 用法（建议按顺序采，每采一次都会追加到同一个文件）：
#   bash rc027-collect.sh before
#   # ★本轮重点一★ 让译文显示出来，用鼠标拖动选中译文
#   bash rc027-collect.sh after-select
#   # ★本轮重点二★ 选中后 Cmd+C，粘到备忘录确认 = 译文
#   bash rc027-collect.sh after-copy-paste
#   # ★本轮重点三★ Cmd+A 与右键「复制」各做一次
#   bash rc027-collect.sh after-selectall-contextmenu
#   # 护栏：私聊自动翻译一条
#   bash rc027-collect.sh after-private-auto
#   # 护栏：发送翻译一条中文，对方收到英文
#   bash rc027-collect.sh after-send
#   # 护栏：群聊手动点「译」
#   bash rc027-collect.sh after-manual-chip
#
# 产出：./rc027-evidence-<电脑名>.txt（多次调用**追加**，不覆盖）
#       把这个文件整个发回即可；它只读、不含口令。
#
# 安全：绝不打印口令。auth.json 只报用户名；proxyPass 一律不打印。
# ---------------------------------------------------------------------------
set -uo pipefail

LABEL="${1:-snapshot}"
APPDIR="$HOME/Library/Application Support/Hello Pix"
OUT="./rc027-evidence-$(scutil --get ComputerName 2>/dev/null || hostname -s).txt"

fill () { printf '%*s' "${2:-60}" '' | tr ' ' "${1:--}"; }
title () { echo; echo "$(fill '=' 78)"; echo " $*"; echo "$(fill '=' 78)"; }

{
  title "0.1.27 取证 · label=$LABEL"
  echo " 时间 : $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo " 主机 : $(scutil --get ComputerName 2>/dev/null || hostname)"
  echo " 系统 : $(sw_vers -productVersion 2>/dev/null) / $(uname -m)"

  echo
  echo "---- 1. 已安装版本（必须是 0.1.27）----"
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
