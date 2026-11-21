"""Build Bob Life on top of the owner's working Go gateway; publish one verified binary."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import zipfile
import shutil
import subprocess
import tempfile

VERSION = "0.4.0-life.3"


def run(cmd, cwd=None, env=None, **opts):
    return subprocess.run(cmd, cwd=cwd, env=env, check=True, **opts)


def git(repo, *args):
    return run(["git", "-C", str(repo), *args], stdout=subprocess.PIPE).stdout


def stage_gateway(repo, ref, gw):
    """Combine working gateway files with local Life edits, or with Life from a pinned Git ref."""
    source=repo/"gateway"
    gw.mkdir()
    for name in ("main.go","features.go","go.mod"):
        if not (source/name).is_file(): raise ValueError(f"Missing gateway/{name}")
    for path in [*source.glob("*.go"),source/"go.mod",source/"go.sum"]:
        if path.is_file() and path.name!="life_host.go":
            if path.is_symlink() or not path.resolve().is_relative_to(source.resolve()): raise ValueError("Unexpected gateway source link")
            shutil.copy2(path,gw/path.name)

    public=source/"public"
    for path in public.rglob("*"):
        rel=path.relative_to(public)
        if not path.is_file() or any(part.startswith(".") or part.lower() in {"data","credentials","node_modules"} for part in rel.parts): continue
        if path.is_symlink() or not path.resolve().is_relative_to(public.resolve()): raise ValueError("Unexpected public asset link")
        if path.suffix.lower() not in {".html",".css",".js",".mjs",".webmanifest",".png",".ico",".svg",".woff2"}: continue
        dest=gw/"public"/rel
        dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(path,dest)
    if not (gw/"public/index.html").is_file(): raise ValueError("Missing classic gateway UI")
    inputs={p.relative_to(gw).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(gw.rglob("*")) if p.is_file()}
    if ref:
        names=git(repo,"ls-tree","-r","--name-only",ref,"--","gateway/life").decode("utf-8").splitlines()
        for name in names:
            dest=gw.parent/name
            if not dest.resolve().is_relative_to(gw/"life"): raise ValueError("Unexpected Life source path")
            dest.parent.mkdir(parents=True,exist_ok=True)
            dest.write_bytes(git(repo,"show",f"{ref}:{name}"))
        (gw/"life_host.go").write_bytes(git(repo,"show",ref+":scripts/life-host.go.in"))
    else:
        module=source/"life"
        selected=[*module.glob("*.go"), module/"go.mod", module/"go.sum", module/"calendar.test.mjs",
                  *[module/"web"/n for n in ("calendar.mjs","home.html","life.js","manifest.json","sw.js")]]
        for path in selected:
            if not path.is_file(): continue
            if path.is_symlink() or not path.resolve().is_relative_to(source.resolve()): raise ValueError("Unexpected Life source link")
            dest=gw/"life"/path.relative_to(module)
            dest.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(path,dest)
        adapter=source/"life_host.go"
        shutil.copy2(adapter if adapter.is_file() else repo/"scripts/life-host.go.in", gw/"life_host.go")
    if not (gw/"life/go.mod").is_file(): raise ValueError("Missing Life module. Use the source bundle or the mobile-life branch with your working gateway files.")
    entry=gw/"main.go"
    code=entry.read_text(encoding="utf-8-sig")
    anchor="mux := http.NewServeMux()"
    if code.count(anchor)!=1: raise ValueError("Unrecognized gateway entry")
    if "mountLife(mux)" not in code: code=code.replace(anchor,anchor+"\n\tmountLife(mux)")
    for var, fallback in (("pin",'log.Fatal("Owner PIN is required")'),("secret","secret = lifeSessionSecret()")):
        pattern=r'(if '+var+r' == "" \{\s*)'+var+r' = "[^"\n]*"'
        code=re.sub(pattern,lambda m:m[1]+fallback,code)
    entry.write_text(code,encoding="utf-8")
    return inputs


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repo", type=Path, default=Path.cwd())
    p.add_argument("--ref", default="FETCH_HEAD")
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
        entry=gw/"main.go"
        run(["go", "mod", "edit", "-require=bobbot/life@v0.0.0", "-replace=bobbot/life=./life"], cwd=gw)
        run(["go","test","./..."],cwd=gw/"life")
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
        manifest={"version":VERSION,"source":ref,"gateway_inputs_sha256":input_hashes,"origin":origin,"ssh_alias":args.host,"port":args.port,"sha256":{"bobbot":digest}}
        if args.bundle:
            code=entry.read_text(encoding="utf-8")
            pattern=r'(?m)^(\s*Addr:\s*)":" \+ cfg\.Port,'
            code,n=re.subn(pattern,r'\g<1>"127.0.0.1:" + cfg.Port,',code)
            if n!=1:raise ValueError("Could not bind local preview to loopback")
            entry.write_text(code,encoding="utf-8")
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
