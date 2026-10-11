#!/usr/bin/env bash
#
# 0.1.24 真机取证（macOS）—— 只读，不改任何东西。
#
# 本轮修的是「会话类型判据」—— 0.1.23 真机日志暴露的 P0：
#   私聊里也必须手点「译」，auto_receive 全天只有 1 次。
#   根因（真机 DOM 探针实测）：
#     `[data-testid*="group" i]` 扫的是**整个 #main**，而 #main 里装着**消息**；
#     一条 WhatsApp 群邀请链接会渲染出 `group-invite-link-action` 按钮
#     → 判据恒为真 → **只要会话里有群邀请链接，私聊就被判成群**
#     → 自动翻译被整个关掉、只剩手动「译」。
#   修法：会话类型**只从会话头部读**，消息区一律不参与；并新增"头部副标题是
#   成员名单 → 群"判据（群=成员名单 / 私聊=在线状态）。
#
# 本轮要采的三件事：
#   ① ★核心★ 私聊是否真的自动翻译 —— auto_receive 必须成为主力
#   ② ★核心★ 群聊是否仍守「手动」—— 打开群聊不许自动翻历史（计费保护）
#   ③ ★判据验证★ CHAT_KIND 会记**头部证据的形状**（词长 / 标点骨架，不含人名）：
#        请**分别**在一个私聊和一个真群里各停几秒，让 CHAT_KIND 各打一条。
#
# 上一轮（0.1.23 失败 chip 按类别说话）与更早的传输层/发送正确性取证项全部保留：
#   传送正确性 / 发送耗时 P50,P95 / 状态提示 / 传输层分类 / 失败 chip 真实类别
#
# 用法（建议按顺序采，每采一次都会追加到同一个文件）：
#   bash rc024-collect.sh before              # 装完包、发消息之前
#   # 把实例通道切成 GPT，正常发 20 条中文
#   bash rc024-collect.sh after-gpt           # 采完会给 GPT 的 P50/P95
#   # 把实例通道切成 DeepSeek，正常发 20 条中文
#   bash rc024-collect.sh after-deepseek      # 采完会给 DeepSeek 的 P50/P95
#   # 断网 / 抖动演练（B1 抖动恢复、B2 持续断网、B3 服务端 502），每条失败后各采一次
#   bash rc024-collect.sh after-network
#   # 制造一次翻译失败 → 点「重试翻译」
#   bash rc024-collect.sh after-retry
#   # ★本轮重点一★ 私聊自动翻译：私聊收几条外语消息，什么键都别点
#   bash rc024-collect.sh after-private-auto
#   # ★本轮重点二★ 断网 → 点译一条收到的消息 → 看 chip 是否显示「连不上服务器」
#   bash rc024-collect.sh after-chip
#   # 群聊跟随开关：开/关各收几条 + 打开群聊看历史是否被翻
#   bash rc024-collect.sh after-group
#   # ★本轮重点★ 私聊、真群各停几秒（什么都不点），采 CHAT_KIND
#   bash rc024-collect.sh after-chat-kind
#   # 连续发 3 条不同的中文
#   bash rc024-collect.sh after-consecutive
#
# 产出：./rc023-evidence-<电脑名>.txt（多次调用**追加**，不覆盖）
#       把这个文件整个发回即可；它只读、不含口令。
#
# 安全：绝不打印口令。auth.json 只报用户名；proxyPass 一律不打印。
# ---------------------------------------------------------------------------
set -uo pipefail

LABEL="${1:-snapshot}"
APPDIR="$HOME/Library/Application Support/Hello Pix"
OUT="./rc023-evidence-$(scutil --get ComputerName 2>/dev/null || hostname -s).txt"

fill () { printf '%*s' "${2:-60}" '' | tr ' ' "${1:--}"; }
title () { echo; echo "$(fill '=' 78)"; echo " $*"; echo "$(fill '=' 78)"; }

{
  title "0.1.23 取证 · label=$LABEL"
  echo " 时间 : $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo " 主机 : $(scutil --get ComputerName 2>/dev/null || hostname)"
  echo " 系统 : $(sw_vers -productVersion 2>/dev/null) / $(uname -m)"

  echo
  echo "---- 1. 已安装版本（必须是 0.1.23）----"
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

      echo
      echo "  ★本轮新增：传输层分类与安全重试★"
      echo "  --- [api] 传输层失败取证（phase / elapsedMs / err.name / err.cause.code / 是否拿到响应）---"
      grep -aE "\[api\] NETWORK_|\[api\] SERVER_BAD_RESPONSE" "$TODAY" 2>/dev/null | tail -40 | sed 's/^/  /' || echo "  （本轮没有传输层失败记录：要么网络一直好，要么演练没做到位）"
      echo '  --- 连接失败后「复用同一幂等号」重试一次 ---'
      grep -aE "连接失败，复用同一幂等号重试一次" "$TODAY" 2>/dev/null | tail -20 | sed 's/^/  /' || echo "  （没有触发安全重试）"
      echo "  --- 错误码分布（应能区分 NETWORK_UNREACHABLE / NETWORK_TIMEOUT / SERVER_BAD_RESPONSE / TRANSLATE_FAILED）---"
      grep -aoE "NETWORK_UNREACHABLE|NETWORK_TIMEOUT|SERVER_BAD_RESPONSE|TRANSLATE_FAILED|INSUFFICIENT_CHARS|ENGINE_NOT_[A-Z]+|IDEMPOTENCY_KEY_REUSED|REQUEST_FINALIZED|REQUEST_IN_PROGRESS" "$TODAY" 2>/dev/null | sort | uniq -c | sort -rn | sed 's/^/  /' || echo "  （没有错误码记录）"

      echo
      echo "  ★本轮新增①：私聊必须自动翻译★"
      echo "  --- 会话类型判定 CHAT_KIND（group / 判据来源 / 各信号 / 开关档位）---"
      grep -aE "CHAT_KIND" "$TODAY" 2>/dev/null | tail -40 | sed 's/^/  /' || echo "  （没有 CHAT_KIND —— 这版没带上判据取证，请回传）"
      echo "  --- ★翻译来源占比★（auto_receive 必须是主力；若仍为 0，说明私聊自动翻译没生效）---"
      python3 - "$TODAY" <<'PY' 2>&1 | sed 's/^/  /'
import re, sys
counts = {}
kind_counts = {}
try:
    with open(sys.argv[1], encoding='utf-8', errors='replace') as f:
        for line in f:
            m = re.search(r'trigger=([a-z_]+)', line)
            if m:
                counts[m.group(1)] = counts.get(m.group(1), 0) + 1
            k = re.search(r'CHAT_KIND\s+(\{.*\})', line)
            if k:
                import json
                try:
                    d = json.loads(k.group(1))
                    key = ('群' if d.get('group') else '私聊') + ' / ' + str(d.get('evidence'))
                    kind_counts[key] = kind_counts.get(key, 0) + 1
                except Exception:
                    pass
except FileNotFoundError:
    pass
total = sum(counts.values()) or 1
for name in ('auto_receive', 'manual_click', 'manual_send'):
    n = counts.get(name, 0)
    print('    %-14s %4d 次  (%d%%)' % (name, n, round(n * 100.0 / total)))
for extra in sorted(k for k in counts if k not in ('auto_receive', 'manual_click', 'manual_send')):
    print('    %-14s %4d 次' % (extra, counts[extra]))
print('    ── 私聊自动翻译判据：auto_receive 必须 > 0；纯私聊会话应几乎全部是 auto_receive')
if kind_counts:
    print('    ── CHAT_KIND 结论分布：')
    for k in sorted(kind_counts):
        print('       %-44s ×%d' % (k, kind_counts[k]))
PY

      echo "  --- ★本轮新增★ 头部证据形状（判据验证用；不含人名）---"
      python3 - "$TODAY" <<'SHAPE' 2>&1 | sed 's/^/  /'
import json, re, sys
seen = []
try:
    with open(sys.argv[1], encoding='utf-8', errors='replace') as f:
        for line in f:
            m = re.search(r'CHAT_KIND\s+(\{.*\})', line)
            if not m:
                continue
            try:
                d = json.loads(m.group(1))
            except Exception:
                continue
            key = (d.get('group'), d.get('evidence'), d.get('subtitleShape'))
            if key in seen:
                continue
            seen.append(key)
            print('      %s  判据=%-20s headerMarkers=%s memberList=%s' % (
                '群  ' if d.get('group') else '私聊', d.get('evidence'), d.get('headerMarkers'), d.get('memberList')))
            print('            subtitleShape=%r' % (d.get('subtitleShape'),))
            print('            headerShape=%r' % (d.get('headerShape'),))
except FileNotFoundError:
    pass
if not seen:
    print('      （没有 CHAT_KIND，请回传）')
SHAPE

      echo
      echo "  ★本轮新增②：失败 chip 说没说真话★"
      echo "  --- 收译/点译失败的 code（chip 文案就是按它分流的）---"
      grep -aE "TRANSLATE_FAILED|MANUAL_ROW_LOST|MESSAGE_TEXT_EXTRACTION_FAILED|TRANSLATION_RENDER_TARGET_MISSING|MANUAL_CLIENT_EXCEPTION" "$TODAY" 2>/dev/null | tail -40 | sed 's/^/  /' || echo "  （本轮没有翻译失败记录）"
      echo "  --- 逐码计数（用来对上界面上 chip 显示的那几句）---"
      python3 - "$TODAY" <<'PY' 2>&1 | sed 's/^/  /'
import json, re, sys
CHIP = {
    'NETWORK_UNREACHABLE': '连不上服务器 · 点击重试',
    'NETWORK_TIMEOUT': '服务器超时 · 点击重试',
    'SERVER_BAD_RESPONSE': '服务器异常 · 点击重试',
    'INSUFFICIENT_CHARS': '余额不足 · 点击重试',
    'ENGINE_NOT_ALLOWED': '通道不可用 · 点击重试',
    'ENGINE_NOT_CONFIGURED': '通道不可用 · 点击重试',
    'ENGINE_RETIRED': '通道已下架 · 点击重试',
    'NO_BRIDGE': '翻译桥未就绪 · 点击重试',
    'MANUAL_ROW_LOST': '消息已滚动 · 点击重试',
    'MANUAL_RENDER_MISSED': '译文未能显示 · 点击重试',
}
counts = {}
try:
    with open(sys.argv[1], encoding='utf-8', errors='replace') as f:
        for line in f:
            if 'TRANSLATE_FAILED' not in line and 'MANUAL_ROW_LOST' not in line:
                continue
            m = re.search(r'(\{.*\})\s*@', line) or re.search(r'(\{.*\})\s*$', line)
            if not m:
                continue
            try:
                code = str(json.loads(m.group(1)).get('code') or '')
            except Exception:
                continue
            if code:
                counts[code] = counts.get(code, 0) + 1
except FileNotFoundError:
    pass
if not counts:
    print('    (没有可统计的失败样本)')
for code, n in sorted(counts.items(), key=lambda kv: -kv[1]):
    print('    %-28s ×%-4d 界面应显示：%s' % (code, n, CHIP.get(code, '翻译失败 · 点击重试')))
PY

      echo "  --- 最近 20 行（看启动版本 / 报错）---"
      tail -20 "$TODAY" | sed 's/^/  /'
    fi
  fi

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
echo "本地也可跑分诊：node scripts/rc-trace-triage.js $OUT"
echo "本地也可跑耗时统计：node scripts/rc-send-perf.js $OUT"
