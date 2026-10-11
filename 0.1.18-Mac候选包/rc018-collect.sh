#!/usr/bin/env bash
#
# 0.1.18 真机取证（macOS）—— 只读，不改任何东西。
#
# 用法（本轮只复测两件事，各采一次）：
#   bash rc018-collect.sh before
#   # 复测 2（先做）：短消息的「译」按钮是否始终可见可点（不依赖服务端）
#   bash rc018-collect.sh after-B-03-short-chip
#   # 复测 1：制造一次翻译失败 → 点「重试翻译」→ 必须真正重发成功
#   bash rc018-collect.sh after-A-01-retry
#
# 产出：./rc018-evidence-<电脑名>.txt（多次调用**追加**，不覆盖）
#
# ---------------------------------------------------------------------------
# 本轮（0.1.18）针对 Mac 真机 FAIL 的两个 P0 新增了取证字段，采集里专门抽出：
#
#   P0-1 发送翻译重试（BODY_MISMATCH）：
#     RETRY_TRANSLATE_CLICK          点下「重试翻译」的瞬间（带新 sendActionId）
#     INPUT_REPLACED                 译文写入输入框成功
#     INPUT_REWRITTEN                ★ 正文被页面还原后**就地重写**（0.1.18 新动作）
#     FINAL_TEXT_VALIDATED           发送前最后一道正文校验（ok:true 才算过）
#     SEND_BODY_MISMATCH_DETAIL      ★ 若出现：预期/实际长度·hash、首个差异位、
#                                    canonical 前后文本、写入方式、input/beforeinput 是否触发
#     PROGRAMMATIC_SEND_BEGIN/_DONE  程序化发送开始/结束（只应各一次）
#     RETRY_TRANSLATE_RESULT         重试收口 + **真实错误码**
#
#   P0-3 入口被 metadata 遮挡：
#     MANUAL_CHIP_RENDERED           看 inActionRow 字段：
#                                      true  → ✅ 入口住进了 .pix-trans-action-row（正常文档流）
#                                      false → ❌ 还在贴正文尾部（会被时间/勾盖住）
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
OUT="./rc018-evidence-$(scutil --get ComputerName 2>/dev/null || hostname -s).txt"

{
  echo "================================================================"
  echo " 0.1.18 取证 · label=$LABEL"
  echo " 时间 : $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo " 主机 : $(scutil --get ComputerName 2>/dev/null || hostname)"
  echo " 系统 : $(sw_vers -productVersion 2>/dev/null) / $(uname -m)"
  echo "================================================================"

  echo
  echo "---- 1. 已安装版本（必须是 0.1.18）----"
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
  echo "    · [PIX_TRACE] MANUAL_CHIP_RENDERED 的 inActionRow → P0-3（入口是否住进操作行）"
  echo "    · [PIX_TRACE] INPUT_REWRITTEN / FINAL_TEXT_VALIDATED / SEND_BODY_MISMATCH_DETAIL → P0-1"
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
        echo "  --- P0-3 入口布局（inActionRow 是关键字段）---"
        grep -aE "MANUAL_CHIP_RENDERED" "$TODAY" 2>/dev/null | tail -40 | sed 's/^/  /' || echo "  （没有 MANUAL_CHIP_RENDERED：这一步没走到）"
        echo "  --- P0-1 重试链（最关键的证据）---"
        grep -aE "RETRY_TRANSLATE_CLICK|RETRY_TRANSLATE_RESULT|RETRY_TRANSLATE_SKIPPED" "$TODAY" 2>/dev/null | tail -40 | sed 's/^/  /' || echo "  （没有重试链 trace：这一步没走到）"
        echo "  --- P0-1 正文写入 / 校验 / 自愈 / 取证 ---"
        grep -aE "INPUT_REPLACED|INPUT_REWRITTEN|FINAL_TEXT_VALIDATED|SEND_BODY_MISMATCH_DETAIL" "$TODAY" 2>/dev/null | tail -60 | sed 's/^/  /' || echo "  （没有正文校验 trace）"
        echo "  --- 发送链（含失败码）---"
        grep -aE "SEND_|TRANSLATE_|DRAFT_|PROGRAMMATIC_|SOURCE_SNAPSHOTTED" "$TODAY" 2>/dev/null | tail -60 | sed 's/^/  /' || echo "  （没有发送链 trace）"
        echo "  --- 渲染定位（P0-2 回归确认：必须仍然是 VERIFIED）---"
        grep -aE "MANUAL_TRANSLATE_CLICK|SOURCE_EXTRACTED|TARGET_RELOCATED|TRANSLATION_RENDER" "$TODAY" 2>/dev/null | tail -40 | sed 's/^/  /' || echo "  （没有渲染链 trace）"
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
