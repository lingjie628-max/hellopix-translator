#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 内容.py 的正文打包成 .docx。

样式母版直接沿用 PIXS_运营增强中心_完整框架_V1.0.docx，
因此 styles.xml / theme / numbering / 页面设置与母版逐字节一致。
"""
import os
import shutil
import zipfile

import docx引擎
import 内容

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.expanduser("~/Desktop/PIXS_运营增强中心_完整框架_V1.0.docx")
OUT = os.path.join(HERE, docx引擎.OUTNAME)
DESKTOP_OUT = os.path.expanduser("~/Desktop/" + docx引擎.OUTNAME)

HEADER_TEXT = "PIXS · 皮克斯多开翻译软件｜完整产品框架与项目进度报告"
FOOTER_TEXT = "内部文档 · 2026-09-18 · 数据取自生产服务器与代码库实测"
DOC_TITLE = "皮克斯多开翻译软件 · 完整产品框架与项目进度报告"

W_NS = ('xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" '
        'xmlns:mo="http://schemas.microsoft.com/office/mac/office/2008/main" '
        'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
        'xmlns:mv="urn:schemas-microsoft-com:mac:vml" '
        'xmlns:o="urn:schemas-microsoft-com:office:office" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" '
        'xmlns:v="urn:schemas-microsoft-com:vml" '
        'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        'xmlns:w10="http://schemas.microsoft.com/office/word/2010/wordml" '
        'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" '
        'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" '
        'xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" '
        'xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" '
        'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
        'mc:Ignorable="w14 wp14"')

SECTPR = ('<w:sectPr><w:headerReference w:type="default" r:id="rId9"/>'
          '<w:footerReference w:type="default" r:id="rId10"/>'
          '<w:pgSz w:w="12240" w:h="15840"/>'
          '<w:pgMar w:top="893" w:right="979" w:bottom="893" w:left="979"'
          ' w:header="720" w:footer="720" w:gutter="0"/>'
          '<w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>')

KEEP_RELS = [
    ('rId1', 'customXml', '../customXml/item1.xml'),
    ('rId2', 'numbering', 'numbering.xml'),
    ('rId3', 'styles', 'styles.xml'),
    ('rId4', 'stylesWithEffects', 'stylesWithEffects.xml'),
    ('rId5', 'settings', 'settings.xml'),
    ('rId6', 'webSettings', 'webSettings.xml'),
    ('rId7', 'fontTable', 'fontTable.xml'),
    ('rId8', 'theme', 'theme/theme1.xml'),
    ('rId9', 'header', 'header1.xml'),
    ('rId10', 'footer', 'footer1.xml'),
]
BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"


def simple_part(tag, text, style):
    return ("<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n"
            f'<w:{tag} {W_NS}><w:p><w:pPr><w:pStyle w:val="{style}"/>'
            + ('<w:jc w:val="right"/>' if tag == "hdr" else '<w:jc w:val="center"/>')
            + '</w:pPr><w:r><w:rPr>'
              '<w:rFonts w:ascii="Noto Sans CJK SC" w:hAnsi="Noto Sans CJK SC"'
              ' w:eastAsia="Noto Sans CJK SC"/>'
            + (f'<w:color w:val="6E798B"/><w:sz w:val="17"/>' if tag == "hdr"
               else '<w:color w:val="828C9B"/><w:sz w:val="16"/>')
            + f'</w:rPr><w:t>{text}</w:t></w:r></w:p></w:{tag}>')


def core_xml():
    return ("<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n"
            '<cp:coreProperties'
            ' xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
            ' xmlns:dc="http://purl.org/dc/elements/1.1/"'
            ' xmlns:dcterms="http://purl.org/dc/terms/"'
            ' xmlns:dcmitype="http://purl.org/dc/dcmitype/"'
            ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            f'<dc:title>{DOC_TITLE}</dc:title>'
            '<dc:subject>产品框架与项目进度</dc:subject>'
            '<dc:creator>PIXS</dc:creator>'
            f'<dc:description>{DOC_TITLE}</dc:description>'
            '<cp:lastModifiedBy>PIXS</cp:lastModifiedBy><cp:revision>1</cp:revision>'
            '<dcterms:created xsi:type="dcterms:W3CDTF">2026-09-18T00:00:00Z</dcterms:created>'
            '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-09-18T00:00:00Z</dcterms:modified>'
            '<cp:category/></cp:coreProperties>')


def main():
    if not os.path.exists(TEMPLATE):
        raise SystemExit("母版不存在：" + TEMPLATE)

    body = 内容.build_body()
    document = ("<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n"
                f'<w:document {W_NS}><w:body>{body}{SECTPR}</w:body></w:document>')

    rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
    for rid, kind, target in KEEP_RELS:
        rels.append(f'<Relationship Id="{rid}" Type="{BASE}{kind}" Target="{target}"/>')
    for i, (rid, path) in enumerate(docx引擎.IMAGE_RELS, start=1):
        rels.append(f'<Relationship Id="{rid}" Type="{BASE}image" '
                    f'Target="media/img{i:02d}.png"/>')
    rels.append('</Relationships>')

    with zipfile.ZipFile(TEMPLATE) as zin:
        names = zin.namelist()
        skip = {"word/document.xml", "word/_rels/document.xml.rels",
                "word/header1.xml", "word/footer1.xml",
                "docProps/core.xml", "docProps/thumbnail.jpeg"}

        with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zout:
            for name in names:
                if name in skip or name.startswith("word/media/") or name.endswith("/"):
                    continue
                zout.writestr(name, zin.read(name))
            zout.writestr("word/document.xml", document)
            zout.writestr("word/_rels/document.xml.rels", "\n".join(rels))
            zout.writestr("word/header1.xml", simple_part("hdr", HEADER_TEXT, "Header"))
            zout.writestr("word/footer1.xml", simple_part("ftr", FOOTER_TEXT, "Footer"))
            zout.writestr("docProps/core.xml", core_xml())
            for i, (rid, path) in enumerate(docx引擎.IMAGE_RELS, start=1):
                with open(os.path.join(docx引擎.FIGDIR, path), "rb") as f:
                    zout.writestr(f"word/media/img{i:02d}.png", f.read())

    shutil.copy2(OUT, DESKTOP_OUT)
    size = os.path.getsize(OUT)
    print(f"已生成：{OUT}")
    print(f"已复制：{DESKTOP_OUT}")
    print(f"大小：{size/1024/1024:.2f} MB，内嵌图片 {len(docx引擎.IMAGE_RELS)} 张")


if __name__ == "__main__":
    main()
