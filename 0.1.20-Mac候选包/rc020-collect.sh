#!/usr/bin/env bash
#
# 0.1.20 真机取证（macOS）—— 只读，不改任何东西。
#
# 本轮（「快、准、稳」第一阶段）要采三件事：
#   ① 发送正确性：正常发送 / 失败重试 / 连续发送，都不许出现原文抢发、占位符、重复发送
#   ② 发送耗时：用户按下发送 → 实际触发发送的 P50 / P95（脚本**当场算**给你看）
#   ③ 状态提示：翻译中 / 正在发送 / 已发送 是否及时切换与收口
#
# 用法（建议按顺序采，每采一次都会追加到同一个文件）：
#   bash rc020-collect.sh before              # 装完包、发消息之前
#   # 把实例通道切成 GPT，正常发 20 条中文
#   bash rc020-collect.sh after-gpt           # 采完会给 GPT 的 P50/P95
#   # 把实例通道切成 DeepSeek，正常发 20 条中文
#   bash rc020-collect.sh after-deepseek      # 采完会给 DeepSeek 的 P50/P95
#   # 制造一次翻译失败 → 点「重试翻译」
#   bash rc020-collect.sh after-retry
#   # 连续发 3 条不同的中文
#   bash rc020-collect.sh after-consecutive
#
# 产出：./rc020-evidence-<电脑名>.txt（多次调用**追加**，不覆盖）
#       把这个文件整个发回即可；它只读、不含口令。
#
# 安全：绝不打印口令。auth.json 只报用户名；proxyPass 一律不打印。
# ---------------------------------------------------------------------------
set -uo pipefail

LABEL="${1:-snapshot}"
APPDIR="$HOME/Library/Application Support/Hello Pix"
OUT="./rc020-evidence-$(scutil --get ComputerName 2>/dev/null || hostname -s).txt"

fill () { printf '%*s' "${2:-60}" '' | tr ' ' "${1:--}"; }
title () { echo; echo "$(fill '=' 78)"; echo " $*"; echo "$(fill '=' 78)"; }

{
  title "0.1.20 取证 · label=$LABEL"
  echo " 时间 : $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo " 主机 : $(scutil --get ComputerName 2>/dev/null || hostname)"
  echo " 系统 : $(sw_vers -productVersion 2>/dev/null) / $(uname -m)"

  echo
  echo "---- 1. 已安装版本（必须是 0.1.20）----"
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
    echo "---- 5. ★发送耗时★ SEND_PERF（真机埋点，非模拟）----"
    if [ -f "$TODAY" ]; then
      grep -aE "SEND_PERF" "$TODAY" 2>/dev/null | tail -200 | sed 's/^/  /' || echo "  （没有 SEND_PERF：这一版没走到埋点，请回传）"
      echo
      echo "  ★当场算 P50 / P95（按通道分组）★"
      python3 - "$TODAY" <<'PY' 2>&1 | sed 's/^/  /'
import json, re, sys, os
rows = []
try:
    with open(sys.argv[1], encoding='utf-8', errors='replace') as f:
        for line in f:
            if 'SEND_PERF' not in line:
                continue
            m = re.search(r'\[PIX_TRACE\]\s+SEND_PERF\s+(\{.*\})\s*$', line)
            if not m:
                continue
            try:
                rows.append(json.loads(m.group(1)))
            except Exception:
                pass
except FileNotFoundError:
    rows = []

if not rows:
    print('    (没有可统计的 SEND_PERF 样本)')
    sys.exit(0)

def pct(vals, p):
    v = sorted(x for x in vals if isinstance(x, (int, float)))
    if not v:
        return None
    if len(v) == 1:
        return round(v[0])
    idx = (len(v) - 1) * p
    lo, hi = int(idx), min(int(idx) + 1, len(v) - 1)
    return round(v[lo] + (v[hi] - v[lo]) * (idx - lo))

def stats(vals):
    v = sorted(x for x in vals if isinstance(x, (int, float)))
    if not v:
        return None
    return dict(n=len(v), p50=pct(v, .5), p95=pct(v, .95), max=v[-1], mean=round(sum(v) / len(v)))

STAGES = [('intercept','点击→拦截'), ('translate','翻译请求(API)'), ('handoff','API返回→原生输入'),
          ('nativeInput','原生输入→编辑器稳定'), ('validate','稳定→触发发送'),
          ('send','触发发送→发送确认'), ('uiClose','发送确认→提示关闭')]

groups = {}
for r in rows:
    k = (r.get('engine') or '').strip() or '未标注(实例未显式选通道)'
    groups.setdefault(k, []).append(r)

def report(name, items):
    print('    ── 通道：%s（n=%d）' % (name, len(items)))
    hdr = '       %-26s%7s%7s%7s%7s%6s' % ('阶段', 'P50', 'P95', 'mean', 'max', 'n')
    print(hdr)
    for key, label in STAGES:
        s = stats([(it.get('stages') or {}).get(key) for it in items])
        if not s:
            continue
        print('       %-26s%7d%7d%7d%7d%6d' % (label, s['p50'], s['p95'], s['mean'], s['max'], s['n']))
    t = stats([it.get('total') for it in items])
    trig = stats([(it.get('total') - it['stages']['send'] - it['stages']['uiClose'])
                  for it in items
                  if it.get('total') is not None and it.get('stages')
                  and it['stages'].get('send') is not None and it['stages'].get('uiClose') is not None])
    if trig:
        print('       %-26s%7d%7d%7d%7d%6d' % ('★按下发送→触发发送', trig['p50'], trig['p95'], trig['mean'], trig['max'], trig['n']))
    if t:
        print('       %-26s%7d%7d%7d%7d%6d' % ('★总计(点击→提示关闭)', t['p50'], t['p95'], t['mean'], t['max'], t['n']))
    oh = stats([(it.get('total') - it['stages']['translate'])
                for it in items
                if it.get('total') is not None and it.get('stages') and it['stages'].get('translate') is not None])
    if oh:
        print('       %-26s%7d%7d%7d%7d%6d' % ('客户端净开销(总−翻译)', oh['p50'], oh['p95'], oh['mean'], oh['max'], oh['n']))
    oc = {}
    for it in items:
        oc[it.get('outcome') or '(未标注)'] = oc.get(it.get('outcome') or '(未标注)', 0) + 1
    print('       结果分布：' + '  '.join('%s×%d' % (k, v) for k, v in oc.items()))

for name in sorted(groups):
    report(name, groups[name])
if len(groups) > 1:
    report('全部通道合计', rows)
PY
    else
      echo "  （今天还没有日志文件：$TODAY）"
    fi

    echo
    echo "---- 6. ★发送正确性★ 原生输入链 + 正文校验 ----"
    if [ -f "$TODAY" ]; then
      echo "  --- 原生输入链（顺序应是 BEGIN → CLEARED → INSERTED → LEXICAL_SETTLED）---"
      grep -aE "COMPOSER_STILL_SOURCE|NATIVE_INPUT_BEGIN|COMPOSER_CLEARED|NATIVE_TEXT_INSERTED|NATIVE_INPUT_FAILED|NATIVE_INPUT_RETRY|COMPOSER_LEFT_AS_IS" "$TODAY" 2>/dev/null | tail -60 | sed 's/^/  /' || echo "  （没有原生输入 trace）"
      echo "  --- 沉降（查看 ms / stable / canonicalEqual）---"
      grep -aE "LEXICAL_SETTLED" "$TODAY" 2>/dev/null | tail -40 | sed 's/^/  /' || echo "  （没有 LEXICAL_SETTLED）"
      echo "  --- 漂移采样（每一点都应是 equal:true）---"
      grep -aE "COMPOSER_DRIFT_SAMPLE" "$TODAY" 2>/dev/null | tail -30 | sed 's/^/  /' || echo "  （没有漂移采样）"
      echo "  --- 发送 / 拦下 / 失败原因（含真实错误码）---"
      grep -aE "INPUT_REPLACED|FINAL_TEXT_VALIDATED|SEND_BODY_MISMATCH_DETAIL|PROGRAMMATIC_SEND|SEND_FAIL_CLOSED|SEND_ABORTED_STALE|TRANSLATE_FAILED|USER_DRAFT_EDITED_ABORT|COMPOSER_LEFT_AS_IS" "$TODAY" 2>/dev/null | tail -80 | sed 's/^/  /' || echo "  （没有发送 trace）"
      echo "  --- 重试链 ---"
      grep -aE "RETRY_TRANSLATE_CLICK|RETRY_TRANSLATE_RESULT|RETRY_TRANSLATE_SKIPPED" "$TODAY" 2>/dev/null | tail -30 | sed 's/^/  /' || echo "  （没有重试 trace）"
      echo "  --- 翻译调用（服务端实际用的通道 / 来源）---"
      grep -aE "source_text=|\[translate\]|engine=" "$TODAY" 2>/dev/null | tail -40 | sed 's/^/  /' || echo "  （没有翻译调用记录）"
      echo "  --- 最近 20 行（看启动版本 / 报错）---"
      tail -20 "$TODAY" | sed 's/^/  /'
    fi
  fi

  echo
  echo "---- 7. 网络出口 ----"
  echo "  本机直连出口: $(curl -s --max-time 8 https://api.ipify.org 2>/dev/null || echo '取不到')"

  echo
  echo "$(fill '=' 78)"
  echo " 采集结束 label=$LABEL"
  echo "$(fill '=' 78)"
} >> "$OUT" 2>&1

echo
echo "已追加到：$OUT"
echo "（把这个文件整个发我；它只读、不含口令）"
echo "本地也可跑分诊：node scripts/rc-trace-triage.js $OUT"
echo "本地也可跑耗时统计：node scripts/rc-send-perf.js $OUT"
