#!/usr/bin/env bash
#
# 0.1.14 真机取证（macOS）—— 只读，不改任何东西。
#
# 用法：
#   bash rc014-collect.sh before
#   # ...做一步验收操作...
#   bash rc014-collect.sh after-01-cn2en
#
# 产出：./rc014-evidence-<电脑名>.txt（多次调用会**追加**，不是覆盖）
#
# 为什么要有它：
#   这次 P0 的本质是「界面一切正常，原文已经发出去了」。光看界面**看不出任何东西** ——
#   0.1.12 上界面显示"发送翻译已开启"，而拦截器根本没挂上。
#   所以必须把三样**界面之外**的证据一起抓回来：
#     ① 装的是哪个版本（是不是真的 0.1.14）
#     ② 预加载脚本**到底有没有装起来**（有 live 就是好的，日志里会出现"翻译桥已就绪"）
#     ③ 实际发出去的翻译请求（有没有 manual_send、source_text 是什么）
#
# 安全：绝不打印口令。auth.json 只报「有没有 / 用户名」，
#       proxyPass 一律替换成 [redacted]。日志本身不含凭据（已核对）。
#
set -uo pipefail

LABEL="${1:-snapshot}"
APPDIR="$HOME/Library/Application Support/Hello Pix"
OUT="./rc014-evidence-$(scutil --get ComputerName 2>/dev/null || hostname -s).txt"

{
  echo "================================================================"
  echo " 0.1.14 取证 · label=$LABEL"
  echo " 时间 : $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo " 主机 : $(scutil --get ComputerName 2>/dev/null || hostname)"
  echo " 系统 : $(sw_vers -productVersion 2>/dev/null) / $(uname -m)"
  echo "================================================================"

  echo
  echo "---- 1. 已安装版本（必须是 0.1.14，不是 0.1.12/0.1.13）----"
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
  echo "  ⚠️ 判读重点（发送翻译 P0 相关）："
  echo "     · 每个 WhatsApp 实例都要有 sendFrom / sendTo / engine"
  echo "     · 界面显示「发送翻译已开」而这里没有对应字段 = 设置没写进去"
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
  echo "---- 5. 多开槽位（两个实例应各有独立分区目录）----"
  if [ -d "$APPDIR/Partitions" ]; then
    ls -1 "$APPDIR/Partitions" 2>/dev/null | sed 's/^/  /' | head -30
  else
    echo "  （无 Partitions 目录）"
  fi

  echo
  echo "---- 6. ★关键★ 客户端日志：翻译桥是否装起来了 ----"
  echo "  判读重点："
  echo "    · [preload] … 翻译桥已就绪     → ✅ 预加载脚本真的跑起来了（0.1.12 上不会有这行）"
  echo "    · [preload] … 翻译桥未启动     → ❌ 立刻停止验收并回传！同类问题复现了"
  echo "    · [preload] … 装载失败         → ❌ 同上，后面会带具体原因"
  echo "    · [guest] …                    → guest 页面报错（含拦截器内部异常）"
  LOGDIR="$APPDIR/logs"
  if [ -d "$LOGDIR" ]; then
    TODAY="$LOGDIR/hello-pix-$(date '+%Y-%m-%d').log"
    if [ -f "$TODAY" ]; then
      echo "  --- 桥健康相关（全部）---"
      grep -aE "\[preload\]|\[guest\]|翻译桥" "$TODAY" 2>/dev/null | sed 's/^/  /' || echo "  （没有 preload / guest 记录）"
      if [ "$LABEL" = "before" ]; then
        echo "  （before：只记行数，不贴内容）"
        echo "  今日日志行数: $(wc -l < "$TODAY")"
      else
        echo "  --- translate 记录（最多 80 条）---"
        grep -a "translate" "$TODAY" 2>/dev/null | tail -80 | sed 's/^/  /'
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
