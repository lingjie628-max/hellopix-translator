#!/bin/bash
# 用 macOS 自带 sips 把 .svg 光栅化成 2 倍尺寸 PNG（矢量渲染，文字清晰）
cd "$(dirname "$0")"
for f in *.svg; do
  [ -e "$f" ] || continue
  sips -s format png "$f" --out "${f%.svg}.png" >/dev/null 2>&1 && echo "  ${f%.svg}.png"
done
