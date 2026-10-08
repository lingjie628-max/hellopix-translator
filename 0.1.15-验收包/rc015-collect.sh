#!/usr/bin/env bash
#
# 0.1.15 真机取证（macOS / Windows-WSL 外部记录）—— 只读，不改任何东西。
#
# 用法：
#   bash rc015-collect.sh before
#   # ...做一步验收操作（点一次「译」/ 发一条消息）...
#   bash rc015-collect.sh after-A01-manual-click
#   bash rc015-collect.sh after-B01-send-translate
#
# 产出：./rc015-evidence-<电脑名>.txt（多次调用**追加**，不覆盖）
#
# ---------------------------------------------------------------------------
# 为什么 0.1.15 的取证和以前不一样
#
# 前几轮 P0 的共性是「界面看起来正常，事情没发生」——
#   · 0.1.12：界面显示"发送翻译已开启"，拦截器其实根本没挂上；
#   · 0.1.14：消息下面明明有「译」按钮，点下去什么都不发生（按钮随后消失）。
# 光看界面**永远看不出这类问题**。所以这一版把两条链各自的**结构化 trace**
# 当作第一证据抓回来，界面截图只作辅助。
#
# 抓三样**界面之外**的东西：
#   ① 装的是不是真的 0.1.15（不是 0.1.13 / 0.1.14）
#   ② 翻译桥有没有真的装起来（有"翻译桥已就绪"才是好的）
#   ③ 两条链的 [PIX_TRACE] 时间线：
#        链 A（点「译」）：MANUAL_TRANSLATE_CLICK → MANUAL_PARSED →
#                          MANUAL_REQUEST → MANUAL_RESPONSE → MANUAL_RENDERED
#        链 B（发消息）  ：SEND_CAPTURED → NATIVE_SEND_BLOCKED → SOURCE_SNAPSHOTTED →
#                          TRANSLATE_STARTED → TRANSLATE_SUCCEEDED →
#                          INPUT_REPLACED → PROGRAMMATIC_SEND_BEGIN → PROGRAMMATIC_SEND_DONE
#   失败分支会直接告诉断在哪一步：MANUAL_ROW_LOST / MESSAGE_TEXT_EXTRACTION_FAILED /
#   MANUAL_RENDER_MISSED / MANUAL_FAILED / TRANSLATE_FAILED / SEND_BLOCKED_* /
#   DRAFT_PRESERVED / DRAFT_RESTORED / DRAFT_RESTORE_FAILED。
#
# 采集完可以直接跑分诊（本地仓库里）：
#   node scripts/rc-trace-triage.js <这个文件>
#
# 安全：绝不打印口令。auth.json 只报用户名；proxyPass 一律 [redacted]。
# ---------------------------------------------------------------------------
#
set -uo pipefail

LABEL="${1:-snapshot}"
APPDIR="$HOME/Library/Application Support/Hello Pix"
OUT="./rc015-evidence-$(scutil --get ComputerName 2>/dev/null || hostname -s).txt"

{
  echo "================================================================"
  echo " 0.1.15 取证 · label=$LABEL"
  echo " 时间 : $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo " 主机 : $(scutil --get ComputerName 2>/dev/null || hostname)"
  echo " 系统 : $(sw_vers -productVersion 2>/dev/null) / $(uname -m)"
  echo "================================================================"

  echo
  echo "---- 1. 已安装版本（必须是 0.1.15）----"
  for app in "/Applications/Hello Pix.app" "$HOME/Applications/Hello Pix.app"; do
    if [ -d "$app" ]; then
      echo "  $app"
      echo "    版本: $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || echo '读不到')"
    fi
  done

  echo
  echo "---- 2. 进程（看开了几个副本 + 运行时版本）----"
  ps -Ao pid,etime,command 2>/dev/null | grep -i "Hello Pix" | grep -v grep | sed 's/^/  /' || echo "  （没有在跑）"

  echo
  echo "---- 3. open-apps.json：磁盘上的真实设置 ----"
  echo "  判读重点：sendFrom / sendTo / engine 必须与界面一致（界面显示开了、这里没有 = 设置没落盘）"
  if [ -f "$APPDIR/open-apps.json" ]; then
    python3 - "$APPDIR/open-apps.json" <<'PY' 2>&1 | sed 's/^/  /'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
for user, box in (d.get('byUser') or {}).items():
    print(f'  账号 {user}: activeId={box.get("activeId")} 实例数={len(box.get("tabs") or [])}')
    for t in (box.get('tabs') or []):
        s = t.get('settings') or {}
        print(f'    - id={t.get("id")} platform={t.get("platform")}')
        print(f'        groupMode={s.get("groupMode")!r} engine={s.get("engine")!r}')
        print(f'        sendFrom={s.get("sendFrom")!r} sendTo={s.get("sendTo")!r} '
              f'recvFrom={s.get("recvFrom")!r} recvTo={s.get("recvTo")!r}')
        print(f'        showTransBar={s.get("showTransBar")!r} transBarSilent={s.get("transBarSilent")!r}')
        if s.get('proxyPass'):
            print('        proxyPass=[redacted]')
PY
  else
    echo "  （还没有 open-apps.json：没建过实例）"
  fi

  echo
  echo "---- 4. auth.json（只报用户名，绝不打印口令）----"
  if [ -f "$APPDIR/auth.json" ]; then
    python3 - "$APPDIR/auth.json" <<'PY' 2>&1 | sed 's/^/  /'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
print('  username   =', d.get('username'))
print('  remember   =', d.get('remember'))
print('  autoLogin  =', d.get('autoLogin'))
print('  passwordEnc=', '有（内容不打印）' if d.get('passwordEnc') else '无')
PY
  else
    echo "  （无 auth.json）"
  fi

  echo
  echo "---- 5. 多开槽位 ----"
  if [ -d "$APPDIR/Partitions" ]; then
    ls -1 "$APPDIR/Partitions" 2>/dev/null | sed 's/^/  /' | head -30
  else
    echo "  （无 Partitions 目录）"
  fi

  echo
  echo "---- 6. ★第一证据★ 客户端日志 ----"
  echo "  判读重点："
  echo "    · [preload] … 翻译桥已就绪   → ✅ 预加载脚本真的跑起来了（没有这行 = 立刻停止并回传）"
  echo "    · [preload] … 翻译桥未启动   → ❌ 桥没起来，同类装载问题复现，直接回传"
  echo "    · [PIX_TRACE] MANUAL_*       → 链 A（点「译」）时间线"
  echo "    · [PIX_TRACE] SEND_*         → 链 B（发消息）时间线"
  LOGDIR="$APPDIR/logs"
  if [ -d "$LOGDIR" ]; then
    TODAY="$LOGDIR/hello-pix-$(date '+%Y-%m-%d').log"
    if [ -f "$TODAY" ]; then
      echo "  --- 桥健康相关 ---"
      grep -aE "\[preload\]|\[guest\]|翻译桥" "$TODAY" 2>/dev/null | sed 's/^/  /' || echo "  （没有 preload / guest 记录）"
      if [ "$LABEL" = "before" ]; then
        echo "  （before：只记行数，不贴内容）"
        echo "  今日日志行数: $(wc -l < "$TODAY")"
      else
        echo "  --- 链 A（manual_click）trace：MANUAL_* ---"
        grep -a "MANUAL_" "$TODAY" 2>/dev/null | tail -60 | sed 's/^/  /' || echo "  （没有 MANUAL_ trace）"
        echo "  --- 链 B（manual_send）trace：SEND_ / TRANSLATE_ / INPUT_ / DRAFT_ / PROGRAMMATIC_ ---"
        grep -aE "SEND_|TRANSLATE_|INPUT_|DRAFT_|PROGRAMMATIC_|SOURCE_SNAPSHOTTED" "$TODAY" 2>/dev/null | tail -80 | sed 's/^/  /' || echo "  （没有发送链 trace）"
        echo "  --- 最近 25 行（看启动版本 / 报错）---"
        tail -25 "$TODAY" | sed 's/^/  /'
      fi
    else
      echo "  （今天还没有日志文件：$TODAY）"
    fi
    echo "  日志文件列表:"
    ls -1 "$LOGDIR" | sed 's/^/    /'
  else
    echo "  （无 logs 目录）"
  fi

  echo
  echo "---- 7. 网络出口 ----"
  echo "  本机直连出口: $(curl -s --max-time 8 https://api.ipify.org 2>/dev/null || echo '取不到')"

  echo
  echo "=================== 采集结束 label=$LABEL ==================="
} >> "$OUT" 2>&1

echo "已追加到：$OUT"
echo "（把这个文件整个发我；它只读、不含口令）"
echo "本地分诊：node scripts/rc-trace-triage.js $OUT"
