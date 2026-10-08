#!/usr/bin/env bash
#
# 0.1.12 真机取证（macOS）—— 只读，不改任何东西。
#
# 用法：
#   bash rc012-collect.sh before
#   # ...做一步验收操作...
#   bash rc012-collect.sh after-auto
#
# 产出：./rc012-evidence-<电脑名>.txt（多次调用会**追加**，不是覆盖）
#
# 为什么要有它：
#   0.1.11 的四个断点里有三个在客户端本地状态（groupMode 有没有真写进去、
#   重启后还在不在、多开有没有互相覆盖）。光看界面看不出来 ——
#   界面显示「自动」而磁盘上存的是 manual，正是本次要杜绝的那种"假成功"。
#   所以本脚本把**磁盘上的真实值**和**客户端日志里的真实请求**一起抓出来。
#
# 安全：绝不打印口令。auth.json 只报「有没有 / 用户名」，
#       proxyPass 一律替换成 [redacted]。日志本身不含凭据（已核对）。
#
set -uo pipefail

LABEL="${1:-snapshot}"
APPDIR="$HOME/Library/Application Support/Hello Pix"
OUT="./rc012-evidence-$(scutil --get ComputerName 2>/dev/null || hostname -s).txt"

{
  echo "================================================================"
  echo " 0.1.12 取证 · label=$LABEL"
  echo " 时间 : $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo " 主机 : $(scutil --get ComputerName 2>/dev/null || hostname)"
  echo " 系统 : $(sw_vers -productVersion 2>/dev/null) / $(uname -m)"
  echo "================================================================"

  echo
  echo "---- 1. 已安装版本（先确认装的是 0.1.12，不是 0.1.11）----"
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
  echo "  ⚠️ 判读重点：每个实例的 settings.groupMode 必须是 auto / manual / inherit 之一。"
  echo "     界面显示「自动」而这里是 \"manual\" = 设置根本没写进去（本次要杜绝的假成功）。"
  if [ -f "$APPDIR/open-apps.json" ]; then
    python3 - "$APPDIR/open-apps.json" <<'PY' 2>&1 | sed 's/^/  /'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
for user, box in (d.get('byUser') or {}).items():
    print(f'  账号 {user}: nextTab={box.get("nextTab")} activeId={box.get("activeId")} 实例数={len(box.get("tabs") or [])}')
    for t in (box.get('tabs') or []):
        s = t.get('settings') or {}
        print(f'    - id={t.get("id")} platform={t.get("platform")} '
              f'groupMode={s.get("groupMode")!r} engine={s.get("engine")!r} '
              f'showTransBar={s.get("showTransBar")!r} recv/send={s.get("recvTo")}/{s.get("sendTo")}')
        if s.get('proxyPass'):
            print('      proxyPass=[redacted]')
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
  echo "---- 5. 多开槽位（两个实例应各有独立分区目录）----"
  if [ -d "$APPDIR/Partitions" ]; then
    ls -1 "$APPDIR/Partitions" 2>/dev/null | sed 's/^/  /' | head -30
  else
    echo "  （无 Partitions 目录）"
  fi

  echo
  echo "---- 6. 客户端日志：实际发出去的翻译请求 ----"
  echo "  判读重点："
  echo "    · trigger=auto_receive  —— 群聊自动翻译真的触发了（0.1.11 这里永远是 '-'）"
  echo "    · engine=gpt / deepseek —— 实际用的通道，必须与界面显示的一致"
  echo "    · source_text 里不能有时间戳 / 已读 / UI 文案"
  LOGDIR="$APPDIR/logs"
  if [ -d "$LOGDIR" ]; then
    TODAY="$LOGDIR/hello-pix-$(date '+%Y-%m-%d').log"
    if [ -f "$TODAY" ]; then
      if [ "$LABEL" = "before" ]; then
        echo "  （before：只记行数，不贴内容）"
        echo "  今日日志行数: $(wc -l < "$TODAY")"
      else
        echo "  --- $TODAY 里的 translate 记录（最多 60 条）---"
        grep -a "translate" "$TODAY" 2>/dev/null | tail -60 | sed 's/^/  /'
        echo "  --- 最近 20 行（看启动版本 / 报错）---"
        tail -20 "$TODAY" | sed 's/^/  /'
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
  echo "---- 7. 网络出口（代理验收用）----"
  echo "  本机直连出口: $(curl -s --max-time 8 https://api.ipify.org 2>/dev/null || echo '取不到')"
  if [ -f "$APPDIR/proxy-presets.json" ]; then
    echo "  有 proxy-presets.json（内容不打印）"
  fi

  echo
  echo "=================== 采集结束 label=$LABEL ==================="
} >> "$OUT" 2>&1

echo "已追加到：$OUT"
echo "（把这个文件整个发我；它只读、不含口令）"
