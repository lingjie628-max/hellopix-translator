#!/usr/bin/env bash
#
# 1.0.0 真机取证（macOS）—— 只读，不改任何东西。
#
# 用法：
#   bash collect.sh before
#   # ...做一段验收操作...
#   bash collect.sh after-layout
#   bash collect.sh final
#
# 产出：./evidence-<电脑名>.txt（多次调用会**追加**，不是覆盖）
#
# 为什么要它：
#   这一版没有改业务逻辑，改的是界面结构和渲染层组织。所以最需要抓的是
#   "**磁盘上的真实状态**"——布局模式有没有真写进 config.json、标签栏
#   样式有没有生效、拆出去的模块文件是不是真的在包里。
#   界面显示「侧面」而 config.json 里还是 top，正是本次要杜绝的那种"假成功"。
#
# 安全：绝不打印口令。auth.json 只报「有没有 / 用户名」，
#       proxyPass 一律替换成 [redacted]。
#
set -uo pipefail

LABEL="${1:-snapshot}"
APPDIR="$HOME/Library/Application Support/Hello Pix"
OUT="./evidence-$(scutil --get ComputerName 2>/dev/null || hostname -s).txt"

{
  echo "================================================================"
  echo " 1.0.0 取证 · label=$LABEL"
  echo " 时间 : $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo " 主机 : $(scutil --get ComputerName 2>/dev/null || hostname)"
  echo " 系统 : $(sw_vers -productVersion 2>/dev/null) / $(uname -m)"
  echo "================================================================"

  echo
  echo "---- 1. 已安装版本（先确认装的是 1.0.0，不是 0.1.43）----"
  for app in "/Applications/Hello Pix.app" "$HOME/Applications/Hello Pix.app"; do
    if [ -d "$app" ]; then
      echo "  $app"
      echo "    版本: $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || echo '读不到')"
      echo "    标识: $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null || echo '读不到')"
      # 签名状态：ad-hoc 是预期，但签名结构必须完整
      echo "    签名: $(codesign -dv "$app" 2>&1 | grep -E 'Signature=|Sealed Resources' | tr '\n' ' ')"
      # 关键：确认包里有这次新拆的模块
      echo "    渲染层模块:"
      for f in ui-kit lines ops-menu site-info theme-switch trans-settings tabs collision-update tab-layout app; do
        if [ -f "$app/Contents/Resources/app.asar" ]; then
          if npx --no-install asar list "$app/Contents/Resources/app.asar" 2>/dev/null | grep -q "/renderer/$f.js"; then
            printf "      %-18s ✓\n" "$f.js"
          else
            printf "      %-18s ✗ 缺失\n" "$f.js"
          fi
        fi
      done
    else
      echo "  $app  （不存在）"
    fi
  done

  echo
  echo "---- 2. 进程（看开了几个副本）----"
  echo "  ★ 若路径里出现 AppTranslocation，说明是从 DMG/隔离目录直接跑的，"
  echo "    不是从 /Applications 打开 —— 验收请务必先拖进「应用程序」再启动。"
  MAINPIDS=$(ps -Ao pid,command 2>/dev/null | grep -i "Hello Pix.app/Contents/MacOS/Hello Pix" | grep -v grep | awk '{print $1}')
  if [ -n "$MAINPIDS" ]; then
    echo "  主进程:"
    for pid in $MAINPIDS; do
      echo "    pid=$pid  运行时长=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')"
    done
    echo "  渲染进程数: $(ps -Ao command 2>/dev/null | grep -c "Hello Pix Helper (Renderer)")"
    TRANS=$(ps -Ao command 2>/dev/null | grep -c "AppTranslocation.*Hello Pix")
    if [ "$TRANS" -gt 0 ]; then
      echo "  ⚠️ 检测到 AppTranslocation（$TRANS 个进程）：App 不是从「应用程序」启动的"
    else
      echo "  启动位置: /Applications ✓"
    fi
  else
    echo "  （没有在跑）"
  fi

  echo
  echo "---- 3. config.json：磁盘上的真实设置 ----"
  echo "  ★ 判读重点：tabLayout 必须是 top 或 side，且与界面一致。"
  if [ -f "$APPDIR/config.json" ]; then
    node -e '
      const fs = require("fs")
      const p = process.argv[1]
      try {
        const c = JSON.parse(fs.readFileSync(p, "utf8"))
        const pick = (k) => (c[k] === undefined ? "(未设置)" : JSON.stringify(c[k]))
        console.log("    tabLayout        : " + pick("tabLayout") + "   ← 本次重点")
        console.log("    theme            : " + pick("theme"))
        console.log("    backgroundRunning: " + pick("backgroundRunning"))
        console.log("    lineId           : " + pick("lineId"))
        console.log("    线路条数         : " + (Array.isArray(c.lines) ? c.lines.length : "无"))
      } catch (e) {
        console.log("    解析失败: " + e.message)
      }
    ' "$APPDIR/config.json"
  else
    echo "  （没有 config.json —— 可能还从没登录过）"
  fi

  echo
  echo "---- 4. open-apps.json：多开槽位 ----"
  echo "  ★ 判读重点：挂起的实例 hidden=true，且登录状态不应因此丢失。"
  if [ -f "$APPDIR/open-apps.json" ]; then
    node -e '
      const fs = require("fs")
      try {
        const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
        const rows = Array.isArray(d) ? d : (d.apps || [])
        console.log("    实例数: " + rows.length)
        for (const r of rows) {
          const name = r.name || r.label || r.platform || "(无名)"
          console.log("      - " + name +
            "  hidden=" + !!r.hidden +
            "  platform=" + (r.platform || "?"))
        }
      } catch (e) {
        console.log("    解析失败: " + e.message)
      }
    ' "$APPDIR/open-apps.json"
  else
    echo "  （没有 open-apps.json）"
  fi

  echo
  echo "---- 5. auth.json：只报有没有存，绝不打印口令 ----"
  if [ -f "$APPDIR/auth.json" ]; then
    node -e '
      const fs = require("fs")
      try {
        const a = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
        console.log("    记住密码: " + (a.remember ? "是" : "否"))
        console.log("    自动登录: " + (a.autoLogin ? "是" : "否"))
        console.log("    用户名  : " + (a.username || "(空)"))
        console.log("    口令已存: " + (a.password ? "是（内容不打印）" : "否"))
      } catch (e) {
        console.log("    解析失败: " + e.message)
      }
    ' "$APPDIR/auth.json"
  else
    echo "  （没有 auth.json）"
  fi

  echo
  echo "---- 6. 渲染层日志里的报错（最近 40 条）----"
  LOGDIR="$APPDIR/logs"
  if [ -d "$LOGDIR" ]; then
    LATEST=$(ls -t "$LOGDIR"/*.log 2>/dev/null | head -1)
    if [ -n "${LATEST:-}" ]; then
      echo "  文件: $(basename "$LATEST")"
      grep -iE "error|uncaught|is not defined|not a function|SyntaxError|ReferenceError" "$LATEST" 2>/dev/null \
        | tail -40 | sed 's/^/  /' || echo "  （无匹配）"
    else
      echo "  （logs 目录里没有 .log）"
    fi
  else
    echo "  （没有 logs 目录）"
  fi

  echo
  echo "---- 7. 截图提示 ----"
  echo "  布局问题请另存截图，本脚本不抓屏幕。"

  echo
  echo "================================================================"
  echo " 本段结束 · $(date '+%H:%M:%S')"
  echo "================================================================"
  echo

} >> "$OUT" 2>&1

echo "已追加到: $OUT"
