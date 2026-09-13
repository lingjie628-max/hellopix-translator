#!/bin/zsh
# dryrun-tdesktop-patch.sh — 不用 Windows、不用 clone 整个 tdesktop，
# 就能验证 apply.py 的 7 个补丁锚点对当前 tdesktop 版本是否还成立。
#
# 为什么需要它：
#   补丁锚点是硬编码的字符串匹配。tdesktop 一升版本，上游随便挪一行缩进或
#   改一处签名，锚点就可能失配。而失配的代价极高 —— 要么在 CI 上编到一半才炸，
#   要么更糟：apply.py 静默跳过，编出来一个没有 Hello Pix 钩子的官方原版，
#   表现是"气泡不出译文"，和"编译失败"从外面看一模一样。
#
#   这个脚本只拉 4 个真实文件（version.h / translate_provider.cpp /
#   history_view_translate_tracker.cpp / CMakeLists.txt）搭最小夹具，
#   在 Mac 上就能跑完注入，并把注入结果 diff 出来人工过目。
#   ensure_cpp_atl() 在非 CI-Windows 下直接返回，所以本机可以跑。
#
# 用法：
#   ./scripts/dryrun-tdesktop-patch.sh            # 默认 v7.2.8
#   ./scripts/dryrun-tdesktop-patch.sh v7.2.9     # 换版本探锚点
#
# 退出码 0 = 7/7 锚点全部命中且幂等；非 0 = 有锚点失配，需要按 diff 重新校准 apply.py。
set -euo pipefail

TAG="${1:-v7.2.8}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KIT="$ROOT/standalone/telegram-win/tdesktop-fork"
FIX="$(mktemp -d)/tdesktop-$TAG"
BASE="https://raw.githubusercontent.com/telegramdesktop/tdesktop/$TAG"

echo ">> 拉 $TAG 的真实文件搭夹具: $FIX"
mkdir -p "$FIX/Telegram/SourceFiles/lang" \
         "$FIX/Telegram/SourceFiles/history/view" \
         "$FIX/Telegram/SourceFiles/core"

fetch() {
  curl -fsSL -o "$FIX/$2" "$BASE/$2" || { echo "拉取失败: $2（版本号写错？）"; exit 1 }
}
fetch x Telegram/SourceFiles/core/version.h
fetch x Telegram/SourceFiles/lang/translate_provider.cpp
fetch x Telegram/SourceFiles/history/view/history_view_translate_tracker.cpp
fetch x Telegram/CMakeLists.txt

VERSION="$(grep -oE 'AppVersionStr = "[^"]+"' "$FIX/Telegram/SourceFiles/core/version.h" | head -1)"
echo ">> 夹具版本: $VERSION"

# 留一份原始副本做 diff 基线
mkdir -p /tmp/tdesktop-dryrun-orig
cp "$FIX/Telegram/SourceFiles/lang/translate_provider.cpp" /tmp/tdesktop-dryrun-orig/
cp "$FIX/Telegram/SourceFiles/history/view/history_view_translate_tracker.cpp" /tmp/tdesktop-dryrun-orig/
cp "$FIX/Telegram/CMakeLists.txt" /tmp/tdesktop-dryrun-orig/

echo "\n>> 第一次注入"
python3 "$KIT/apply.py" "$FIX"

echo "\n>> 第二次注入（验幂等：应当全部 skip，不得重复注入）"
python3 "$KIT/apply.py" "$FIX"

echo "\n>> 注入结果"
diff -u /tmp/tdesktop-dryrun-orig/translate_provider.cpp \
        "$FIX/Telegram/SourceFiles/lang/translate_provider.cpp" || true
diff -u /tmp/tdesktop-dryrun-orig/history_view_translate_tracker.cpp \
        "$FIX/Telegram/SourceFiles/history/view/history_view_translate_tracker.cpp" || true
diff -u /tmp/tdesktop-dryrun-orig/CMakeLists.txt \
        "$FIX/Telegram/CMakeLists.txt" || true

echo "\n>> 锚点计数（期望各为 1 / 1 / 2，出现 2 说明二次注入没被拦住）"
echo "   translate_provider.cpp  CreateHelloPixTranslateProvider: $(grep -c CreateHelloPixTranslateProvider "$FIX/Telegram/SourceFiles/lang/translate_provider.cpp")"
echo "   tracker.cpp             HelloPixShouldTranslateIncoming: $(grep -c HelloPixShouldTranslateIncoming "$FIX/Telegram/SourceFiles/history/view/history_view_translate_tracker.cpp")"
echo "   CMakeLists.txt          hello_pix_translate_provider:     $(grep -c hello_pix_translate_provider "$FIX/Telegram/CMakeLists.txt")"

echo "\n完成。夹具留在 $FIX，可直接翻看注入后的上下文。"
