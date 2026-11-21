---
name: office-docs
description: 处理 PDF、Excel (.xlsx/.xls/.csv)、Word (.docx)、PPT (.pptx) 和 HTML 办公文档的读写、汇总、转换与报表生成。当用户上传办公文件或要求整理表格、提取 PDF、生成 Word/PPT/HTML 报告时使用。
---

# Office Docs — 办公文稿与报表处理规范

## 1. 预装环境（无需临时 pip install）
`python3` 运行环境已内置以下全部文稿处理库，可直接 `import` 使用：
- **PDF**：`pdfplumber`（表格提取首选）、`pymupdf`（极速全文/分页/图片提取）、`pypdf`、`reportlab`（生成 PDF）
- **Excel**：`openpyxl`（读写 `.xlsx` 与样式）、`pandas`、`xlrd`（旧 `.xls`）
- **Word**：`python-docx`（`import docx`）
- **PPT**：`python-pptx`（`import pptx`）
- **HTML**：`beautifulsoup4`（`from bs4 import BeautifulSoup`）、`lxml`

## 2. 文件路径与编码铁律
- **用户上传文件**：位于工作区 `uploads/` 目录（相对路径会在消息中给出）。
- **产出文件目录**：所有生成给用户的 Excel、PDF、Word、PPT、HTML 报告统一保存至工作区 `outputs/` 目录（如 `outputs/summary_20261121.xlsx`）。
- **编码规范**：
  - Python 读写文本/JSON/HTML 必须显式指定 `encoding='utf-8'`。
  - 若生成供 Excel 直接双击打开的 `.csv` 文件，必须使用 `encoding='utf-8-sig'`（UTF-8 with BOM）防中文乱码。

## 3. 交付与下载链接
生成产出文件后，务必在回复中附上可直接点击的站内链接（受 PIN 登录保护）：
- 在线预览（适合 PDF / HTML / 图片）：`[查看文件名](/api/workspace/file?path=outputs/文件名)`
- 直接下载（适合 Excel / Word / PPT）：`[下载文件名](/api/workspace/file?path=outputs/文件名&download=1)`
