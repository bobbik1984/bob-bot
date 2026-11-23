"""Private SQLite journal for the Go intake worker. Requests are passed on stdin."""
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import subprocess
import sys
import tempfile
import uuid
import zipfile

MAX_FILE = 12 << 20
MAX_EXPANDED = 24 << 20
MAX_TEXT = 32000
TYPES = {".txt", ".csv", ".xlsx", ".zip", ".pdf", ".png", ".jpg", ".jpeg"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks(
 id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE, name TEXT, original BLOB, source TEXT,
 instruction TEXT, status TEXT DEFAULT 'received', draft TEXT DEFAULT '{}', summary TEXT DEFAULT '',
 base_version INTEGER DEFAULT 0, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS facts(brand TEXT, month TEXT, data TEXT, version INTEGER, PRIMARY KEY(brand,month));
CREATE TABLE IF NOT EXISTS revisions(seq INTEGER PRIMARY KEY, brand TEXT, month TEXT, version INTEGER,
 task TEXT UNIQUE, before_json TEXT, after_json TEXT);
CREATE TABLE IF NOT EXISTS rules(brand TEXT PRIMARY KEY, meaning TEXT);
"""
def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)

def inspect_zip(z):
    entries = z.infolist()
    if len(entries) > 600 or sum(e.file_size for e in entries) > MAX_EXPANDED:
        raise ValueError("archiveLimit")
    for e in entries:
        path = PurePosixPath(e.filename.replace(chr(92), "/"))
        if path.is_absolute() or ".." in path.parts or e.flag_bits & 1:
            raise ValueError("archiveInvalid")
    return entries

def contents(name, raw, parts, photos, nested=False):
    ext = Path(name).suffix.lower()
    if ext in (".png", ".jpeg", ".jpg"):
        if len(photos) >= 6 or len(raw) > 6 << 20:
            raise ValueError("imageLimit")
        kind = "png" if ext == ".png" else "jpeg"
        photos.append("data:image/"+kind+";base64,"+base64.b64encode(raw).decode())
    elif ext == ".zip":
        if nested:
            raise ValueError("archiveNested")
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            members = [e for e in inspect_zip(z) if not e.is_dir() and not e.filename.startswith("__MACOSX/") and Path(e.filename).suffix.lower() in TYPES]
            if not 1 <= len(members) <= 24:
                raise ValueError("archiveLimit")
            for e in members:
                if e.file_size > MAX_FILE:
                    raise ValueError("archiveLimit")
                contents(e.filename, z.read(e), parts, photos, True)
    elif ext == ".xlsx":
        from openpyxl import load_workbook
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            inspect_zip(z)
        book = load_workbook(io.BytesIO(raw), read_only=True, data_only=True, keep_links=False)
        try:
            for sheet in book.worksheets[:6]:
                parts.append(sheet.title)
                for row in sheet.iter_rows(max_row=min(sheet.max_row or 100,100),max_col=min(sheet.max_column or 24,24),values_only=True):
                    parts.append(" | ".join(str(v)[:1000] for v in row if v is not None))
        finally:
            book.close()
    elif ext == ".pdf":
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root/"source.pdf"
            path.write_bytes(raw)
            info = subprocess.check_output(["pdfinfo",path],timeout=10,env={**os.environ,"LC_ALL":"C"},stderr=subprocess.DEVNULL).decode()
            count = int(re.search(r"(?m)^Pages:\s+(\d+)",info)[1])
            if count > 12:
                raise ValueError("pdfLimit")
            for n in range(1,count+1):
                page = ["-f",str(n),"-l",str(n)]
                txt = subprocess.check_output(["pdftotext",*page,"-enc","UTF-8",path,"-"],timeout=10,stderr=subprocess.DEVNULL).decode().strip()
                if len(txt) >= 20:
                    parts.append(txt)
                else:
                    subprocess.run(["pdftoppm",*page,"-singlefile","-scale-to","1400","-jpeg",path,root/"page"],timeout=12,check=True,stderr=subprocess.DEVNULL)
                    contents("page.jpg",(root/"page.jpg").read_bytes(),parts,photos)
    else:
        if ext not in (".csv",".txt"):
            raise ValueError("unsupported")
        try:
            txt = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            txt = raw.decode("gb18030")
        parts.append(txt)
    if sum(map(len,parts)) > MAX_TEXT:
        raise ValueError("textLimit")

def normalized(d):
    out = {k:str(d.get(k) or "").strip()[:n] for k,n in
           (("workflow",16),("brand",120),("month",7),("meaning",16),("quote",2000),("title",400),("due",32))}
    if not re.fullmatch(r"20\d{2}-(0[1-9]|1[0-2])",out["month"]):
        out["month"] = ""
    if out["meaning"] not in ("total","extra"):
        out["meaning"] = ""
    for k in ("threshold","multiplier","confidence"):
        value = d.get(k)
        out[k] = value if type(value) in (float,int) and math.isfinite(value) and 0 <= value <= 1e10 else None
    return out

def apply_campaign(db, task, d, remember=False, review=False):
    brand, month = d["brand"],d["month"]
    row = db.execute("SELECT data,version FROM facts WHERE brand=? AND month=?",(brand,month)).fetchone()
    old,ver = (json.loads(row[0]),row[1]) if row else ({},0)
    if review and task["base_version"] != ver:
        db.execute("UPDATE tasks SET draft=?,base_version=?,summary='changed' WHERE id=?",(encode(d),ver,task["id"]))
        return "changed"
    rule = db.execute("SELECT meaning FROM rules WHERE brand=?",(brand,)).fetchone()
    new = dict(old)
    for k in ("brand","month","threshold","multiplier","meaning","quote"):
        if d[k] is not None and d[k] != "":
            new[k] = d[k]
    if d["multiplier"] is not None and d["multiplier"] != old.get("multiplier") and not d["meaning"]:
        new.pop("meaning",None)
    if not new.get("meaning") and rule:
        new["meaning"] = rule[0]
    ready = brand and month and new.get("threshold") is not None and new.get("multiplier") and new.get("meaning") and d["quote"] and (review or (d["confidence"] or 0)>=0.85)
    if not ready:
        db.execute("UPDATE tasks SET status='needs_input',draft=?,base_version=?,summary='review' WHERE id=?",(encode(d),ver,task["id"]))
        return "needs_input"
    if remember:
        db.execute("INSERT OR REPLACE INTO rules VALUES(?,?)",(brand,new["meaning"]))
    db.execute("INSERT OR REPLACE INTO facts VALUES(?,?,?,?)",(brand,month,encode(new),ver+1))
    db.execute("INSERT INTO revisions(brand,month,version,task,before_json,after_json) VALUES(?,?,?,?,?,?)",(brand,month,ver+1,task["id"],encode(old),encode(new)))
    db.execute("UPDATE tasks SET status='done',draft=?,summary='campaign' WHERE id=?",(encode(new),task["id"]))
    return "done"

def workbook(db, version):
    from openpyxl import Workbook
    from openpyxl.styles import Font
    book = Workbook(); sheet = book.active; sheet.title = "品牌活动"
    sheet.append(["品牌","活动月份","门槛（元）","积分倍数","计算口径","原话","版本","来源任务"])
    for row in db.execute("""SELECT after_json,version,task FROM revisions r WHERE seq=(
     SELECT max(s.seq) FROM revisions s WHERE s.brand=r.brand AND s.month=r.month AND s.seq<=?)
     ORDER BY brand,month""",(version,)):
        d = json.loads(row[0])
        sheet.append([d["brand"],d["month"],d["threshold"],d["multiplier"],{"total":"含基础","extra":"额外加赠"}[d["meaning"]],d["quote"],row[1],row[2]])
        for cell in sheet[sheet.max_row]:
            if isinstance(cell.value,str):
                cell.data_type = "s"
    sheet.freeze_panes="C2";sheet.auto_filter.ref=sheet.dimensions
    for cell in sheet[1]:cell.font=Font(bold=True)
    for col,width in zip("ABCDEFGH",(24,14,16,14,16,64,10,34)):sheet.column_dimensions[col].width=width
    buf=io.BytesIO();book.save(buf)
    return buf.getvalue()

def run(db,op,p):
    if op == "put":
        raw=Path(p["path"]).read_bytes()
        sig=hashlib.sha256()
        for field in (p["name"].rsplit(".",1)[-1].lower().encode(),p["instruction"].encode(),raw):
            sig.update(len(field).to_bytes(8,"big"));sig.update(field)
        fp=sig.hexdigest()
        db.execute("INSERT OR IGNORE INTO tasks(id,fingerprint,name,original,source,instruction) VALUES(?,?,?,?,?,?)",(uuid.uuid4().hex,fp,p["name"],raw,p["source"],p["instruction"]))
        return dict(db.execute("SELECT id,status FROM tasks WHERE fingerprint=?",(fp,)).fetchone())
    if op == "next":
        row=db.execute("SELECT id FROM tasks WHERE status IN ('received','extracting','todo_pending') ORDER BY rowid LIMIT 1").fetchone()
        return row[0] if row else ""
    if op == "list":
        return [dict(r) for r in db.execute("SELECT id,name,status,summary,created FROM tasks ORDER BY rowid DESC LIMIT 100")]
    if op == "excel":
        last=db.execute("SELECT coalesce(max(seq),0) FROM revisions").fetchone()[0]
        v=int(p.get("version") or last)
        if not 0<=v<=last:raise ValueError("missing")
        return workbook(db,v)
    task=db.execute("SELECT id,name,status,instruction,source,draft,summary,base_version,created FROM tasks WHERE id=?",(p["id"],)).fetchone()
    if not task:raise ValueError("missing")
    t=dict(task);t["draft"]=json.loads(t["draft"])
    if op == "detail":
        rev=db.execute("SELECT seq,version,before_json,after_json FROM revisions WHERE task=?",(t["id"],)).fetchone()
        if rev:
            after=json.loads(rev[3])
            sources=db.execute("""SELECT r.version,r.task,t.name FROM revisions r JOIN tasks t ON t.id=r.task
                      WHERE r.brand=? AND r.month=? AND r.seq<=? ORDER BY r.seq""",(after["brand"],after["month"],rev[0]))
            t.update(revision=rev[0],version=rev[1],before=json.loads(rev[2]),after=after,sources=[dict(r) for r in sources])
        return t
    if op in ("original","extract"):
        raw=db.execute("SELECT original FROM tasks WHERE id=?",(t["id"],)).fetchone()[0]
        if op=="original":return raw
        if t["status"]=="todo_pending":return t
        db.execute("UPDATE tasks SET status='extracting' WHERE id=?",(t["id"],))
        parts=[];photos=[];contents(t["name"],raw,parts,photos)
        return dict(t,text="\n".join(parts),photos=photos)
    if op=="rule":
        if t["status"]!="done" or t["summary"]!="campaign":raise ValueError("stale")
        fact=t["draft"]
        db.execute("INSERT OR REPLACE INTO rules VALUES(?,?)",(fact["brand"],fact["meaning"]))
        return True
    if op=="retry":
        if t["status"] not in ("failed","needs_input"):raise ValueError("stale")
        note=p.get("instruction","").strip() or t["instruction"]
        db.execute("UPDATE tasks SET instruction=?,status='received',summary='' WHERE id=?",(note,t["id"]))
    elif op in ("save","resolve"):
        review=op=="resolve"
        if review and t["status"]!="needs_input":raise ValueError("stale")
        d=normalized(p["draft"])
        if d["workflow"]=="campaign":
            return apply_campaign(db,t,d,bool(p.get("remember")),review)
        status="todo_pending" if d["workflow"]=="todo" and d["title"] and (review or (d["confidence"] or 0)>=0.85) else "needs_input"
        db.execute("UPDATE tasks SET status=?,draft=?,summary=? WHERE id=?",(status,encode(d),"todo" if status=="todo_pending" else "review",t["id"]))
        return status
    elif op in ("done","failed"):
        db.execute("UPDATE tasks SET status=?,summary=? WHERE id=?",(op,p["summary"],t["id"]))
    else:raise ValueError("invalid")
    return True

def main():
    os.umask(0o077)
    directory,op=sys.argv[1:3]
    db=sqlite3.connect(Path(directory)/"inbox.sqlite3",timeout=15)
    db.row_factory=sqlite3.Row
    db.executescript(SCHEMA)
    try:
        with db:
            if op not in ("list","next","excel","original","detail","extract"):db.execute("BEGIN IMMEDIATE")
            result=run(db,op,json.load(sys.stdin))
        if isinstance(result,bytes):sys.stdout.buffer.write(result)
        else:sys.stdout.buffer.write(encode(result).encode("utf-8"))
    except (ValueError,KeyError,zipfile.BadZipFile,subprocess.SubprocessError) as exc:
        codes={"stale","missing","archiveLimit","archiveInvalid","imageLimit","archiveNested","pdfLimit","textLimit","unsupported"}
        sys.stderr.write(str(exc) if str(exc) in codes else "invalid")
        sys.exit(2)
    finally:db.close()

if __name__=="__main__":main()
