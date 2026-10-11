#!/usr/bin/env bash
#
# 0.1.17 真机取证（macOS）—— 只读，不改任何东西。
#
# 用法（本轮只复测两件事，各采一次）：
#   bash rc017-collect.sh before
#   # 复测 1：点一条消息的「译」按钮 → 中文必须紧跟在那条消息下面
#   bash rc017-collect.sh after-B-01-manual-render
#   # 复测 2：制造一次翻译失败 → 点「重试翻译」→ 必须真正重发成功
#   bash rc017-collect.sh after-A-02-retry
#
# 产出：./rc017-evidence-<电脑名>.txt（多次调用**追加**，不覆盖）
#
# ---------------------------------------------------------------------------
# 本轮（0.1.17）针对 Mac 真机 FAIL 的两个 P0 新增了取证字段，采集里专门抽出：
#
#   P0-1 重试链（A）：
#     RETRY_TRANSLATE_CLICK     点下「重试翻译」的瞬间（带新 sendActionId）
#     RETRY_TRANSLATE_RESULT    重试收口：ok + **真实错误码**（不再是一句「重试失败」）
#     配套：TRANSLATE_STARTED / TRANSLATE_FAILED(code) / FINAL_TEXT_VALIDATED
#           / PROGRAMMATIC_SEND_BEGIN / PROGRAMMATIC_SEND_DONE
#
#   P0-2 渲染定位（B）：本轮把"到底把译文画到哪了"变成可判读的数据：
#     MANUAL_TRANSLATE_CLICK    点击时记录：真实 data-id、byPath、rowHasDataId
#     TARGET_RELOCATED          重定位后记录：rowId、byPath、textMatches、宿主标签/类名
#     TRANSLATION_RENDER_VERIFIED   绘制后复核通过（译文确实挂在原消息行内）
#     TRANSLATION_RENDER_UNVERIFIED 绘制后复核**没过** → 已丢弃，不许显示
#     TRANSLATION_RENDER_TARGET_MISSING 找不到精确原消息 → 宁可不显示，也不放底部
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
OUT="./rc017-evidence-$(scutil --get ComputerName 2>/dev/null || hostname -s).txt"

{
  echo "================================================================"
  echo " 0.1.17 取证 · label=$LABEL"
  echo " 时间 : $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo " 主机 : $(scutil --get ComputerName 2>/dev/null || hostname)"
  echo " 系统 : $(sw_vers -productVersion 2>/dev/null) / $(uname -m)"
  echo "================================================================"

  echo
  echo "---- 1. 已安装版本（必须是 0.1.17）----"
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
  if [ -f "$APPDIR/open-apps.json" ]; then
    python3 - "$APPDIR/open-apps.json" <<'PY' 2>&1 | sed 's/^/  /'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
for user, box in (d.get('byUser') or {}).items():
    print(f'  账号 {user}: activeId={box.get("activeId")} 实例数={len(box.get("tabs") or [])}')
    for t in (box.get('tabs') or []):
        s = t.get('settings') or {}
        print(f'    - id={t.get("id")} platform={t.get("platform")}')
        print(f'        groupMode={s.get("groupMode")!r} engine={s.get("engine")!r} '
              f'sendTo={s.get("sendTo")!r} recvFrom={s.get("recvFrom")!r}')
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
print('  passwordEnc=', '有（内容不打印）' if d.get('passwordEnc') else '无')
PY
  else
    echo "  （无 auth.json）"
  fi

  echo
  echo "---- 5. ★第一证据★ 客户端日志 ----"
  echo "  判读重点："
  echo "    · [preload] … 翻译桥已就绪   → ✅ 桥真的跑起来了（没有这行 = 立刻停止并回传）"
  echo "    · [PIX_TRACE] RETRY_TRANSLATE_CLICK / RETRY_TRANSLATE_RESULT  → 重试链（P0-1）"
  echo "    · [PIX_TRACE] TARGET_RELOCATED / TRANSLATION_RENDER_VERIFIED / _UNVERIFIED / _TARGET_MISSING → 渲染定位（P0-2）"
  LOGDIR="$APPDIR/logs"
  if [ -d "$LOGDIR" ]; then
    TODAY="$LOGDIR/hello-pix-$(date '+%Y-%m-%d').log"
    if [ -f "$TODAY" ]; then
      echo "  --- 桥健康 ---"
      grep -aE "\[preload\]|\[guest\]|翻译桥" "$TODAY" 2>/dev/null | sed 's/^/  /' || echo "  （没有 preload / guest 记录）"
      if [ "$LABEL" = "before" ]; then
        echo "  （before：只记行数，不贴内容）"
        echo "  今日日志行数: $(wc -l < "$TODAY")"
      else
        echo "  --- P0-1 重试链（最关键的证据）---"
        grep -aE "RETRY_TRANSLATE_CLICK|RETRY_TRANSLATE_RESULT|RETRY_TRANSLATE_SKIPPED" "$TODAY" 2>/dev/null | tail -40 | sed 's/^/  /' || echo "  （没有重试链 trace：这一步没走到）"
        echo "  --- P0-2 渲染定位（真实 data-id / selector / 命中节点 / 父节点）---"
        grep -aE "MANUAL_CHIP_RENDERED|MANUAL_TRANSLATE_CLICK|SOURCE_EXTRACTED|TARGET_RELOCATED|TRANSLATION_RENDER" "$TODAY" 2>/dev/null | tail -60 | sed 's/^/  /' || echo "  （没有渲染链 trace）"
        echo "  --- 发送链（含失败码）---"
        grep -aE "SEND_|TRANSLATE_|INPUT_|DRAFT_|PROGRAMMATIC_|SOURCE_SNAPSHOTTED|FINAL_TEXT_VALIDATED" "$TODAY" 2>/dev/null | tail -60 | sed 's/^/  /' || echo "  （没有发送链 trace）"
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
  echo "---- 6. 网络出口 ----"
  echo "  本机直连出口: $(curl -s --max-time 8 https://api.ipify.org 2>/dev/null || echo '取不到')"

  echo
  echo "=================== 采集结束 label=$LABEL ==================="
} >> "$OUT" 2>&1

echo "已追加到：$OUT"
echo "（把这个文件整个发我；它只读、不含口令）"
echo "本地分诊：node scripts/rc-trace-triage.js $OUT"
