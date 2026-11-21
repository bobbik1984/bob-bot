import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SCRIPTS=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("gcp_source",SCRIPTS/"deploy-gcp.py")
ship=importlib.util.module_from_spec(spec)
spec.loader.exec_module(ship)


class SourceDeliveryTest(unittest.TestCase):
    def test_package_local_edits_and_exclude_runtime_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            repo=root/"repo"
            files={"gateway/main.go":'package main\nfunc main(){mux := http.NewServeMux()}\n',
                   "gateway/features.go":"package main","gateway/go.mod":"module bobbot\ngo 1.23",
                   "gateway/public/index.html":"edited locally",
                   "gateway/life/ingest_store.py":"# embedded intake worker",
                   "gateway/life/life.go":'package life\nconst Version = "test"\n',
                   "gateway/life_host.go":"package main","gateway/data/config.json":"private",
                   "gateway/public/data/config.json":"private","gateway/public/data/private.png":"private","gateway/life/web/.env":"private"}
            for name,content in files.items():
                path=repo/name;path.parent.mkdir(parents=True,exist_ok=True)
                path.write_text(content,encoding="utf-8")
            gw=root/"gateway"
            ship.BUILD["stage_gateway"](repo,None,gw)
            z=root/"source.zip"
            ship.package(z,gw,{"ssh_alias":"test"})
            with zipfile.ZipFile(z) as pkg:
                self.assertEqual(pkg.read("gateway/life/ingest_store.py"), b"# embedded intake worker")
                self.assertEqual(pkg.read("gateway/public/index.html"),b"edited locally")
                self.assertEqual(pkg.read("gateway/main.go"), (repo/"gateway/main.go").read_bytes())
                self.assertNotIn("gateway/life/go.mod", pkg.namelist())
                self.assertFalse(any("data/" in p or ".env" in p for p in pkg.namelist()))
                self.assertEqual(json.loads(pkg.read("release.json"))["ssh_alias"],"test")
                self.assertIn("scripts/deploy-gcp.ps1",pkg.namelist())

    def test_pinned_revision_controls_all_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            names = ["go.mod", "main.go", "features.go", "life_host.go", "public/index.html", "life/life.go"]
            def git(*args):
                return subprocess.check_output(["git", "-C", str(repo), *args], encoding="utf-8")
            git("init", "-q")
            for name in names:
                path = repo / "gateway" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("committed " + name, encoding="utf-8")
            git("add", "gateway")
            git("-c", "user.name=fixture", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture")
            for name in names:
                (repo / "gateway" / name).write_text("edited " + name, encoding="utf-8")
            stage = root / "gateway"
            ship.BUILD["stage_gateway"](repo, "HEAD", stage)
            self.assertEqual(sorted(p.relative_to(stage).as_posix() for p in stage.rglob("*") if p.is_file()), sorted(names))
            for name in names:
                self.assertEqual((stage/name).read_text(encoding="utf-8"), "committed " + name)

    def test_reject_unknown_stage_before_scp(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);gw=root/"gateway";gw.mkdir()
            with patch.object(subprocess,"check_output",return_value="unexpected"),patch.object(subprocess,"run") as run:
                with self.assertRaises(ValueError):
                    ship.publish(gw,{"ssh_alias":"test"},root)
                run.assert_not_called()


if __name__=="__main__":
    unittest.main()
