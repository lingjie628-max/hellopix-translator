#!/usr/bin/env bash
#
# 0.1.25 真机取证（macOS）—— 只读，不改任何东西。
#
# 本轮修的是**观感缺陷**（用户 2026-10-11 报）：
#   「群组翻译，开启自动翻译后，不应出现这个翻译按钮，而是自动完成聊天内容的翻译；
#     而且开了群聊自动翻译后，一部分翻译，还有一部分没有翻译。」
#   根因（0.1.24 真机日志）：messageAction 里有一条
#     `if (s.group && s.historic) return 'chip'`
#   —— 把「群聊=自动」降级成**半自动**：只有新到的自动翻，
#   打开会话时已经在页面上的那批只挂「译」按钮。
#   同一分钟实测：MANUAL_CHIP_RENDERED × 43 对 auto_receive × 26。
#   修法：删掉历史闸门 → 「自动」= 会话里**全部**消息自动翻、**不再留「译」**；
#         自动派发改**有界并发（3）、新的先翻**；切到自动时**收掉残留 chip**；
#         paint 加「内容没变不写 DOM」，掐断 MutationObserver 自激循环。
#
# 本轮要采的四件事：
#   ① ★核心★ 群聊设「自动」打开会话：页面上那批消息**全部自动翻**，MANUAL_CHIP 必须为 0
#   ② ★核心★ 同群滚动补加载：仍然全自动、仍然 0 个「译」
#   ③ ★护栏★ 群聊设「手动」：一条都不许自动翻（计费保护，最高优先级）
#   ④ ★并发★ AUTO_DISPATCH 的 running 最大观测值必须 ≤ 3；同一 requestId 复用（幂等）
#
# 上一轮（会话类型只读头部 / 失败 chip 按类别说话 / 传输层分类）与更早的
# 发送正确性、发送耗时 P50,P95 取证项**全部保留**。
#
# 用法（建议按顺序采，每采一次都会追加到同一个文件）：
#   bash rc025-collect.sh before
#   # ★本轮重点一★ 群聊设「自动」，打开一个有历史的群，什么都别点
#   bash rc025-collect.sh after-group-auto
#   # ★本轮重点二★ 同群滚动补加载 + 让消息多来几条，看「译」是否仍然为 0
#   bash rc025-collect.sh after-group-auto-scroll
#   # 「自动 → 手动 → 自动」切一轮，看残留 chip 是否被收掉
#   bash rc025-collect.sh after-group-switch
#   # 群聊设「手动」打开，确认一条都不自动翻
#   bash rc025-collect.sh after-group-manual
#   # 私聊自动翻译（确认 0.1.24 的修复没坏）
#   bash rc025-collect.sh after-private-auto
#   # 断网 → 点译一条收到的消息 → 看 chip 文案
#   bash rc025-collect.sh after-chip
#   # 把实例通道切成 GPT，正常发 20 条中文
#   bash rc025-collect.sh after-gpt
#   # 把实例通道切成 DeepSeek，正常发 20 条中文
#   bash rc025-collect.sh after-deepseek
#   # 断网 / 抖动演练（C1 抖动恢复、C2 持续断网、C3 幂等），每条失败后各采一次
#   bash rc025-collect.sh after-network
#   # 连续发 3 条不同的中文
#   bash rc025-collect.sh after-consecutive
#
# 产出：./rc025-evidence-<电脑名>.txt（多次调用**追加**，不覆盖）
#       把这个文件整个发回即可；它只读、不含口令。
#
# 安全：绝不打印口令。auth.json 只报用户名；proxyPass 一律不打印。
# ---------------------------------------------------------------------------
set -uo pipefail

LABEL="${1:-snapshot}"
APPDIR="$HOME/Library/Application Support/Hello Pix"
OUT="./rc025-evidence-$(scutil --get ComputerName 2>/dev/null || hostname -s).txt"

fill () { printf '%*s' "${2:-60}" '' | tr ' ' "${1:--}"; }
title () { echo; echo "$(fill '=' 78)"; echo " $*"; echo "$(fill '=' 78)"; }

{
  title "0.1.25 取证 · label=$LABEL"
  echo " 时间 : $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo " 主机 : $(scutil --get ComputerName 2>/dev/null || hostname)"
  echo " 系统 : $(sw_vers -productVersion 2>/dev/null) / $(uname -m)"

  echo
  echo "---- 1. 已安装版本（必须是 0.1.25）----"
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
      echo "  ★传输层分类与安全重试（0.1.24 的成果，确认没被碰坏）★"
      echo "  --- [api] 传输层失败取证（phase / elapsedMs / err.name / err.cause.code / 是否拿到响应）---"
      grep -aE "\[api\] NETWORK_|\[api\] SERVER_BAD_RESPONSE" "$TODAY" 2>/dev/null | tail -40 | sed 's/^/  /' || echo "  （本轮没有传输层失败记录：要么网络一直好，要么演练没做到位）"
      echo '  --- 连接失败后「复用同一幂等号」重试一次 ---'
      grep -aE "连接失败，复用同一幂等号重试一次" "$TODAY" 2>/dev/null | tail -20 | sed 's/^/  /' || echo "  （没有触发安全重试）"
      echo "  --- 错误码分布（应能区分 NETWORK_UNREACHABLE / NETWORK_TIMEOUT / SERVER_BAD_RESPONSE / TRANSLATE_FAILED）---"
      grep -aoE "NETWORK_UNREACHABLE|NETWORK_TIMEOUT|SERVER_BAD_RESPONSE|TRANSLATE_FAILED|INSUFFICIENT_CHARS|ENGINE_NOT_[A-Z]+|IDEMPOTENCY_KEY_REUSED|REQUEST_FINALIZED|REQUEST_IN_PROGRESS" "$TODAY" 2>/dev/null | sort | uniq -c | sort -rn | sed 's/^/  /' || echo "  （没有错误码记录）"

      echo
      echo "  ★本轮新增①：群聊自动 = 全自动（不再留「译」）★"
      echo "  --- 会话类型判定 CHAT_KIND（group / 判据来源 / 各信号 / 开关档位）---"
      grep -aE "CHAT_KIND" "$TODAY" 2>/dev/null | tail -40 | sed 's/^/  /' || echo "  （没有 CHAT_KIND —— 这版没带上判据取证，请回传）"

      echo "  --- ★自动派发★ AUTO_DISPATCH（candidates / dispatched / queued / running / chipRemoved）---"
      grep -aE "AUTO_DISPATCH" "$TODAY" 2>/dev/null | tail -60 | sed 's/^/  /' || echo "  （没有 AUTO_DISPATCH —— 本版应每派发一轮就打一条，请回传）"

      echo "  --- ★关键判据★ 群聊「自动」下 MANUAL_CHIP_RENDERED 必须为 0；「手动」下必须 > 0 ---"
      python3 - "$TODAY" <<'PY' 2>&1 | sed 's/^/  /'
import json, re, sys
# 把 CHAT_KIND 的 group/groupMode 与 MANUAL_CHIP_RENDERED 按"时间顺序 + tab"归组：
# 真机日志没有会话号，只能按 tabId + 最近的 CHAT_KIND 档位归因。
last = {}                 # tabId -> (group, groupMode)
chips = {}                # (group, groupMode) -> 计数
dists = {}                # (group, groupMode) -> 最近一条 AUTO_DISPATCH
try:
    with open(sys.argv[1], encoding='utf-8', errors='replace') as f:
        for line in f:
            mk = re.search(r'CHAT_KIND\s+(\{.*\})', line)
            if mk:
                try:
                    d = json.loads(mk.group(1))
                    tab = str(d.get('tabId') or '-')
                    last[tab] = (bool(d.get('group')), str(d.get('groupMode') or '?'))
                except Exception:
                    pass
            mc = re.search(r'MANUAL_CHIP_RENDERED\s+(\{.*\})', line)
            if mc:
                try:
                    d = json.loads(mc.group(1))
                    tab = str(d.get('tabId') or '-')
                    key = last.get(tab, (None, '?'))
                    chips[key] = chips.get(key, 0) + 1
                except Exception:
                    pass
            md = re.search(r'AUTO_DISPATCH\s+(\{.*\})', line)
            if md:
                try:
                    d = json.loads(md.group(1))
                    key = (bool(d.get('group')), str(d.get('groupMode') or '?'))
                    dists[key] = d
                except Exception:
                    pass
except FileNotFoundError:
    pass

print('    会话类型 / 开关档位           MANUAL_CHIP_RENDERED')
for key in sorted(set(list(chips) + list(dists)), key=lambda k: str(k)):
    grp, mode = key
    label = ('群聊' if grp else '私聊' if grp is not None else '未知') + ' / ' + mode
    print('    %-30s %d 次' % (label, chips.get(key, 0)))
print('    ── 判据：群聊 / auto 那行必须 = 0（这就是用户 2026-10-11 报的「开着自动还挂着译」）')
print()
print('    最近一轮 AUTO_DISPATCH（看 running ≤ 3 与 chipRemoved）：')
for key in sorted(dists, key=lambda k: str(k)):
    grp, mode = key
    d = dists[key]
    print('    %-30s candidates=%s dispatched=%s queued=%s running=%s chipRemoved=%s'
          % (('群聊' if grp else '私聊') + ' / ' + mode,
             d.get('candidates'), d.get('dispatched'), d.get('queued'), d.get('running'), d.get('chipRemoved')))
PY

      echo "  --- ★翻译来源占比★（群聊自动时 auto_receive 应是主力；群聊手动时群里应为 0）---"
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
                    key = ('群' if d.get('group') else '私聊') + ' / ' + str(d.get('evidence')) + ' / ' + str(d.get('groupMode'))
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
print('    ── 群聊设「自动」的会话里：auto_receive 必须 > 0，且不应出现 manual_click')
print('    ── 群聊设「手动」的会话里：auto_receive 必须 = 0（计费护栏）')
if kind_counts:
    print('    ── CHAT_KIND 结论分布：')
    for k in sorted(kind_counts):
        print('       %-50s ×%d' % (k, kind_counts[k]))
PY

      echo "  --- ★并发上限与幂等★（running ≤ 3；同一 requestId 复用）---"
      python3 - "$TODAY" <<'PY' 2>&1 | sed 's/^/  /'
import json, re, sys
maxrun = 0
reqs = {}
try:
    with open(sys.argv[1], encoding='utf-8', errors='replace') as f:
        for line in f:
            md = re.search(r'AUTO_DISPATCH\s+(\{.*\})', line)
            if md:
                try:
                    d = json.loads(md.group(1))
                    r = d.get('running')
                    if isinstance(r, (int, float)):
                        maxrun = max(maxrun, int(r))
                except Exception:
                    pass
            mr = re.search(r'requestId["\':= ]+([A-Za-z0-9:_\-./]+)', line)
            if mr:
                key = mr.group(1)
                reqs[key] = reqs.get(key, 0) + 1
except FileNotFoundError:
    pass
print('    AUTO_DISPATCH.running 最大观测值 = %d  （应 ≤ 3；>3 说明并发上限失效）' % maxrun)
reused = {k: v for k, v in reqs.items() if v > 1}
print('    出现多次的 requestId 数 = %d  （>0 表示幂等号被复用：重放不会重复扣费）' % len(reused))
if reused:
    for k in sorted(reused, key=lambda k: -reused[k])[:5]:
        print('      ×%-3d  %s' % (reused[k], k))
PY

      echo "  --- 头部证据形状（沿用 0.1.24；不含人名）---"
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
      echo "  ★失败 chip 说没说真话（0.1.23 的成果）★"
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
