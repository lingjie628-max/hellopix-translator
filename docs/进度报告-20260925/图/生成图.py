#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""《Hello Pix · 项目进度与未完成项报告（2026-09-25）》示意图生成脚本。

输出 8 张 SVG（设计宽 1100，渲染时 2 倍）。用 rsvg-convert 光栅化 ——
macOS 自带的 sips **不支持 SVG**，所以旧报告的 `渲染.sh` 实际是无效的，
这里改用 rsvg-convert（已实测可用，中文字体走 Hiragino Sans GB / Heiti SC）。

配色与 docx 正文一致。
"""
import os

OUT = os.path.dirname(os.path.abspath(__file__))

NAVY = "#0B1F3A"
BLUE = "#2563EB"
DARK = "#172033"
BODY = "#2B3748"
MUTED = "#667085"
FAINT = "#94A3B8"
CARD = "#FFFFFF"
CARDBD = "#DBE3EE"
BLUEBG = "#EAF2FF"
BLUEBD = "#C7D6EE"
GRAYBG = "#F1F5F9"
GRAYBD = "#CBD5E1"
GREENBG = "#DCFCE7"
GREENBD = "#86EFAC"
GREENTX = "#065F46"
WARNBG = "#FFF7E8"
WARNBD = "#FDE68A"
WARNTX = "#92400E"
REDBG = "#FEF2F2"
REDBD = "#FECACA"
REDTX = "#B91C1C"
PAGEBG = "#F7F9FC"
FONT = "PingFang SC, Hiragino Sans GB, Heiti SC, sans-serif"


def rect(x, y, w, h, fill=CARD, stroke=CARDBD, rx=10, sw=1):
    st = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ""
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}"{st}/>'


def txt(x, y, s, size=13, color=BODY, weight="400", anchor="start", ls=None):
    w = f' font-weight="{weight}"' if weight != "400" else ""
    a = f' text-anchor="{anchor}"' if anchor != "start" else ""
    l = f' letter-spacing="{ls}"' if ls else ""
    return (f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}"'
            f'{w}{a}{l}>{esc(s)}</text>')


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def line(x1, y1, x2, y2, color=FAINT, sw=1.5, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<path d="M{x1} {y1} L{x2} {y2}" stroke="{color}" stroke-width="{sw}" fill="none"{d}/>'


def arrow(x1, y1, x2, y2, color=FAINT, sw=1.6, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<path d="M{x1} {y1} L{x2} {y2}" stroke="{color}" stroke-width="{sw}" '
            f'fill="none" marker-end="url(#ah)"{d}/>')


def svg(width, height, body, scale=2):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width*scale}" '
        f'height="{height*scale}" viewBox="0 0 {width} {height}" font-family="{FONT}">\n'
        f'<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" '
        f'markerHeight="6" orient="auto-start-reverse">'
        f'<path d="M0 0 L10 5 L0 10 z" fill="{FAINT}"/></marker></defs>\n'
        f'<rect width="{width}" height="{height}" fill="{PAGEBG}"/>\n'
        + body + "\n</svg>\n")


def head(title, sub, y=52):
    return txt(40, y, title, 26, "#0F172A", "700") + "\n" + txt(40, y + 26, sub, 14, MUTED)


def write(name, content):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        f.write(content)
    print("  " + name)


def wrap(s, n):
    """按字符数硬折行 —— SVG 没有自动换行，必须自己断。"""
    out, cur = [], ""
    for ch in str(s):
        cur += ch
        if len(cur) >= n:
            out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    return out


# ---------------------------------------------------------------- 图 1 未完成项全景
def fig01():
    b = [head("未完成项全景 · 截至 2026-09-25（当日二次更新）",
              "上一版列出的 10 项里，8 项已在本轮做完并实测；剩下 2 项都不阻断上线")]
    # ---- 本轮已清零（8 项）
    by = 116
    b.append(rect(40, by, 1020, 176, GREENBG, GREENBD, 12, 1.2))
    b.append(txt(58, by + 30, "✅  本轮已清零（8 项）", 15, GREENTX, "700"))
    done = [
        ("Windows 真机验收", "已在真机跑通，无问题"),
        ("代码签名证书", "签名问题已解决"),
        ("基础版无可用引擎", "接通 google，4 商户恢复"),
        ("macOS 未构建", "0.1.6 已构建上架"),
        ("客户端不写日志", "0.1.6 已落地文件日志"),
        ("旧工单接口残留", "后端死接口已清理"),
        ("迁移 016 注释", "已修正指向"),
        ("免安装版未更新", "已随 0.1.6 重打"),
    ]
    gap, cols = 14, 4
    cw = (1020 - 36 - (cols - 1) * gap) / cols
    for i, (t, s) in enumerate(done):
        col, row = i % cols, i // cols
        cx = 58 + col * (cw + gap)
        cy = by + 46 + row * 62
        b.append(rect(cx, cy, cw, 54, "#FFFFFF", GREENBD, 8))
        b.append(txt(cx + 12, cy + 22, "✓ " + t, 12.5, GREENTX, "700"))
        b.append(txt(cx + 12, cy + 40, s, 10.5, MUTED))
    y = by + 176 + 14
    # ---- 仍待办
    lanes = [
        ("🟠  待办 · 不阻断上线", WARNBG, WARNBD, WARNTX, [
            ("5 个引擎「可选中但未接通」", "选中即 503，会转成「翻译坏了」的客服工单",
             "你（给凭据）/ 我（摘除）", "按厂商 / 1 小时"),
            ("USDT 自动充值的真实资金未验证", "影子模式已跑通，但从未走过真实资金",
             "你 + 我", "1 天"),
        ]),
        ("⚪  可选加固 · 本轮新增建议", GRAYBG, GRAYBD, MUTED, [
            ("引擎连通性探针接入监控", "「wired=true 但翻不了」能自动告警，不必等商户报障",
             "我", "1 小时"),
            ("接通引擎的接口地址加校验", "端点填成控制台网址会静默变成 405/403",
             "我", "1 小时"),
        ]),
    ]
    for label, bg, bd, tx, items in lanes:
        n = len(items)
        lane_h = 118
        b.append(rect(40, y, 1020, lane_h, bg, bd, 12, 1.2))
        b.append(txt(58, y + 30, label, 15, tx, "700"))
        gapx = 14
        cw = (1020 - 36 - (n - 1) * gapx) / n
        for i, (t, s, who, eta) in enumerate(items):
            cx = 58 + i * (cw + gapx)
            cy = y + 44
            b.append(rect(cx, cy, cw, 62, "#FFFFFF", bd, 8))
            b.append(txt(cx + 12, cy + 22, t, 12.5, tx, "700"))
            for ln in wrap(s, int(cw / 12.4))[:1]:
                b.append(txt(cx + 12, cy + 40, ln, 10.5, MUTED))
            b.append(txt(cx + 12, cy + 56, "谁做：" + who, 10, FAINT))
            b.append(txt(cx + cw - 12, cy + 56, eta, 10, tx, "700", "end"))
        y += lane_h + 14
    b.append(txt(40, y + 12, "「谁做」里的『你』= 必须你本人操作（真实账号 / 购买 / 商业决定）；"
                            "『我』= 我可以直接做完，不需要你介入", 11.5, FAINT))
    return svg(1100, y + 32, "\n".join(b))


# ---------------------------------------------------------------- 图 2 阻断项依赖
def fig02():
    b = [head("四道上线阻断 · 已全部解除（截至 2026-09-25）",
              "上一版列出的四项阻断已逐条落实，当前没有「不做完就不能上线」的项")]
    cards = [
        ("① 代码签名证书", "签名问题已解决 —— 下载安装不再被 Defender / SmartScreen 拦截。"
                          "这是上一版关键路径上等待期最长的一项。", "你", "已解除"),
        ("② Windows 真机验收", "真实 Windows 机器上端到端跑通：装包 → 登录 → 多开 → "
                              "收发消息 → 翻译 → 扣费，验收结论：无问题。", "你 + 我", "已通过"),
        ("③ 基础版套餐无可用引擎", "接通 google 后，基础版 4 个在用商户恢复可翻译"
                                  "（原先报的是「当前套餐未包含此通道」）。", "你 + 我", "已解除"),
        ("④ macOS 未构建", "0.1.6 已构建并上架（arm64 + x64），含本轮全部修复，"
                         "不再停留在 0.1.3。", "我", "已上架"),
    ]
    gap = 16
    cw = (1020 - gap) / 2
    for i, (t, s, who, eta) in enumerate(cards):
        col, row = i % 2, i // 2
        x = 40 + col * (cw + gap)
        y = 116 + row * 176
        b.append(rect(x, y, cw, 160, "#FFFFFF", GREENBD, 12, 1.2))
        b.append(rect(x + cw - 80, y + 16, 64, 24, GREENBG, GREENBD, 12))
        b.append(txt(x + cw - 48, y + 33, "✅ 解除", 11.5, GREENTX, "700", "middle"))
        b.append(txt(x + 18, y + 38, t, 14.5, DARK, "700"))
        for j, ln in enumerate(wrap(s, int((cw - 40) / 12.2))[:3]):
            b.append(txt(x + 18, y + 64 + j * 19, ln, 11.5, BODY))
        b.append(txt(x + 18, y + 140, "谁做：" + who, 10.5, FAINT))
        b.append(txt(x + cw - 18, y + 140, eta, 11, GREENTX, "700", "end"))
    y = 116 + 2 * 176 + 6
    b.append(rect(40, y, 1020, 76, GREENBG, GREENBD, 10, 1.2))
    b.append(txt(60, y + 32, "✅  上线阻断项：0 项", 15, GREENTX, "700"))
    b.append(txt(60, y + 56, "剩下的两项 —— USDT 真实资金验证、5 个引擎未接通 —— 都不阻断上线，"
                             "属于体验与风险加固（见第 15 节）", 11.5, BODY))
    return svg(1100, y + 100, "\n".join(b))


# ---------------------------------------------------------------- 图 3 后台运行状态机
def fig03():
    b = [head("0.1.5 后台运行 · 关窗决策状态机",
              "三道闸门依次判断；任一道给出「放行」就真的退出。每一条放宽都必须有理由：宁可退出，也不要藏得找不回来")]
    steps = [
        ("用户点击窗口 ×", "触发 win.on('close')", BLUEBG, BLUEBD, "#1E3A8A", ""),
        ("正在退出？", "isQuitting", "#FFFFFF", CARDBD, DARK,
         "是 → 放行（必须！否则 app.quit() 被自己拦下）"),
        ("后台运行已开？", "backgroundRunning", "#FFFFFF", CARDBD, DARK,
         "否 → 放行，尊重「关窗即退出」的用户设置"),
        ("托盘建出来了？", "hasTray", "#FFFFFF", CARDBD, DARK,
         "否 → 放行（没有托盘就没有唤回窗口的入口）"),
        ("拦截关闭", "隐藏到托盘 · 翻译继续跑", GREENBG, GREENBD, GREENTX, ""),
    ]
    n = len(steps)
    gap = 16
    bw = (1020 - (n - 1) * gap) / n
    for i, (t, sub, f, st, tx, note) in enumerate(steps):
        x = 40 + i * (bw + gap)
        b.append(rect(x, 132, bw, 84, f, st, 10, 1.2))
        b.append(txt(x + bw / 2, 162, t, 13, tx, "700", "middle"))
        b.append(txt(x + bw / 2, 182, sub, 10.5, MUTED, "400", "middle"))
        b.append(txt(x + bw / 2, 203, "第 %d 步" % (i + 1) if i < 4 else "结果", 10, FAINT, "400", "middle"))
        if i < n - 1:
            b.append(arrow(x + bw + 2, 174, x + bw + gap - 2, 174, FAINT, 1.8))
        if note:
            for j, ln in enumerate(wrap(note, 17)[:3]):
                b.append(txt(x + bw / 2, 240 + j * 16, ln, 10, REDTX, "400", "middle"))
    b.append(txt(40, 314, "左边三道闸门任一给出「放行」→ 真的退出；全部通过 → 隐藏到托盘（绿色结果）",
                 11.5, MUTED))

    # 三条退出路径
    b.append(txt(40, 356, "另外三条路径 —— 都会真的退出，且必须退出", 13.5, BLUE, "700"))
    exits = [
        ("托盘菜单 →「退出 Hello Pix」", "quitApp() 先立 isQuitting = true 再 app.quit()", GREENTX),
        ("关掉了后台运行开关", "window-all-closed 必须退出，不能拿「托盘还在」当借口赖着不走", WARNTX),
        ("窗口被异常带走（渲染进程崩溃）", "托盘还在 → 留在托盘等唤回；托盘也没了 → 退出", MUTED),
    ]
    cw = (1020 - 2 * 18) / 3
    for i, (t, s, tx) in enumerate(exits):
        x = 40 + i * (cw + 18)
        b.append(rect(x, 374, cw, 110, "#FFFFFF", CARDBD, 8))
        for j, ln in enumerate(wrap(t, int(cw / 13.5))):
            b.append(txt(x + 14, 400 + j * 18, ln, 12.5, tx, "700"))
        off = 18 * len(wrap(t, int(cw / 13.5)))
        for j, ln in enumerate(wrap(s, int(cw / 11.5))):
            b.append(txt(x + 14, 406 + off + j * 16, ln, 11, MUTED))

    b.append(rect(40, 502, 1020, 66, WARNBG, WARNBD, 10, 1.2))
    b.append(txt(60, 528, "★ 最容易写错：app.quit() 会先触发 close —— 那时若还按「关闭=隐藏」处理，"
                          "退出就被自己吃掉了（现象：点了退出没反应，只能去任务管理器杀进程）", 11.5, WARNTX, "700"))
    b.append(txt(60, 552, "★ 第二易错：托盘创建失败必须把 tray 置空，判定据此放行退出 ——"
                          "否则窗口藏了、又没有任何入口能找回来，进程就成了用户看不见也关不掉的僵尸", 11.5, WARNTX))
    b.append(txt(40, 590, "两个入口改的是同一个设置：托盘右键菜单 + 界面「系统操作」菜单。"
                          "改任一处，主进程推送事件同步另一处，避免两处显示各说各话", 11, FAINT))
    return svg(1100, 612, "\n".join(b))


# ---------------------------------------------------------------- 图 4 多开槽位隔离
def fig04():
    b = [head("多开分区隔离 · 0.1.3 的问题与 0.1.5 的解法",
              "0.1.3 两个实例会撞同一个 session 分区，第二个窗口直接看到第一个的登录态")]
    # 左：0.1.3 的问题
    b.append(rect(40, 118, 500, 300, REDBG, REDBD, 12, 1.2))
    b.append(txt(60, 148, "0.1.3 · 撞分区（复现的问题）", 14, REDTX, "700"))
    for i, (tag, act) in enumerate([("进程 A", "usedCount{telegram-z:1} → 打开 → index=2"),
                                    ("进程 B", "usedCount{telegram-z:1} → 打开 → index=2")]):
        y = 172 + i * 74
        b.append(rect(60, y, 460, 60, "#FFFFFF", REDBD, 8))
        b.append(txt(76, y + 24, tag, 12.5, REDTX, "700"))
        b.append(txt(76, y + 45, act, 11, MUTED))
    b.append(txt(60, 330, "原因：序号来自**进程内**内存计数器，", 11.5, REDTX))
    b.append(txt(60, 350, "而 Partitions/ 目录是**所有进程共享**的。", 11.5, REDTX))
    b.append(txt(60, 378, "结果：两个进程拿到同一个分区名 →", 11.5, BODY))
    b.append(txt(60, 398, "共享 Cookie/登录态，并并发读写同一目录", 11.5, BODY))

    # 右：0.1.5 的解法
    b.append(rect(560, 118, 500, 300, GREENBG, GREENBD, 12, 1.2))
    b.append(txt(580, 148, "0.1.5 · 槽位锁（已修复）", 14, GREENTX, "700"))
    for i, (tag, act, name) in enumerate([
            ("进程 A", "抢到槽位 1", "persist:pix-用户-telegram-z-1"),
            ("进程 B", "抢到槽位 2", "persist:pix-用户-s2-telegram-z-1")]):
        y = 168 + i * 86
        b.append(rect(580, y, 460, 72, "#FFFFFF", GREENBD, 8))
        b.append(txt(596, y + 24, tag + " → " + act, 12.5, GREENTX, "700"))
        b.append(txt(596, y + 48, name, 11, MUTED))
    b.append(txt(580, 356, "用 wx 独占创建抢锁，锁里记 PID；", 11.5, GREENTX))
    b.append(txt(580, 376, "持有者已死则接管（崩溃不会永久占位）", 11.5, GREENTX))
    b.append(txt(580, 400, "★ 槽位 1 不加中缀 → 单实例用户升级不丢登录态", 11.5, GREENTX, "700"))

    # 底部：判定方法
    b.append(rect(40, 436, 1020, 92, BLUEBG, BLUEBD, 10))
    b.append(txt(60, 464, "验收怎么判定（这一步是产品核心卖点，必须真机确认）", 13, "#1E3A8A", "700"))
    b.append(txt(60, 490, "开第二个实例 → 看它的 Telegram 首屏：直接进已登录状态 = 隔离失败（复现）；"
                          "显示二维码/要重新登录 = 隔离正常", 11.5, BODY))
    b.append(txt(60, 512, "并核对 Partitions 目录：出现 telegram-z-1 与 telegram-z-2 两个目录 = 正常；"
                          "只有一个共同目录 = 失败", 11.5, BODY))
    return svg(1100, 546, "\n".join(b))


# ---------------------------------------------------------------- 图 5 版本上架现状
def fig05():
    b = [head("客户端版本上架现状 · 生产库实测",
              "Windows 与 macOS 均已到 0.1.6，两个平台都带上本轮全部修复")]
    cols = [
        ("Windows x64", "0.1.6", [
            ("上架状态", "✅ enabled = true"),
            ("安装包", "安装版 + 免安装版"),
            ("本轮新增", "客户端文件日志"),
            ("已有能力", "后台运行 / 分区隔离"),
            ("真机验收", "✅ 已通过（无问题）"),
            ("签名", "✅ 签名问题已解决"),
        ]),
        ("macOS arm64 / x64", "0.1.6", [
            ("上架状态", "✅ enabled = true"),
            ("安装包", "HelloPix-0.1.6-*.dmg"),
            ("本轮新增", "客户端文件日志"),
            ("已有能力", "后台运行 / 分区隔离"),
            ("构建", "arm64 与 x64 双架构"),
            ("签名", "ad-hoc（公证仍是可选项）"),
        ]),
    ]
    for i, (os_name, ver, rows) in enumerate(cols):
        x = 40 + i * 520
        f, st, tx = BLUEBG, BLUEBD, "#1E3A8A"
        b.append(rect(x, 118, 500, 330, f, st, 12, 1.2))
        b.append(txt(x + 24, 152, os_name, 15, tx, "700"))
        b.append(txt(x + 476, 156, ver, 26, tx, "700", "end"))
        yy = 176
        for k, v in rows:
            b.append(line(x + 20, yy, x + 480, yy, st, 1))
            if k:
                b.append(txt(x + 24, yy + 24, k, 11.5, tx, "700"))
            b.append(txt(x + 140, yy + 24, v, 11.5, BODY))
            yy += 44
        b.append(line(x + 20, yy, x + 480, yy, st, 1))
    b.append(rect(40, 468, 1020, 74, GREENBG, GREENBD, 10, 1.2))
    b.append(txt(60, 496, "✅ 两平台同步到 0.1.6 —— 上一版「mac 仍停在 0.1.3」「免安装版未更新」均已不成立", 12, GREENTX, "700"))
    b.append(txt(60, 520, "客户端文件日志：保留 7 天、单文件 5MB 上限、崩溃走同步写入；"
                          "日志目录可从右键菜单或托盘菜单的「打开日志目录」直达", 11.5, BODY))
    return svg(1100, 562, "\n".join(b))


# ---------------------------------------------------------------- 图 6 套餐 × 引擎矩阵
def fig06():
    b = [head("套餐 × 翻译引擎矩阵 · 生产库实测（2026-09-25 二次更新）",
              "9 个引擎里 4 个已接通，且探针实测 4/4 全部能翻；基础版已恢复可用")]
    engines = ["deepseek", "gpt", "aws", "deepl", "gemini", "google", "grok", "niutrans", "papago"]
    wired = {"deepseek": True, "gpt": True, "google": True, "grok": True}
    pkgs = [
        ("基础版", 4, {"google", "niutrans"}),
        ("高级版", 0, {"deepseek", "gemini", "google", "niutrans"}),
        ("专业版", 4, set(engines)),
    ]
    left, top = 250, 150
    cw = (1100 - 60 - left) / len(engines)
    # 表头
    for j, e in enumerate(engines):
        x = left + j * cw
        col = GREENTX if wired.get(e) else FAINT
        b.append(txt(x + cw / 2, top - 26, e, 10.5, col, "700", "middle"))
    for i, (name, cnt, has) in enumerate(pkgs):
        y = top + i * 76
        usable = [e for e in has if wired.get(e)]
        b.append(rect(40, y, 1020, 66, "#FFFFFF", CARDBD, 8))
        b.append(txt(60, y + 28, name, 14, DARK, "700"))
        b.append(txt(60, y + 48, f"{cnt} 个商户", 10.5, MUTED))
        b.append(txt(140, y + 28, f"✅ {len(usable)} 个可用", 11, GREENTX, "700"))
        for j, e in enumerate(engines):
            x = left + j * cw
            if e not in has:
                b.append(txt(x + cw / 2, y + 40, "–", 14, "#CBD5E1", "700", "middle"))
                continue
            if wired.get(e):
                b.append(rect(x + 6, y + 18, cw - 12, 30, GREENBG, GREENBD, 6))
                b.append(txt(x + cw / 2, y + 38, "✓", 15, GREENTX, "700", "middle"))
            else:
                b.append(rect(x + 6, y + 18, cw - 12, 30, WARNBG, WARNBD, 6))
                b.append(txt(x + cw / 2, y + 38, "✗", 15, WARNTX, "700", "middle"))
    yy = top + 3 * 76 + 10
    b.append(txt(40, yy + 22, "✓ = wired，探针实测能翻      ✗ = enabled 但未接通，选中即 503「真实翻译通道尚未配置」"
                              "      – = 该套餐不包含此引擎", 11.5, MUTED))
    b.append(rect(40, yy + 42, 1020, 110, GREENBG, GREENBD, 10, 1.2))
    b.append(txt(60, yy + 70, "✅ 三个套餐现在都能翻译：基础版靠 google，高级版有 deepseek / google，专业版 4 个都在", 12.5, GREENTX, "700"))
    b.append(txt(60, yy + 94, "⚠ 一个重要教训：上一版把「wired=true」直接当成「能用」，因此漏掉了两个坏通道 —— "
                              "deepseek 的端点被填成用量控制台页面（405），gpt 的模型不接受 temperature=0。", 11.5, BODY))
    b.append(txt(60, yy + 116, "现在改用 scripts/probe-translate-engines.js 真实调用厂商 API 验证，"
                               "「已接通」必须由实测背书。", 11.5, BODY))
    return svg(1100, yy + 148, "\n".join(b))


# ---------------------------------------------------------------- 图 7 时间线
def fig07():
    b = [head("距 10-01 上线 · 剩余事项排期建议",
              "四项阻断已全部解除；剩下的两件都不占关键路径，可按你的节奏推进")]
    b.append(line(70, 240, 1050, 240, "#CBD5E1", 3))
    days = [("09-25", "今天", 70), ("09-26", "T-5", 262), ("09-27", "T-4", 434),
            ("09-28", "T-3", 606), ("09-29", "T-2", 778), ("10-01", "上线", 1020)]
    for d, tag, x in days:
        b.append(line(x, 226, x, 254, "#94A3B8", 2))
        b.append(txt(x, 276, d, 12, DARK, "700", "middle"))
        b.append(txt(x, 294, tag, 10.5, MUTED, "400", "middle"))
    cards = [
        (70, 120, 380, "① 决定 5 个未接通引擎怎么处置", "接通（给凭据）或从套餐摘除（1 小时）\n不决定会持续产生「翻译坏了」的误报工单", WARNBG, WARNBD, WARNTX),
        (70, 336, 380, "② USDT 真实资金验证（1 天）", "影子模式已跑通，真实资金尚未走过\n涉及资金，建议上线前完成", WARNBG, WARNBD, WARNTX),
        (474, 120, 560, "③ 0.1.6 已上架，可直接分发", "Windows 安装版 / 免安装版 / macOS（arm64 + x64）\n均已登记并校验；签名问题已解决", GREENBG, GREENBD, GREENTX),
        (474, 336, 560, "④ 可选加固：我可以并行做完", "引擎探针接入监控 + 端点地址加校验\n不再等商户报障才发现通道坏了", BLUEBG, BLUEBD, "#1E3A8A"),
    ]
    for x, y, w, t, s, f, st, tx in cards:
        h = 168
        b.append(rect(x, y, w, h, f, st, 10, 1.2))
        b.append(txt(x + 16, y + 30, t, 13.5, tx, "700"))
        for j, ln in enumerate(s.split("\n")):
            b.append(txt(x + 16, y + 56 + j * 20, ln, 11.5, BODY))
    b.append(txt(40, 540, "★ 建议顺序：③ 已完成，可以直接对外分发；① 越早决定越省客服工单；"
                          "② 涉及真实资金，建议上线前走一遍", 12, DARK, "700"))
    b.append(txt(40, 562, "★ 本轮最大的收获不是「接通数从 2 变成 4」，而是把「已接通」的判定"
                          "从「看开关」换成了「实测调用」—— 上一版正是因此漏掉两个坏通道", 11.5, WARNTX))
    return svg(1100, 588, "\n".join(b))


# ---------------------------------------------------------------- 图 8 翻译与计费链路
def fig08():
    b = [head("翻译一次 · 从划词到落库的完整链路",
              "这条链路的工程质量高：幂等键 + 请求指纹 + Redis 锁 + 余额悲观锁 + 失败退款，重复扣费的入口都堵住了")]
    steps = [
        ("① 划词", "guest-inject.js", "选中文本 → 注入浮层", GRAYBG, GRAYBD, MUTED),
        ("② 取词", "preload 桥接", "text + incoming 方向", GRAYBG, GRAYBD, MUTED),
        ("③ 长度闸门", "main.js", ">5000 字符直接拒；纯 emoji 返回空", GRAYBG, GRAYBD, MUTED),
        ("④ 本地缓存", "translate-cache", "命中即返回，不产生扣费", GRAYBG, GRAYBD, MUTED),
        ("⑤ 服务端", "core-service", "套餐校验 → 引擎 wired 校验", BLUEBG, BLUEBD, "#1E3A8A"),
        ("⑥ 计费", "reservations", "幂等键 + Redis 锁 + 悲观锁预扣", WARNBG, WARNBD, WARNTX),
        ("⑦ 落库", "translate_logs", "非 refundable 才写流水 + char_used", GREENBG, GREENBD, GREENTX),
    ]
    y = 122
    for i, (t, sub, s, f, st, tx) in enumerate(steps):
        col = i % 2
        row = i // 2
        x = 40 + col * 520
        yy = y + row * 92
        w = 500 if i < 6 else 500
        b.append(rect(x, yy, w, 78, f, st, 8, 1.2))
        b.append(txt(x + 16, yy + 26, t, 13, tx, "700"))
        b.append(txt(x + 96, yy + 26, sub, 11, MUTED))
        b.append(txt(x + 16, yy + 50, s, 11, BODY))
        if col == 0:
            b.append(arrow(x + 510, yy + 39, x + 510 + 10, yy + 39, FAINT, 1.6))
        else:
            b.append(arrow(x + w / 2, yy + 78, x + 510, yy + 92 - 39, FAINT, 1.6, "4 4"))
    b.append(rect(40, y + 4 * 92 + 6, 1020, 96, "#FFFFFF", CARDBD, 10))
    b.append(txt(60, y + 4 * 92 + 34, "退款路径（关键）", 13, BLUE, "700"))
    b.append(txt(60, y + 4 * 92 + 58, "翻译失败 / 译文为空 / 译文与原文本一致 → 视为 refundable → 退回预扣，"
                                     "**不**写 translate_logs、**不**加 char_used、**不**加 translate_count", 11.5, BODY))
    b.append(txt(60, y + 4 * 92 + 80, "只有真正产生了有效译文才计费 —— 这一点由 254 项以上测试与 "
                                     "「同一 reservation 出现多行即异常」的重复扣费检测共同守住", 11.5, BODY))
    return svg(1100, y + 4 * 92 + 120, "\n".join(b))


if __name__ == "__main__":
    print("生成示意图：")
    write("01-未完成项全景.svg", fig01())
    write("02-上线阻断依赖.svg", fig02())
    write("03-后台运行状态机.svg", fig03())
    write("04-多开槽位隔离.svg", fig04())
    write("05-版本上架现状.svg", fig05())
    write("06-套餐引擎矩阵.svg", fig06())
    write("07-时间线排期.svg", fig07())
    write("08-翻译计费链路.svg", fig08())
    print("完成。")
