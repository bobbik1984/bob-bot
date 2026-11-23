import html
import os
import sys
from pathlib import Path

CSS = """
:root { color-scheme: light dark; --bg:#f7f9fc; --card:#ffffff; --text:#182030; --muted:#667085; --line:#e4e9f2; --accent:#2563eb; --head:#f0f4fa; }
@media (prefers-color-scheme: dark) { :root { --bg:#0e1117; --card:#161a22; --text:#e8ebf2; --muted:#98a2b3; --line:#272d39; --accent:#4b7dff; --head:#1f242e; } }
* { box-sizing:border-box; }
body { margin:0; padding:16px; background:var(--bg); color:var(--text); font:14px/1.55 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
.meta { color:var(--muted); font-size:12px; margin:0 0 12px; }
.tabs { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:12px; }
.tab { padding:6px 12px; border-radius:999px; border:1px solid var(--line); background:var(--card); color:var(--text); cursor:pointer; font-size:13px; }
.tab.on { background:var(--accent); color:#fff; border-color:var(--accent); }
.sheet { display:none; overflow:auto; background:var(--card); border:1px solid var(--line); border-radius:12px; }
.sheet.on { display:block; }
table { border-collapse:collapse; width:100%; font-size:13px; }
th, td { border:1px solid var(--line); padding:6px 10px; text-align:left; vertical-align:top; white-space:pre-wrap; max-width:360px; word-break:break-word; }
th { background:var(--head); font-weight:600; position:sticky; top:0; }
.doc-card, .slide { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px 18px; margin-bottom:14px; }
.slide-num { font-size:12px; font-weight:700; color:var(--accent); margin-bottom:8px; }
h1,h2,h3 { margin:12px 0 8px; }
p { margin:6px 0; }
pre { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; overflow:auto; white-space:pre-wrap; word-break:break-word; }
"""


def page(title: str, body: str, script: str = "") -> str:
    return (
        "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{html.escape(title)}</title><style>{CSS}</style></head>"
        f"<body>{body}{f'<script>{script}</script>' if script else ''}</body></html>"
    )


def render_table(rows, max_rows=200, max_cols=30):
    if not rows:
        return "<p class='meta'>（空表）</p>"
    total_rows = len(rows)
    sliced = rows[:max_rows]
    head = sliced[0][:max_cols]
    out = ["<table><thead><tr>"]
    for c in head:
        out.append(f"<th>{html.escape('' if c is None else str(c))}</th>")
    out.append("</tr></thead><tbody>")
    for r in sliced[1:]:
        out.append("<tr>")
        for i in range(len(head)):
            val = r[i] if i < len(r) else ""
            out.append(f"<td>{html.escape('' if val is None else str(val))}</td>")
        out.append("</tr>")
    out.append("</tbody></table>")
    if total_rows > max_rows:
        out.append(f"<p class='meta' style='padding:8px 12px'>仅预览前 {max_rows} 行（共 {total_rows} 行），完整数据请点击右上角下载。</p>")
    return "".join(out)


def render_excel(fp: Path) -> str:
    ext = fp.suffix.lower()
    sheets = []
    if ext == ".csv":
        import csv
        text = None
        for enc in ("utf-8-sig", "utf-8", "gbk"):
            try:
                text = fp.read_text(encoding=enc)
                break
            except Exception:
                continue
        if text is None:
            text = fp.read_text(encoding="utf-8", errors="replace")
        rows = list(csv.reader(text.splitlines()))
        sheets.append((fp.name, rows))
    elif ext == ".xls":
        import pandas as pd
        book = pd.read_excel(fp, sheet_name=None, header=None)
        for name, df in book.items():
            rows = df.fillna("").values.tolist()
            sheets.append((str(name), rows))
    else:
        import openpyxl
        wb = openpyxl.load_workbook(fp, read_only=True, data_only=True)
        for name in wb.sheetnames[:12]:
            ws = wb[name]
            rows = []
            for idx, r in enumerate(ws.iter_rows(values_only=True)):
                if idx > 205:
                    break
                if any(v is not None and str(v).strip() != "" for v in r):
                    rows.append(list(r))
            sheets.append((name, rows))
        wb.close()

    tabs = []
    panels = []
    for idx, (name, rows) in enumerate(sheets):
        cls = " on" if idx == 0 else ""
        tabs.append(f"<button class='tab{cls}' onclick='showSheet({idx})'>{html.escape(name)}</button>")
        panels.append(f"<div class='sheet{cls}' id='s{idx}'>{render_table(rows)}</div>")
    body = f"<div class='tabs'>{''.join(tabs)}</div>{''.join(panels)}"
    script = "function showSheet(n){document.querySelectorAll('.tab').forEach((b,i)=>b.classList.toggle('on',i===n));document.querySelectorAll('.sheet').forEach((s,i)=>s.classList.toggle('on',i===n));}"
    return page(fp.name, body, script)


def render_docx(fp: Path) -> str:
    import docx
    d = docx.Document(str(fp))
    parts = ["<div class='doc-card'>"]
    for p in d.paragraphs:
        txt = p.text.strip()
        if not txt:
            continue
        style = (p.style.name or "").lower() if p.style else ""
        if "heading 1" in style:
            parts.append(f"<h1>{html.escape(txt)}</h1>")
        elif "heading 2" in style:
            parts.append(f"<h2>{html.escape(txt)}</h2>")
        elif "heading" in style:
            parts.append(f"<h3>{html.escape(txt)}</h3>")
        else:
            parts.append(f"<p>{html.escape(txt)}</p>")
    for tbl in d.tables[:20]:
        rows = [[cell.text.strip() for cell in row.cells] for row in tbl.rows]
        parts.append(f"<div style='overflow:auto;margin:12px 0'>{render_table(rows, max_rows=100)}</div>")
    parts.append("</div>")
    return page(fp.name, "".join(parts))


def render_pptx(fp: Path) -> str:
    import pptx
    prs = pptx.Presentation(str(fp))
    parts = []
    for idx, slide in enumerate(prs.slides, 1):
        lines = []
        for shape in slide.shapes:
            if shape.has_text_frame:
                txt = shape.text_frame.text.strip()
                if txt:
                    lines.append(f"<p>{html.escape(txt)}</p>")
            elif shape.has_table:
                rows = [[c.text.strip() for c in r.cells] for r in shape.table.rows]
                lines.append(f"<div style='overflow:auto;margin:8px 0'>{render_table(rows, max_rows=50)}</div>")
        parts.append(f"<div class='slide'><div class='slide-num'>Slide {idx}</div>{''.join(lines) or '<p class=meta>（无文本内容）</p>'}</div>")
    return page(fp.name, "".join(parts) or "<p class='meta'>（空演示文稿）</p>")


def main():
    fp = Path(sys.argv[1])
    ext = fp.suffix.lower()
    if ext in (".xlsx", ".xls", ".csv"):
        out = render_excel(fp)
    elif ext == ".docx":
        out = render_docx(fp)
    elif ext == ".pptx":
        out = render_pptx(fp)
    else:
        txt = fp.read_text(encoding="utf-8", errors="replace")[:200000]
        out = page(fp.name, f"<pre>{html.escape(txt)}</pre>")
    sys.stdout.buffer.write(out.encode("utf-8"))


if __name__ == "__main__":
    main()
