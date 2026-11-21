import importlib.util
import io
from pathlib import Path
import sqlite3
import tempfile
import unittest
import zipfile

path = Path(__file__).resolve().parents[1]/"gateway/life/ingest_store.py"
spec = importlib.util.spec_from_file_location("intake_store",path)
store = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)

class InboxTest(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.raw=Path(folder.name)/"input"
        self.db=sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.row_factory=sqlite3.Row
        self.db.executescript(store.SCHEMA)

    def call(self,op,**p):
        with self.db:return store.run(self.db,op,p)

    def upload(self,text):
        self.raw.write_text(text,encoding="utf-8")
        return self.call("put",path=str(self.raw),name="chat.txt",instruction="",source="test")["id"]

    def test_review_amend_and_export(self):
        first=self.upload("12月活动 10000 元 5 倍")
        self.assertEqual(first,self.upload("12月活动 10000 元 5 倍"))
        base=dict(brand="A",month="2026-12",threshold=10000,multiplier=5,workflow="campaign",quote="10000 元 5 倍",confidence=.96)
        self.assertEqual(self.call("save",id=first,draft=base),"needs_input")
        self.assertEqual(self.call("resolve",id=first,draft=dict(base,meaning="total"),remember=True),"done")
        second=self.upload("单笔改为8000元")
        self.assertEqual(self.call("save",id=second,draft=dict(base,threshold=8000,multiplier=None,quote="改为8000元")),"done")
        detail=self.call("detail",id=second)
        self.assertEqual(detail["before"]["threshold"],10000)
        self.assertEqual(detail["after"]["multiplier"],5)
        self.assertEqual(len(detail["sources"]),2)
        from openpyxl import load_workbook
        for version,expected in [(1,10000),(2,8000)]:
            book=load_workbook(io.BytesIO(self.call("excel",version=version)))
            self.assertEqual(book.active.max_row,2)
            self.assertEqual(book.active["C2"].value,expected)
            book.close()
        with self.assertRaisesRegex(ValueError,"stale"):self.call("resolve",id=first,draft=base)

    def test_zip_and_retry(self):
        data=io.BytesIO()
        with zipfile.ZipFile(data,"w") as z:z.writestr("记录.txt","活动原话")
        parts=[];photos=[];store.contents("微信.zip",data.getvalue(),parts,photos)
        self.assertEqual(parts,["活动原话"])
        task=self.upload("核对海报")
        self.call("failed",id=task,summary="provider")
        self.call("retry",id=task,instruction="只记待办")
        self.assertEqual(self.call("next"),task)
        self.assertEqual(self.call("save",id=task,draft=dict(workflow="todo",title="核对海报",confidence=.99)),"todo_pending")
        self.assertEqual(self.call("extract",id=task)["status"],"todo_pending")
        self.assertEqual(self.db.execute("select count(*) from facts").fetchone()[0],0)

if __name__=="__main__":unittest.main()
