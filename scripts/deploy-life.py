"""Build Bob Life on top of the owner's working Go gateway; publish one verified binary."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import zipfile
import subprocess
import tempfile



def run(cmd, cwd=None, env=None, **opts):
    return subprocess.run(cmd, cwd=cwd, env=env, check=True, **opts)


def git(repo, *args):
    return run(["git", "-C", str(repo), *args], stdout=subprocess.PIPE).stdout


def stage_gateway(repo, ref, gw):
    """Copy deployable Go sources and embedded assets, byte for byte from one revision."""
    source = repo / "gateway"
    gw.mkdir()
    asset_types = {".html", ".css", ".js", ".mjs", ".webmanifest", ".png", ".ico", ".svg", ".woff2"}
    def allowed(path):
        if any(p.startswith(".") or p.lower() in {"data", "credentials", "node_modules"} for p in path.parts):
            return False
        if path.parent in (Path("."), Path("life")) and path.suffix == ".go":
            return True
        if path.as_posix() in {"go.mod", "go.sum", "life/calendar.test.mjs", "life/push-client.test.mjs", "life/turn.test.mjs", "life/web/manifest.json"}:
            return True
        return (path.parts[0] == "public" or path.parts[:2] == ("life", "web")) and path.suffix in asset_types

    if ref:
        names = git(repo, "ls-tree", "-r", "-z", "--name-only", ref, "--", "gateway")
        paths = [Path(n.decode("utf-8")).relative_to("gateway") for n in names.split(bytes([0])) if n]
    else:
        # Limit traversal to source locations. Never enumerate the owner's runtime data.
        candidates = [*source.glob("*.go"), source/"go.mod", source/"go.sum", *(source/"life").glob("*.go"),
                      *(source/"life").glob("*.test.mjs"), *(source/"life/web").glob("*"), *(source/"public").rglob("*")]
        paths = [p.relative_to(source) for p in candidates if p.is_file()]
    hashes = {}
    for path in sorted(filter(allowed, paths)):
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("Unexpected gateway path")
        src = source/path
        if not ref and (src.is_symlink() or not src.resolve().is_relative_to(source.resolve())):
            raise ValueError("Unexpected gateway source link")
        data = git(repo, "show", f"{ref}:gateway/{path.as_posix()}") if ref else src.read_bytes()
        dest = gw/path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        hashes[path.as_posix()] = hashlib.sha256(data).hexdigest()
    required = {"go.mod", "main.go", "features.go", "life_host.go", "public/index.html", "life/life.go"}
    if required - hashes.keys():
        raise ValueError("Missing gateway sources: " + ", ".join(sorted(required - hashes.keys())))
    return hashes


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repo", type=Path, default=Path.cwd())
    p.add_argument("--ref", default="HEAD")
    p.add_argument("--host", default=None)
    p.add_argument("--url", default=None)
    operation = p.add_mutually_exclusive_group()
    operation.add_argument("--build-only", action="store_true")
    operation.add_argument("--bundle", type=Path, help="Create a ready-to-run Linux release and Windows loopback preview")
    p.add_argument("--port", type=int)
    args = p.parse_args()
    repo = args.repo.resolve()
    ref = git(repo, "rev-parse", "--verify", args.ref + "^{commit}").decode("ascii").strip()
    if not re.fullmatch(r"[0-9a-f]{40}", ref):
        raise ValueError("Unexpected revision or SSH alias")
    if not args.build_only:
        if not (args.host and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@-]*",args.host)
                and args.url and re.fullmatch(r"https://[A-Za-z0-9.-]+",args.url)
                and args.port and 0 < args.port <= 65535):
            raise ValueError("Provide the SSH alias, HTTPS origin and local port from the service inventory")
    with tempfile.TemporaryDirectory(prefix="bob-life-") as tmp:
        stage = Path(tmp)
        gw = stage / "gateway"
        input_hashes=stage_gateway(repo,ref,gw)
        run(["go","test","./..."],cwd=gw)
        target_env=dict(os.environ,CGO_ENABLED="0",GOARCH="amd64")
        linux_binary=stage/"bobbot"
        origin=args.url or "https://localhost"
        flags=["go","build","-buildvcs=false","-trimpath","-ldflags","-s -w -X bobbot/life.publicOrigin="+origin]
        run(flags+["-o",str(linux_binary),"."],cwd=gw,env=dict(target_env,GOOS="linux"))
        if args.build_only:
            print("Build and unit tests passed.")
            return
        runtime=stage/"life_release.py"
        runtime.write_bytes(git(repo,"show",ref+":scripts/life_release.py"))
        digest=hashlib.sha256(linux_binary.read_bytes()).hexdigest()
        manifest={"version":re.search(r'^const Version = "([a-zA-Z0-9.-]+)"$', (gw/"life/life.go").read_text(encoding="utf-8"), re.MULTILINE)[1],"source":ref,"gateway_inputs_sha256":input_hashes,"origin":origin,"ssh_alias":args.host,"port":args.port,"sha256":{"bobbot":digest}}
        if args.bundle:
            win_binary=stage/"bobbot-local.exe"
            run(flags+["-o",str(win_binary),"."],cwd=gw,env=dict(target_env,GOOS="windows"))
            manifest["sha256"][win_binary.name]=hashlib.sha256(win_binary.read_bytes()).hexdigest()
        (stage/"release.json").write_text(json.dumps(manifest,indent=2)+"\n",encoding="utf-8")
        if args.bundle:
            out=args.bundle.resolve()
            with zipfile.ZipFile(out,"x",compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
                for name in ("bobbot","bobbot-local.exe","life_release.py","release.json"): z.write(stage/name,name)
                for filename,action in (("Deploy-to-GCP.cmd","deploy"),("Try-on-Windows.cmd","preview")):
                    z.writestr(filename,'@echo off\r\ncd /d "%~dp0"\r\npython -X utf8 life_release.py '+action+'\r\nif errorlevel 1 (pause & exit /b 1)\r\npause\r\n')
                z.writestr("README.md",git(repo,"show",ref+":gateway/life/README.md"))
            print(f"Ready: {out}")
        else:
            run([sys.executable,str(runtime),"deploy"])


if __name__=="__main__":
    main()
