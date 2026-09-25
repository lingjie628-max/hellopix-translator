#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成《皮克斯多开翻译软件 · 完整产品框架与项目进度报告》.docx

不依赖任何第三方库：直接拼 OOXML。
以 PIXS_运营增强中心_完整框架_V1.0.docx 为样式母版（沿用其 styles.xml / theme /
numbering / header / footer），只替换正文与图片，因此排版与母版完全一致。
"""
import os
import re
import shutil
import zipfile
import html

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.expanduser("~/Desktop/PIXS_运营增强中心_完整框架_V1.0.docx")
OUTNAME = "Hello Pix-项目进度与未完成项报告.docx"
FIGDIR = os.path.join(HERE, "图")

FONT = "Noto Sans CJK SC"
NAVY, BLUE, DARK, BODY_C, MUTED, FAINT = "0B1F3A", "2563EB", "172033", "2B3748", "667085", "8A94A3"
CALLOUT_BG, CALLOUT_BD = "EAF2FF", "C7D6EE"
WARN_BG = "FFF7E8"
ROW_ALT = "F8FAFC"

CONTENT_TW = 10282          # 正文可用宽度（twips）
EMU_PER_TWIP = 914400 / 1440

RPR = (f'<w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}" w:eastAsia="{FONT}"/>')


# ------------------------------------------------------------------ 基础构件
def esc(s):
    return html.escape(str(s), quote=False)


def runs(text, size, color=BODY_C, bold=False, italic=False):
    """支持 **加粗** 行内标记。"""
    out = []
    for i, seg in enumerate(re.split(r"\*\*(.+?)\*\*", str(text))):
        if seg == "":
            continue
        b = bold or (i % 2 == 1)
        rpr = f'<w:rPr>{RPR}'
        if b:
            rpr += "<w:b/>"
        if italic:
            rpr += "<w:i/>"
        rpr += f'<w:color w:val="{color}"/><w:sz w:val="{size}"/></w:rPr>'
        out.append(f'<w:r>{rpr}<w:t xml:space="preserve">{esc(seg)}</w:t></w:r>')
    return "".join(out)


def p(text, size=21, color=BODY_C, after=100, before=0, line=324, jc=None, bold=False):
    pr = '<w:pPr><w:spacing'
    if before:
        pr += f' w:before="{before}"'
    pr += f' w:after="{after}" w:line="{line}" w:lineRule="auto"/>'
    if jc:
        pr += f'<w:jc w:val="{jc}"/>'
    pr += '</w:pPr>'
    return f"<w:p>{pr}{runs(text, size, color, bold)}</w:p>"


def h1(text, pb=False):
    """pb=True 时该标题另起一页（用 pageBreakBefore，避免产生空的断行 run）。"""
    brk = '<w:pageBreakBefore/>' if pb else ''
    return (f'<w:p><w:pPr>{brk}<w:pStyle w:val="Heading1"/>'
            f'<w:spacing w:before="280" w:after="120"/></w:pPr>'
            f'{runs(text, 36, NAVY, True)}</w:p>')


def h2(text):
    return (f'<w:p><w:pPr><w:pStyle w:val="Heading2"/>'
            f'<w:spacing w:before="200" w:after="110"/></w:pPr>'
            f'{runs(text, 28, BLUE, True)}</w:p>')


def h3(text):
    return (f'<w:p><w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr>'
            f'{runs(text, 23, DARK, True)}</w:p>')


def bullets(items, size=20):
    return "".join(
        f'<w:p><w:pPr><w:pStyle w:val="ListBullet"/><w:spacing w:after="40"/></w:pPr>'
        f'{runs(it, size)}</w:p>' for it in items)


def numbers(items, size=20):
    return "".join(
        f'<w:p><w:pPr><w:pStyle w:val="ListNumber"/><w:spacing w:after="40"/></w:pPr>'
        f'{runs(it, size)}</w:p>' for it in items)


def callout(label, lines, kind="info"):
    bg = WARN_BG if kind == "warn" else CALLOUT_BG
    lc = "B45309" if kind == "warn" else BLUE
    border = ('<w:tcBorders>'
              + "".join(f'<w:{s} w:val="single" w:sz="5" w:color="{CALLOUT_BD}"/>'
                        for s in ("top", "left", "bottom", "right", "insideH", "insideV"))
              + '</w:tcBorders>')
    inner = [f'<w:r><w:rPr>{RPR}<w:b/><w:color w:val="{lc}"/><w:sz w:val="22"/></w:rPr>'
             f'<w:t>{esc(label)}</w:t><w:br/></w:r>']
    inner.append(runs(lines, 20))
    return ('<w:tbl><w:tblPr><w:tblW w:type="auto" w:w="0"/><w:jc w:val="center"/>'
            '<w:tblLook w:firstColumn="1" w:firstRow="1" w:lastColumn="0" w:lastRow="0"'
            ' w:noHBand="0" w:noVBand="1" w:val="04A0"/></w:tblPr>'
            f'<w:tblGrid><w:gridCol w:w="{CONTENT_TW}"/></w:tblGrid>'
            f'<w:tr><w:tc><w:tcPr><w:tcW w:type="dxa" w:w="{CONTENT_TW}"/>'
            f'<w:shd w:fill="{bg}"/>{border}</w:tcPr>'
            f'<w:p><w:pPr><w:spacing w:after="0" w:line="300" w:lineRule="auto"/></w:pPr>'
            + "".join(inner) + '</w:p></w:tc></w:tr></w:tbl>'
            + p("", after=60, size=8))


def table(headers, rows, widths, size=18, head_size=19):
    total = sum(widths)
    widths = [int(w * CONTENT_TW / total) for w in widths]
    grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in widths)
    out = ['<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:type="auto" w:w="0"/>'
           '<w:jc w:val="center"/><w:tblLook w:firstColumn="1" w:firstRow="1"'
           ' w:lastColumn="0" w:lastRow="0" w:noHBand="0" w:noVBand="1" w:val="04A0"/>'
           '</w:tblPr>', f'<w:tblGrid>{grid}</w:tblGrid>']

    def cell(text, w, fill=None, head=False, align="left"):
        shd = f'<w:shd w:fill="{fill}"/>' if fill else ""
        color = "FFFFFF" if head else BODY_C
        sz = head_size if head else size
        al = "center" if head else align
        return (f'<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="{w}"/>{shd}'
                f'<w:vAlign w:val="center"/></w:tcPr>'
                f'<w:p><w:pPr><w:spacing w:after="0" w:line="290" w:lineRule="auto"/>'
                f'<w:jc w:val="{al}"/></w:pPr>'
                f'{runs(text, sz, color, head)}</w:p></w:tc>')

    out.append("<w:tr>" + "".join(cell(h, w, NAVY, True)
                                  for h, w in zip(headers, widths)) + "</w:tr>")
    for i, row in enumerate(rows):
        fill = ROW_ALT if i % 2 == 1 else None
        out.append("<w:tr>" + "".join(cell(c, w, fill)
                                      for c, w in zip(row, widths)) + "</w:tr>")
    out.append("</w:tbl>")
    out.append(p("", after=120, size=8))
    return "".join(out)


IMAGE_RELS = []


def figure(path, caption, max_w_in=7.14, max_h_in=5.2):
    full = os.path.join(FIGDIR, path)
    with open(full, "rb") as f:
        head = f.read(33)
    w, h = int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")
    cx = int(max_w_in * 914400)
    cy = int(cx * h / w)
    if cy > max_h_in * 914400:
        cy = int(max_h_in * 914400)
        cx = int(cy * w / h)
    rid = f"rIdImg{len(IMAGE_RELS) + 1}"
    IMAGE_RELS.append((rid, path))
    pid = len(IMAGE_RELS) + 100
    NS = ('xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
          'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"')
    drawing = (
        '<w:r><w:drawing>'
        f'<wp:inline {NS} distT="0" distB="0" distL="0" distR="0">'
        f'<wp:extent cx="{cx}" cy="{cy}"/>'
        f'<wp:effectExtent l="0" t="0" r="0" b="0"/>'
        f'<wp:docPr id="{pid}" name="Picture {pid}"/>'
        '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        '<pic:pic><pic:nvPicPr>'
        f'<pic:cNvPr id="{pid}" name="{esc(os.path.basename(path))}"/><pic:cNvPicPr/>'
        '</pic:nvPicPr><pic:blipFill>'
        f'<a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/>'
        f'<a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"/>'
        '</pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>')
    return ('<w:p><w:pPr><w:spacing w:before="120" w:after="60"/><w:jc w:val="center"/></w:pPr>'
            + drawing + '</w:p>'
            + f'<w:p><w:pPr><w:spacing w:after="200"/><w:jc w:val="center"/></w:pPr>'
            + runs("图 %d｜%s" % (len(IMAGE_RELS), caption), 18, MUTED) + '</w:p>')


def spacer(twips=120):
    return f'<w:p><w:pPr><w:spacing w:after="{twips}"/></w:pPr></w:p>'


def pagebreak():
    return ('<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>'
            '<w:r><w:br w:type="page"/></w:r></w:p>')
