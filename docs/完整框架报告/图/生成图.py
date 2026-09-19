#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成《皮克斯多开翻译软件 · 完整框架与进度报告》的全部示意图（SVG）。

设计尺寸统一 1100 宽，输出时按 2 倍声明尺寸，sips 光栅化即得高清 PNG。
配色与 docx 正文一致：
  NAVY #0B1F3A  BLUE #2563EB  DARK #172033  BODY #2B3748  MUTED #667085
  浅蓝底 #EAF2FF / 边 #C7D6EE   灰行 #F8FAFC   提醒底 #FFF7E8 / 边 #FDE68A
"""
import os
import html

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


def esc(s):
    return html.escape(str(s), quote=False)


def rect(x, y, w, h, fill=CARD, stroke=CARDBD, rx=10, sw=1):
    st = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ""
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}"{st}/>'


def txt(x, y, s, size=13, color=BODY, weight="400", anchor="start", ls=None):
    w = f' font-weight="{weight}"' if weight != "400" else ""
    a = f' text-anchor="{anchor}"' if anchor != "start" else ""
    l = f' letter-spacing="{ls}"' if ls else ""
    return (f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}"'
            f'{w}{a}{l}>{esc(s)}</text>')


def line(x1, y1, x2, y2, color=FAINT, sw=1.5, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<path d="M{x1} {y1} L{x2} {y2}" stroke="{color}" stroke-width="{sw}" fill="none"{d}/>'


def arrow(x1, y1, x2, y2, color=FAINT, sw=1.6, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<path d="M{x1} {y1} L{x2} {y2}" stroke="{color}" stroke-width="{sw}" '
            f'fill="none" marker-end="url(#ah)"{d}/>')


def poly(points, color=FAINT, sw=1.5, dash=None, fill="none"):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    p = " ".join(f"{a},{b}" for a, b in points)
    return f'<polyline points="{p}" fill="{fill}" stroke="{color}" stroke-width="{sw}"{d}/>'


def svg(width, height, body, scale=2):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width*scale}" '
        f'height="{height*scale}" viewBox="0 0 {width} {height}" '
        f'font-family="PingFang SC, Hiragino Sans GB, Helvetica, Arial, sans-serif">\n'
        f'<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" '
        f'markerHeight="6" orient="auto-start-reverse">'
        f'<path d="M0 0 L10 5 L0 10 z" fill="{FAINT}"/></marker></defs>\n'
        f'<rect width="{width}" height="{height}" fill="{PAGEBG}"/>\n'
        + body + "\n</svg>\n"
    )


def head(title, sub, y=52):
    return txt(40, y, title, 26, "#0F172A", "700") + "\n" + txt(40, y + 26, sub, 14, MUTED)


def chip(x, y, w, h, label, value, fill=GRAYBG, stroke=GRAYBD, tx=BODY, badge=None):
    o = [rect(x, y, w, h, fill, stroke, 8)]
    o.append(txt(x + w / 2, y + h / 2 - 2, label, 12.5, tx, "700", "middle"))
    if value:
        o.append(txt(x + w / 2, y + h / 2 + 14, value, 10.5, tx, "400", "middle"))
    if badge:
        o.append(txt(x + w - 7, y + 13, badge, 11, tx, "700", "end"))
    return "\n".join(o)


def write(name, content):
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("  " + name)


# ---------------------------------------------------------------- 图 1 总体架构
def fig01():
    b = [head("Hello Pix 总体架构总览",
              "四个接入端 · 一台平台服务器 · 九条翻译通道 · 统一按字符计费")]
    # 接入端
    b.append(rect(40, 108, 1020, 118))
    b.append(txt(60, 132, "接入端（4 个）", 13, BLUE, "700"))
    ends = [("官网", "pixfanyi.com", BLUEBG, BLUEBD, "#1E3A8A"),
            ("商户端", "套餐 / 充值 / 工单", BLUEBG, BLUEBD, "#1E3A8A"),
            ("超管后台", "lindufyht.com", BLUEBG, BLUEBD, "#1E3A8A"),
            ("桌面客户端", "Electron · 35 个平台", GREENBG, GREENBD, GREENTX)]
    for i, (t, s, f, st, c) in enumerate(ends):
        x = 60 + i * 250
        b.append(rect(x, 144, 225, 64, f, st, 8))
        b.append(txt(x + 112, 172, t, 15, c, "700", "middle"))
        b.append(txt(x + 112, 193, s, 11, c, "400", "middle"))
    # 平台服务器
    b.append(rect(200, 256, 700, 130))
    b.append(txt(550, 282, "平台服务器 · Ubuntu 22.04 / 48 核", 13, BLUE, "700", "middle"))
    b.append(txt(550, 312, "Node.js 20 + Express 5 · 103 个 API 端点", 13, DARK, "400", "middle"))
    b.append(txt(550, 336, "PostgreSQL 16（40 张表）· Redis（会话 / 限流 / 验证码）", 13, DARK, "400", "middle"))
    b.append(txt(550, 360, "systemd 常驻 · nginx 反向代理 · Cloudflare 加速", 11.5, FAINT, "400", "middle"))
    for x in (172, 422, 672, 922):
        b.append(line(x, 226, x, 256, FAINT, 1.4) if x == 550 else
                 line(x, 208, x, 241, FAINT, 1.4))
    b.append(line(172, 241, 922, 241, FAINT, 1.4))
    b.append(line(550, 241, 550, 256, FAINT, 1.4))
    b.append(arrow(550, 386, 550, 424))
    b.append(txt(562, 410, "带 Idempotency-Key 的翻译请求", 11, MUTED))
    # 通道
    b.append(rect(40, 424, 1020, 166))
    b.append(txt(60, 450, "翻译通道（9 条，适配器全部已实现；✅ = 已接通，可直接计费）", 13, BLUE, "700"))
    rows = [("GPT", "¥5 / 百万字符", True), ("DeepSeek", "¥6 / 百万字符", True),
            ("Gemini", "¥12 / 百万字符", False), ("Grok", "¥29 / 百万字符", False),
            ("小牛 NiuTrans", "¥50 / 百万字符", False), ("Papago", "¥72 / 百万字符", False),
            ("AWS Translate", "¥100 / 百万字符", False), ("谷歌 Cloud", "¥134 / 百万字符", False),
            ("DeepL", "¥168 / 百万字符", False)]
    for i, (n, c, ok) in enumerate(rows):
        r, col = divmod(i, 5) if False else (i // 5, i % 5)
        x = 60 + col * 202
        y = 464 + r * 58
        b.append(chip(x, y, 188, 50, n, c,
                      GREENBG if ok else GRAYBG, GREENBD if ok else GRAYBD,
                      GREENTX if ok else BODY, "✅" if ok else None))
    b.append(rect(40, 606, 1020, 82, WARNBG, WARNBD, 10))
    b.append(txt(60, 632, "数据边界", 13, WARNTX, "700"))
    b.append(txt(60, 656, "· 平台持有：商户与子账号、套餐订单、充值、字符余额与流水、通道密钥、客户身份指纹", 12, "#78350F"))
    b.append(txt(60, 676, "· 客户端持有：各平台登录态（每线路独立加密分区）、代理配置、主题偏好、设备指纹", 12, "#78350F"))
    return svg(1100, 706, "\n".join(b))


# ------------------------------------------------------- 图 2 端与平台职责分工
def fig02():
    b = [head("端与平台的职责分工", "什么放在商户电脑上，什么必须放在平台上")]
    cols = [
        ("桌面客户端", "商户自己的电脑", GREENBG, GREENBD, GREENTX, [
            "多开容器：一条线路一个独立会话分区",
            "登录态与 Cookie 不出本机",
            "注入翻译浮层，鼠标划词即译",
            "代理（SOCKS5 / HTTP / SSH）逐线路绑定",
            "只上报翻译文本与线路心跳"]),
        ("平台服务", "唯一可信计算方", BLUEBG, BLUEBD, "#1E3A8A", [
            "持有九条翻译通道的 API 密钥",
            "按字符计费：预留 → 提交 / 回滚",
            "商户、子账号、套餐、订单、充值",
            "客户身份指纹与跨商户碰撞检测",
            "超管后台、审计日志、版本分发"]),
        ("商户内网", "规划中，尚未实现", "#F8FAFC", GRAYBD, MUTED, [
            "工单池本地化（设计已完成）",
            "客户聊天记录本地留存",
            "本地服务台与自动回复引擎",
            "与平台只交换计费凭据",
            "需要商户自备一台常驻机器"]),
    ]
    for i, (t, s, f, st, c, items) in enumerate(cols):
        x = 40 + i * 348
        b.append(rect(x, 108, 324, 300, f, st))
        b.append(txt(x + 20, 140, t, 17, c, "700"))
        b.append(txt(x + 20, 162, s, 11.5, c, "400"))
        b.append(line(x + 20, 178, x + 304, 178, st, 1))
        for j, it in enumerate(items):
            yy = 204 + j * 40
            b.append(f'<circle cx="{x+26}" cy="{yy-4}" r="3" fill="{c}"/>')
            # 手动折行：每行最多 15 个汉字宽
            b.append(txt(x + 38, yy, it[:16], 12, BODY))
            if len(it) > 16:
                b.append(txt(x + 38, yy + 16, it[16:32], 12, BODY))
    b.append(rect(40, 428, 1020, 96, GRAYBG, GRAYBD, 10))
    b.append(txt(60, 456, "为什么必须这样切", 13, "#334155", "700"))
    b.append(txt(60, 482, "翻译一定经过平台：通道密钥在平台手里，计费按字符，平台无法在不看到明文的前提下计费。", 12.5, BODY))
    b.append(txt(60, 504, "所以正确做法不是“不让平台看到”，而是“平台看过即弃”——只在内存中过一遍，不落库、不建立与客户身份的关联。", 12.5, BODY))
    return svg(1100, 546, "\n".join(b))


# --------------------------------------------------------- 图 3 多开隔离模型
def fig03():
    b = [head("多开隔离模型", "一条线路 = 一个独立分区，登录态互不可见")]
    b.append(rect(40, 108, 1020, 74))
    b.append(txt(60, 136, "同一个客户端进程", 14, DARK, "700"))
    b.append(txt(60, 160, "Electron 主进程 · 窗口管理 / 代理调度 / 翻译桥接 / 崩溃上报", 12, MUTED))
    b.append(arrow(550, 182, 550, 212))
    # 三条线路
    lanes = [("线路 1 · WhatsApp", "persist:pix-<账号>-whatsapp-green-0", "代理 A · 美国住宅"),
             ("线路 2 · Telegram", "persist:pix-<账号>-telegram-z-1", "代理 B · 德国机房"),
             ("线路 3 · Line", "persist:pix-<账号>-line-2", "直连 · 本地出口")]
    for i, (t, p, px) in enumerate(lanes):
        x = 40 + i * 348
        b.append(rect(x, 212, 324, 176, CARD, CARDBD))
        b.append(rect(x, 212, 324, 40, NAVY, None, 10))
        b.append(f'<rect x="{x}" y="{232}" width="324" height="20" fill="{NAVY}"/>')
        b.append(txt(x + 16, 238, t, 13.5, "#FFFFFF", "700"))
        b.append(txt(x + 16, 276, "会话分区", 11, MUTED))
        b.append(txt(x + 16, 296, p[:34], 10.5, BLUE, "700"))
        b.append(txt(x + 16, 322, "出网通道", 11, MUTED))
        b.append(txt(x + 16, 342, px, 12, BODY))
        b.append(txt(x + 16, 368, "Cookie / localStorage / IndexedDB", 10.5, FAINT))
    b.append(rect(40, 408, 1020, 128, GREENBG, GREENBD, 10))
    b.append(txt(60, 436, "隔离保证", 13, GREENTX, "700"))
    for i, s in enumerate([
        "分区名由账号 ID + 平台 ID + 序号三段拼成，换账号或换平台一定换分区，不存在复用。",
        "统一登出会按前缀遍历销毁该平台全部分区；重登不会继承上一次的登录态。",
        "代理按线路单独绑定，一条线路的出口 IP 变化不影响其他线路。",
        "翻译浮层只挂在本线路的 webContents 上，且校验发送方是否属于可信标签页。"]):
        b.append(txt(60, 462 + i * 20, "· " + s, 12, "#065F46"))
    b.append(rect(40, 552, 1020, 60, WARNBG, WARNBD, 10))
    b.append(txt(60, 578, "边界", 12.5, WARNTX, "700"))
    b.append(txt(96, 578, "分区解决的是“平台 A 看不到平台 B 的登录态”，不等于“同一台电脑上的线路互相不可见”。", 12, "#78350F"))
    b.append(txt(60, 600, "若一台电脑要跑多个互不信任的商户，仍需操作系统级隔离（独立系统用户或虚拟机）。", 12, "#78350F"))
    return svg(1100, 630, "\n".join(b))


# --------------------------------------------- 图 4 翻译链路与按字符计费时序
def fig04():
    b = [head("翻译链路与按字符计费", "预留 → 调用通道 → 提交或回滚，失败一定退字符")]
    actors = [("客户端", 90), ("平台 API", 320), ("Redis", 550), ("PostgreSQL", 780), ("翻译通道", 1010)]
    for name, x in actors:
        b.append(rect(x - 82, 112, 164, 40, NAVY, None, 8))
        b.append(txt(x, 138, name, 13, "#FFFFFF", "700", "middle"))
        b.append(line(x, 152, x, 596, "#E2E8F0", 1, "4 4"))
    steps = [
        (90, 320, 196, "① POST /translate/run（带 Idempotency-Key）", "left"),
        (320, 550, 232, "② 校验会话与字符余额", "left"),
        (550, 780, 268, "③ 写 translation_reservations（status=reserved）", "left"),
        (780, 320, 304, "④ 预留成功", "right"),
        (320, 1010, 340, "⑤ 调用通道适配器（from / to）", "left"),
        (1010, 320, 376, "⑥ 返回译文", "right"),
        (320, 780, 412, "⑦ 扣字符 + 写 translate_logs（commit）", "left"),
        (780, 320, 448, "⑧ 提交完成", "right"),
        (320, 90, 484, "⑨ 译文 + 剩余字符", "right"),
    ]
    for x1, x2, y, label, side in steps:
        if x1 < x2:
            b.append(arrow(x1, y, x2 - 4, y, BLUE if y < 400 else FAINT))
            b.append(txt(x1 + 8, y - 8, label, 11.5, BODY))
        else:
            b.append(arrow(x1, y, x2 + 4, y, FAINT, 1.4, "5 4"))
            b.append(txt(x2 + 8, y - 8, label, 11.5, MUTED))
    b.append(rect(320, 512, 700, 76, REDBG, REDBD, 10))
    b.append(txt(340, 538, "失败分支", 12.5, REDTX, "700"))
    b.append(txt(404, 538, "通道报错 / 超时 → 回滚预留，字符原路退回，translate_logs 记 released。", 12, "#7F1D1D"))
    b.append(txt(340, 562, "预留有 TTL；到点未提交的任务由清理任务自动回滚，不会出现“扣了字符没译文”。", 12, "#7F1D1D"))
    b.append(rect(40, 606, 1020, 84, BLUEBG, BLUEBD, 10))
    b.append(txt(60, 632, "计费口径", 13, BLUE, "700"))
    b.append(txt(60, 658, "计费字符 = 原文长度，中日韩统一表意文字（U+4E00–U+9FFF）每字按 2 计，其余每字符按 1 计；emoji 直接跳过不计费。", 12, BODY))
    b.append(txt(60, 680, "成本 = 通道 cost_per_million × 计费字符 ÷ 1,000,000；售价与折扣在超管后台维护，币种 USD。", 12, BODY))
    return svg(1100, 706, "\n".join(b))


# ------------------------------------------------------- 图 5 权限与数据边界
def fig05():
    b = [head("权限与数据边界", "三层账号 × 三条隔离线")]
    tiers = [
        ("超管 Superadmin", "lindufyht.com", NAVY, "#FFFFFF", [
            "全部商户 / 订单 / 充值 / 通道 / 密钥",
            "TOTP 双因子 + 10 个一次性恢复码",
            "改价、开关通道、看审计日志"]),
        ("商户 Merchant", "pixfanyi.com 商户端", BLUE, "#FFFFFF", [
            "自己的子账号、套餐、订单、字符余额",
            "给子账号分配字符（主账号扣减）",
            "自己的客户身份与碰撞提醒"]),
        ("子账号 Sub-account", "客户端登录", "#475569", "#FFFFFF", [
            "只能用被分配的字符额度",
            "只能看自己的翻译记录",
            "不能改价、不能看其他子账号"]),
    ]
    for i, (t, s, f, c, items) in enumerate(tiers):
        x = 40 + i * 348
        b.append(rect(x, 108, 324, 190, CARD, CARDBD))
        b.append(rect(x, 108, 324, 54, f, None, 10))
        b.append(f'<rect x="{x}" y="{142}" width="324" height="20" fill="{f}"/>')
        b.append(txt(x + 18, 132, t, 14.5, c, "700"))
        b.append(txt(x + 18, 152, s, 11, c, "400"))
        for j, it in enumerate(items):
            b.append(txt(x + 18, 192 + j * 34, "· " + it[:19], 11.5, BODY))
            if len(it) > 19:
                b.append(txt(x + 26, 208 + j * 34, it[19:38], 11.5, BODY))
    b.append(rect(40, 318, 1020, 132, BLUEBG, BLUEBD, 10))
    b.append(txt(60, 346, "三条隔离线（后端强制，前端隐藏按钮不算数）", 13, BLUE, "700"))
    for i, s in enumerate([
        "① 账号隔离：主账号与子账号各有一份字符余额，子账号的扣减不影响其他子账号。",
        "② 商户隔离：任何查询都必须带 workspace / merchant 条件，跨商户读取在 SQL 层就被拒绝。",
        "③ 后台隔离：/admin/* 路由全部走独立超管会话，与商户会话不共用 Cookie 与 CSRF。"]):
        b.append(txt(60, 372 + i * 24, s, 12, BODY))
    b.append(rect(40, 466, 1020, 108, WARNBG, WARNBD, 10))
    b.append(txt(60, 494, "已知的软肋（写在明处）", 13, WARNTX, "700"))
    b.append(txt(60, 520, "· translate_logs.snippet 目前会存原文前 300 字符，用于排查“翻错了”。这是设计取舍，不是漏洞。", 12, "#78350F"))
    b.append(txt(60, 542, "· 服务器磁盘未加密：拿到磁盘就等于拿到通道密钥与数据库。需要在一次停机窗口内做。", 12, "#78350F"))
    b.append(txt(60, 564, "· 客户身份指纹目前存在平台库里；工单池本地化完成后，这部分应当整体迁到商户内网。", 12, "#78350F"))
    return svg(1100, 592, "\n".join(b))


# ------------------------------------------------------------ 图 6 数据模型概览
def fig06():
    b = [head("数据模型概览", "40 张表，按职责分成六组")]
    groups = [
        ("账号与权限", BLUEBG, BLUEBD, "#1E3A8A",
         ["users", "sub_accounts", "merchant_identities", "platform_identities",
          "admins", "admin_recovery_codes", "admin_totp_events", "login_logs"]),
        ("商品与订单", GREENBG, GREENBD, GREENTX,
         ["packages", "package_engines", "orders", "order_details", "order_fans",
          "recharges", "character_transfers"]),
        ("翻译与计费", WARNBG, WARNBD, WARNTX,
         ["engines", "translate_logs", "translation_reservations",
          "character_transfers", "audit_logs"]),
        ("客户身份", "#F5F3FF", "#DDD6FE", "#5B21B6",
         ["customers", "customer_identities", "customer_owners",
          "customer_merchant_links", "customer_merge_candidates",
          "identity_match_events", "collision_events"]),
        ("会话与消息", "#F1F5F9", GRAYBD, "#334155",
         ["conversations", "messages", "messages_2026_09（分区）",
          "messages_2026_10（分区）", "client_lines"]),
        ("站点与分发", "#FEF2F2", REDBD, REDTX,
         ["faqs", "scripts", "short_links", "client_releases", "app_settings"]),
    ]
    for i, (t, f, st, c, items) in enumerate(groups):
        r, col = i // 3, i % 3
        x = 40 + col * 348
        y = 108 + r * 236
        b.append(rect(x, y, 324, 214, f, st))
        b.append(txt(x + 18, y + 30, t, 14, c, "700"))
        b.append(line(x + 18, y + 42, x + 306, y + 42, st, 1))
        for j, it in enumerate(items):
            b.append(txt(x + 18, y + 68 + j * 19, "· " + it, 11.5, BODY))
    b.append(rect(40, 592, 1020, 74, GRAYBG, GRAYBD, 10))
    b.append(txt(60, 618, "两条设计约定", 12.5, "#334155", "700"))
    b.append(txt(60, 642, "· messages 按月分区，保留期与分区清理由 cron 执行；聊天内容不参与任何计费与统计。", 12, BODY))
    b.append(txt(560, 642, "· app_settings 是 jsonb 键值表，键名只允许小写，用于价格、折扣、收款地址等可运营项。", 12, BODY))
    return svg(1100, 686, "\n".join(b))


# --------------------------------------------------------------- 图 7 进度看板
def fig07():
    b = [head("当前进度看板", "截至 2026-09-18，按模块统计完成度")]
    rows = [
        ("平台服务端", 100, "9 个服务 / 103 个 API / 254 项测试"),
        ("桌面客户端", 96, "多开、代理、翻译浮层、自动更新均已可用"),
        ("翻译通道", 22, "9 条适配器写完，2 条已接通计费"),
        ("商户端与官网", 100, "套餐、充值、订单、工单、团队管理已上线"),
        ("超管后台", 100, "25 个页面，含客户身份与合并、邮件、通道"),
        ("计费与充值", 90, "字符计费闭环已验证；TRC20 地址待填"),
        ("邮件服务", 20, "代码与后台就绪，等阿里云发信配置"),
        ("客户端分发", 100, "0.1.3 已构建并上传，SHA-256 校验一致"),
        ("安全与加密", 75, "通道密钥 / 密码 / TOTP 已加密；磁盘未加密"),
        ("工单池本地化", 10, "设计方案已完成，等确认后开发"),
    ]
    y0 = 116
    for i, (name, pct, note) in enumerate(rows):
        y = y0 + i * 46
        b.append(txt(40, y + 18, name, 12.5, DARK, "700"))
        b.append(rect(190, y + 4, 380, 18, "#E9EEF5", None, 9))
        color = "#16A34A" if pct >= 90 else ("#F59E0B" if pct >= 50 else "#DC2626")
        w = max(6, int(380 * pct / 100))
        b.append(rect(190, y + 4, w, 18, color, None, 9))
        b.append(txt(582, y + 18, f"{pct}%", 12, color, "700"))
        b.append(txt(626, y + 18, note, 11.5, MUTED))
    b.append(rect(40, y0 + 10 * 46 + 8, 1020, 78, BLUEBG, BLUEBD, 10))
    b.append(txt(60, y0 + 10 * 46 + 36, "整体判断", 13, BLUE, "700"))
    b.append(txt(60, y0 + 10 * 46 + 62, "代码侧已基本完工：40 张表、254 项测试全绿、真实翻译与充值链路都已跑通。", 12, BODY))
    b.append(txt(560, y0 + 10 * 46 + 62, "剩下的 20% 不是写代码，是配置与实机验证。", 12, "#B91C1C", "700"))
    return svg(1100, y0 + 10 * 46 + 96, "\n".join(b))


# --------------------------------------------------------- 图 8 卡点与依赖关系
def fig08():
    b = [head("卡点与依赖关系", "哪些必须你先做，哪些我可以并行推进")]
    # 左侧：必须用户操作
    b.append(rect(40, 108, 500, 364, REDBG, REDBD, 12))
    b.append(txt(60, 138, "必须由你操作（我无法代做）", 14, REDTX, "700"))
    user_items = [
        ("邮件服务", "P0", "阿里云邮件推送开通 + SPF / DKIM 解析 + 发信地址，", "5 个 SMTP 值填进后台 → 注册才能收到验证码"),
        ("TRC20 收款地址", "P0", "在超管后台「收款方式」填入 TRC20 地址", "不解决：用户充值没有收款去处"),
        ("客户端实机验证", "P0", "在 Windows 上连真实 Telegram / WhatsApp 实测", "不解决：不确定真实聊天窗口能否取到文本"),
        ("其余 7 条通道", "P1", "分别申请密钥并填入超管后台「翻译通道」", "不解决：只有 GPT / DeepSeek 可用"),
    ]
    yy = 168
    for name, lv, todo, risk in user_items:
        b.append(txt(60, yy, name, 12.5, "#7F1D1D", "700"))
        b.append(rect(196, yy - 13, 34, 18, "#DC2626" if lv == "P0" else "#F59E0B", None, 5))
        b.append(txt(213, yy, lv, 10.5, "#FFFFFF", "700", "middle"))
        b.append(txt(60, yy + 20, todo[:34], 11, BODY))
        if len(todo) > 34:
            b.append(txt(60, yy + 36, todo[34:68], 11, BODY))
        b.append(txt(60, yy + 56, risk[:36], 10.5, "#B91C1C"))
        yy += 78
    # 右侧：可并行
    b.append(rect(560, 108, 500, 364, GREENBG, GREENBD, 12))
    b.append(txt(580, 138, "我可以并行推进（不影响上线）", 14, GREENTX, "700"))
    dev_items = [
        ("工单池本地化", "设计已完成，等你选 A / B / C 方案与本地服务形态"),
        ("字段级加密接线", "模块已写好但没接线，等有真实数据再开"),
        ("磁盘加密", "需要一次停机窗口，建议等业务空档"),
        ("监控与告警", "脚本已就位，可以补一台外部探活"),
        ("第三方安全体检", "可约一次外部渗透，验证超管后台边界"),
    ]
    yy = 172
    for name, note in dev_items:
        b.append(txt(580, yy, name, 12.5, GREENTX, "700"))
        b.append(txt(580, yy + 18, note[:38], 11, BODY))
        if len(note) > 38:
            b.append(txt(580, yy + 34, note[38:76], 11, BODY))
        yy += 52
    # 底部：依赖链
    b.append(rect(40, 492, 1020, 132, GRAYBG, GRAYBD, 12))
    b.append(txt(60, 520, "依赖链：一条链断了，后面的都动不了", 13, "#334155", "700"))
    chain = ["邮件服务", "商户注册", "真实商户入驻", "充值下单", "真实计费"]
    for i, c in enumerate(chain):
        x = 60 + i * 196
        fill = REDBG if i == 0 else (BLUEBG if i < 3 else GREENBG)
        bd = REDBD if i == 0 else (BLUEBD if i < 3 else GREENBD)
        b.append(rect(x, 538, 168, 44, fill, bd, 8))
        b.append(txt(x + 84, 565, c, 12.5, DARK, "700", "middle"))
        if i < len(chain) - 1:
            b.append(arrow(x + 168, 560, x + 194, 560))
    b.append(txt(60, 608, "阻断点只有第一个：邮件服务不通，注册流程就走不完，后面整条链都是空的。", 12, "#B91C1C", "700"))
    return svg(1100, 644, "\n".join(b))


if __name__ == "__main__":
    print("生成 SVG：")
    write("01-总体架构.svg", fig01())
    write("02-端与平台职责.svg", fig02())
    write("03-多开隔离模型.svg", fig03())
    write("04-翻译与计费时序.svg", fig04())
    write("05-权限与数据边界.svg", fig05())
    write("06-数据模型概览.svg", fig06())
    write("07-进度看板.svg", fig07())
    write("08-卡点与依赖.svg", fig08())
    print("完成。")
