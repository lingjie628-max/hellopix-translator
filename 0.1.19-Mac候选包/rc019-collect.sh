#!/usr/bin/env bash
#
# 0.1.19 真机取证（macOS）—— 只读，不改任何东西。
#
# 用法（本轮只复测一件事：发送翻译的写入方式）：
#   bash rc019-collect.sh before
#   # 复测：正常发一条中文（对方应收到英文译文）
#   bash rc019-collect.sh after-send
#   # 制造一次翻译失败 → 点「重试翻译」→ 必须真正重发成功
#   bash rc019-collect.sh after-retry
#
# 产出：./rc019-evidence-<电脑名>.txt（多次调用**追加**，不覆盖）
#
# ---------------------------------------------------------------------------
# 本轮（0.1.19）针对 Mac 真机 0.1.18 的 BODY_MISMATCH 换了整条写入链路，
# 采集里专门抽出「Chromium 原生输入」这条链：
#
#   COMPOSER_STILL_SOURCE        写入前确认框里还是本次原文（没被用户改过）
#   NATIVE_INPUT_BEGIN           原生输入开始（expected 的 len/hash/canonicalLen）
#   COMPOSER_CLEARED             ★ 原生 selectAll + delete 生效
#   NATIVE_TEXT_INSERTED         ★ insertText 生效，回读 hash == 译文 hash
#   COMPOSER_DRIFT_SAMPLE        0/100/300/500ms 逐点回读（每点都应 equal:true）
#   LEXICAL_SETTLED              ★ 沉降完成且 stable / canonicalEqual
#   INPUT_REPLACED               正文写入成功
#   FINAL_TEXT_VALIDATED         发送前最后一道正文校验（ok:true 才算过）
#   SEND_BODY_MISMATCH_DETAIL    ★ 若出现：预期/实际 len·hash、首个差异位、
#                                canonical 前后、写入方式、input 事件
#   COMPOSER_LEFT_AS_IS          ℹ️ 你已改草稿 → 主动放弃覆盖（正确行为）
#   PROGRAMMATIC_SEND_BEGIN/_DONE 程序化发送开始/结束（只应各一次）
#   RETRY_TRANSLATE_CLICK/_RESULT 重试收口 + **真实错误码**
#
#   P0-2 / P0-3 回归确认（这两项已 PASS，本轮冻结，只确认没被破坏）：
#     TARGET_RELOCATED / TRANSLATION_RENDER_VERIFIED   → 译文仍绑定原消息
#     MANUAL_CHIP_RENDERED 的 inActionRow:true         → 入口仍住进操作行
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
OUT="./rc019-evidence-$(scutil --get ComputerName 2>/dev/null || hostname -s).txt"

{
  echo "================================================================"
  echo " 0.1.19 取证 · label=$LABEL"
  echo " 时间 : $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo " 主机 : $(scutil --get ComputerName 2>/dev/null || hostname)"
  echo " 系统 : $(sw_vers -productVersion 2>/dev/null) / $(uname -m)"
  echo "================================================================"

  echo
  echo "---- 1. 已安装版本（必须是 0.1.19）----"
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
  echo "---- 3. auth.json（只报用户名，绝不打印口令）----"
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
  echo "---- 4. ★第一证据★ 客户端日志 ----"
  echo "  判读重点："
  echo "    · [preload] … 翻译桥已就绪   → ✅ 桥真的跑起来了（没有这行 = 立刻停止并回传）"
  echo "    · NATIVE_INPUT_BEGIN → COMPOSER_CLEARED → NATIVE_TEXT_INSERTED"
  echo "      → COMPOSER_DRIFT_SAMPLE×4 → LEXICAL_SETTLED → FINAL_TEXT_VALIDATED(ok:true)"
  echo "      → PROGRAMMATIC_SEND_DONE   → 这条顺序完整 = 原生输入链真的走通了"
  echo "    · COMPOSER_DRIFT_SAMPLE 每一点都应 equal:true（出现 false = 仍然漂移，立刻回传）"
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
        echo "  --- ★原生输入链（本轮唯一命门）---"
        grep -aE "COMPOSER_STILL_SOURCE|NATIVE_INPUT_BEGIN|COMPOSER_CLEARED|NATIVE_TEXT_INSERTED|COMPOSER_DRIFT_SAMPLE|LEXICAL_SETTLED|COMPOSER_LEFT_AS_IS" "$TODAY" 2>/dev/null | tail -80 | sed 's/^/  /' || echo "  （没有原生输入 trace：这一步没走到）"
        echo "  --- 正文校验 / 发送（含失败码）---"
        grep -aE "INPUT_REPLACED|FINAL_TEXT_VALIDATED|SEND_BODY_MISMATCH_DETAIL|PROGRAMMATIC_SEND|SEND_FAIL_CLOSED|TRANSLATE_FAILED|NATIVE_SET_COMPOSER" "$TODAY" 2>/dev/null | tail -60 | sed 's/^/  /' || echo "  （没有正文校验 trace）"
        echo "  --- 重试链 ---"
        grep -aE "RETRY_TRANSLATE_CLICK|RETRY_TRANSLATE_RESULT|RETRY_TRANSLATE_SKIPPED" "$TODAY" 2>/dev/null | tail -30 | sed 's/^/  /' || echo "  （没有重试链 trace）"
        echo "  --- P0-2 / P0-3 回归确认（应仍是 VERIFIED / inActionRow:true）---"
        grep -aE "MANUAL_CHIP_RENDERED|MANUAL_TRANSLATE_CLICK|SOURCE_EXTRACTED|TARGET_RELOCATED|TRANSLATION_RENDER" "$TODAY" 2>/dev/null | tail -40 | sed 's/^/  /' || echo "  （没有渲染链 trace）"
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
  echo "---- 5. 网络出口 ----"
  echo "  本机直连出口: $(curl -s --max-time 8 https://api.ipify.org 2>/dev/null || echo '取不到')"

  echo
  echo "=================== 采集结束 label=$LABEL ==================="
} >> "$OUT" 2>&1

echo "已追加到：$OUT"
echo "（把这个文件整个发我；它只读、不含口令）"
echo "本地分诊：node scripts/rc-trace-triage.js $OUT"
