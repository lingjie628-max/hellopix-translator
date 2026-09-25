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
    b = [head("未完成项全景 · 截至 2026-09-25",
              "按上线阻断级别分档。红色 = 不做完不能上线；橙色 = 影响体验或收入；灰色 = 可延后")]
    lanes = [
        ("🔴  上线阻断", REDBG, REDBD, REDTX, 4, [
            ("Windows 真机验收", "唯一不能用自动化替代的一项", "你 + 我", "半天"),
            ("代码签名证书", "用户下载会被 Defender 拦", "你", "3–10 天"),
            ("基础版套餐无可用引擎", "4 个商户完全不能翻译", "你定方案", "1 小时"),
            ("macOS 0.1.5 未构建", "mac 用户停留在 0.1.3", "我", "1 小时"),
        ]),
        ("🟠  高", WARNBG, WARNBD, WARNTX, 3, [
            ("7 个引擎未接通", "可选中，选中即 503 报错", "你（凭据）", "按厂商"),
            ("USDT 真实资金未验", "自动充值只跑过影子模式", "你 + 我", "1 天"),
            ("客户端不写日志文件", "故障只能靠截图反查", "我", "半天"),
        ]),
        ("⚪  可延后", GRAYBG, GRAYBD, MUTED, 3, [
            ("旧工单后端接口残留", "前端已删，后端仍在", "我", "1 小时"),
            ("迁移 016 注释指错文件", "文档漂移，不影响运行", "我", "10 分钟"),
            ("免安装版未随版本更新", "仅影响便携用户", "我", "随下次构建"),
        ]),
    ]
    y = 116
    for label, bg, bd, tx, n, items in lanes:
        lane_h = 172
        b.append(rect(40, y, 1020, lane_h, bg, bd, 12, 1.2))
        b.append(txt(58, y + 30, label, 15, tx, "700"))
        gap = 14
        cw = (1020 - 36 - (n - 1) * gap) / n
        for i, (t, s, who, eta) in enumerate(items):
            cx = 58 + i * (cw + gap)
            cy = y + 48
            b.append(rect(cx, cy, cw, 106, "#FFFFFF", bd, 8))
            b.append(txt(cx + 12, cy + 24, t, 13.5, tx, "700"))
            for j, ln in enumerate(wrap(s, int(cw / 12.4))[:2]):
                b.append(txt(cx + 12, cy + 45 + j * 17, ln, 11, MUTED))
            b.append(txt(cx + 12, cy + 92, "谁做：" + who, 10.5, FAINT))
            b.append(txt(cx + cw - 12, cy + 92, eta, 10.5, tx, "700", "end"))
        y += lane_h + 14
    b.append(txt(40, y + 14, "「谁做」里的『你』= 必须你本人操作（真实账号 / 购买 / 商业决定）；"
                            "『我』= 我可以直接做完，不需要你介入", 11.5, FAINT))
    return svg(1100, y + 34, "\n".join(b))


# ---------------------------------------------------------------- 图 2 阻断项依赖
def fig02():
    b = [head("四项上线阻断 · 依赖关系与解锁顺序",
              "箭头的含义是「先做完上游，下游才动得了」")]
    # 节点
    nodes = [
        (60, 130, 300, 96, "① 代码签名证书", "企业实名核验 → 签发 → 重新构建签名", "3–10 天", REDBG, REDBD, REDTX),
        (400, 130, 300, 96, "③ 基础版套餐", "加一个已接通引擎，或下架该套餐", "1 小时", WARNBG, WARNBD, WARNTX),
        (740, 130, 300, 96, "④ macOS 0.1.5", "pack:mac 构建 + 登记", "1 小时", WARNBG, WARNBD, WARNTX),
        (230, 330, 640, 110, "② Windows 真机验收", "真实账号 · 真实消息 · 真实翻译 · 真实扣费证据", "半天（需你操作）",
         BLUEBG, BLUEBD, "#1E3A8A"),
    ]
    for x, y, w, h, t, s, eta, f, st, tx in nodes:
        b.append(rect(x, y, w, h, f, st, 10, 1.2))
        b.append(txt(x + w / 2, y + 30, t, 16, tx, "700", "middle"))
        for j, ln in enumerate(wrap(s, 34 if w > 500 else 22)[:2]):
            b.append(txt(x + w / 2, y + 54 + j * 17, ln, 11.5, MUTED, "400", "middle"))
        b.append(txt(x + w / 2, y + h - 12, eta, 11, tx, "700", "middle"))
    # 依赖箭头
    b.append(arrow(210, 226, 400, 330, REDTX, 2, "6 5"))       # ① → ②
    b.append(arrow(550, 226, 550, 330, WARNBD, 2, "6 5"))      # ③ → ②
    b.append(arrow(890, 226, 700, 330, WARNBD, 2, "6 5"))      # ④ → ②
    b.append(txt(300, 300, "未签名 → 装不上，无从验收", 11, REDTX, "700"))
    b.append(txt(560, 300, "验收账号需能翻译", 11, WARNTX, "700"))
    b.append(txt(760, 300, "mac 侧同理需验收", 11, WARNTX, "700"))
    # 收束
    b.append(rect(230, 500, 640, 76, GREENBG, GREENBD, 10, 1.2))
    b.append(txt(550, 528, "验收通过 → 0.1.5 保持上架（Windows）／补上 macOS", 14, GREENTX, "700", "middle"))
    b.append(txt(550, 552, "目标：2026-10-01 上线", 12, GREENTX, "400", "middle"))
    b.append(arrow(550, 440, 550, 500, GREENTX, 2))
    b.append(txt(40, 600, "★ 关键路径：① 签名证书等待期最长（3–10 天），今天就该启动 —— "
                          "它卡住的是②，而②是唯一无法用自动化测试替代的一项", 12, REDTX, "700"))
    return svg(1100, 632, "\n".join(b))


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
              "Windows 已到 0.1.5；macOS 仍停在 0.1.3（本次只构建了 Windows 目标）")]
    cols = [
        ("Windows x64", "0.1.5", True, [
            ("上架状态", "✅ enabled = true"),
            ("安装包", "HelloPix-Setup-0.1.5.exe"),
            ("SHA-256", "599af13b…034316"),
            ("本次新增", "后台运行 / 分区隔离"),
            ("", "消息归档 / 最小 900×560"),
            ("签名", "❌ 未签名（被 Defender 拦）"),
        ]),
        ("macOS arm64 / x64", "0.1.3", False, [
            ("上架状态", "✅ enabled = true"),
            ("安装包", "HelloPix-0.1.3-*.dmg"),
            ("说明", "仍是上一版"),
            ("缺失", "❌ 无后台运行"),
            ("", "❌ 无分区隔离修复"),
            ("待办", "pack:mac 构建 0.1.5"),
        ]),
    ]
    for i, (os_name, ver, ok, rows) in enumerate(cols):
        x = 40 + i * 520
        f, st, tx = (BLUEBG, BLUEBD, "#1E3A8A") if ok else (GRAYBG, GRAYBD, MUTED)
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
    b.append(rect(40, 468, 1020, 74, WARNBG, WARNBD, 10, 1.2))
    b.append(txt(60, 496, "⚠ 必须留痕的一次操作：0.1.5 曾在 14:16 被上架过一次，"
                          "但那份不含后台运行（功能代码 14:21 才写完）", 12, WARNTX, "700"))
    b.append(txt(60, 520, "已用「同 URL 换文件」修正：版本号 / URL / 数据库记录都没变。"
                          "代价是 14:16–14:37 之间下载过 0.1.5 的人拿到的是旧包，需重新下载", 11.5, WARNTX))
    return svg(1100, 562, "\n".join(b))


# ---------------------------------------------------------------- 图 6 套餐 × 引擎矩阵
def fig06():
    b = [head("套餐 × 翻译引擎矩阵 · 生产库实测",
              "9 个引擎里只有 deepseek 与 gpt 真正接通；基础版一个都没有 —— 这是仍存在的上线阻断项")]
    engines = ["deepseek", "gpt", "aws", "deepl", "gemini", "google", "grok", "niutrans", "papago"]
    wired = {"deepseek": True, "gpt": True}
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
        col = GREENTX if wired.get(e) else MUTED
        b.append(txt(x + cw / 2, top - 26, e, 10.5, col, "700", "middle"))
    for i, (name, cnt, has) in enumerate(pkgs):
        y = top + i * 76
        bad = bool(has) and not any(wired.get(e) for e in has)
        b.append(rect(40, y, 1020, 66, REDBG if bad else "#FFFFFF", REDBD if bad else CARDBD, 8))
        b.append(txt(60, y + 28, name, 14, REDTX if bad else DARK, "700"))
        b.append(txt(60, y + 48, f"{cnt} 个商户", 10.5, MUTED))
        if bad:
            b.append(txt(140, y + 28, "★ 无可用引擎", 11, REDTX, "700"))
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
    b.append(txt(40, yy + 22, "✓ = wired，能翻译      ✗ = enabled 但未接通，选中即 503「真实翻译通道尚未配置」"
                              "      – = 该套餐不包含此引擎", 11.5, MUTED))
    b.append(rect(40, yy + 42, 1020, 88, REDBG, REDBD, 10, 1.2))
    b.append(txt(60, yy + 70, "🔴 基础版 4 个商户一翻译就报错，且报的是「当前套餐未包含此通道」—— 商户看不懂为什么", 12.5, REDTX, "700"))
    b.append(txt(60, yy + 94, "三条路（任选）：① 给基础版加 deepseek（改 package_engines，最小改动）"
                              "　② 把 google/niutrans 真正接通（配凭据）　③ 暂时下架基础版", 11.5, BODY))
    b.append(txt(60, yy + 116, "上线前建议一并处理：7 个「可选中但未接通」的引擎，"
                               "要么接通、要么从套餐里摘掉 —— 否则客服会被「翻译坏了」的工单淹没", 11.5, BODY))
    return svg(1100, yy + 148, "\n".join(b))


# ---------------------------------------------------------------- 图 7 时间线
def fig07():
    b = [head("距 10-01 上线 · T-6 天排期建议",
              "关键路径是签名证书（等待期最长），不是代码 —— 代码今天就能做完")]
    b.append(line(70, 240, 1050, 240, "#CBD5E1", 3))
    days = [("09-25", "今天", 70), ("09-26", "T-5", 262), ("09-27", "T-4", 434),
            ("09-28", "T-3", 606), ("09-29", "T-2", 778), ("10-01", "上线", 1020)]
    for d, tag, x in days:
        b.append(line(x, 226, x, 254, "#94A3B8", 2))
        b.append(txt(x, 276, d, 12, DARK, "700", "middle"))
        b.append(txt(x, 294, tag, 10.5, MUTED, "400", "middle"))
    cards = [
        (70, 120, 380, "① 启动签名证书申请", "企业实名核验 → OV/EV 签发\n今天就递交，等待期 3–10 天", REDBG, REDBD, REDTX),
        (70, 336, 380, "② Windows 真机验收", "装包 → Telegram/WhatsApp 真实翻译\n→ 多开隔离 → 后台运行", BLUEBG, BLUEBD, "#1E3A8A"),
        (474, 120, 560, "③ 修基础版套餐（1 小时）", "给基础版加 deepseek，或下架该套餐\n同时决定 7 个未接通引擎怎么处置", WARNBG, WARNBD, WARNTX),
        (474, 336, 560, "④ 并行：macOS 0.1.5 构建 + 客户端日志", "pack:mac 打包并登记；\n给客户端补日志文件（当前故障查不到痕迹）", GREENBG, GREENBD, GREENTX),
    ]
    for x, y, w, t, s, f, st, tx in cards:
        h = 168
        b.append(rect(x, y, w, h, f, st, 10, 1.2))
        b.append(txt(x + 16, y + 30, t, 13.5, tx, "700"))
        for j, ln in enumerate(s.split("\n")):
            b.append(txt(x + 16, y + 56 + j * 20, ln, 11.5, BODY))
        b.append(txt(x + w - 16, y + h - 16, "", 11, tx, "700", "end"))
    b.append(txt(40, 540, "★ 我的建议顺序：今天同时启动 ①（等证书）与 ②（你验收）——"
                          "两者互不阻塞；③ 我随时能做，等你定方案；④ 我可以并行做完", 12, DARK, "700"))
    b.append(txt(40, 562, "★ 如果 10-01 是硬期限而证书来不及：先按「无签名 + 提交误报 + 公开校验值 + 安装说明」上线，"
                          "证书到位后再出一个签名版覆盖", 11.5, WARNTX))
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
