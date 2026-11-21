"""Ship editable gateway sources and compile on the existing GCP instance."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import runpy
import shlex
import subprocess
import sys
import tarfile
import tempfile
import zipfile

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
BUILD = runpy.run_path(str(SCRIPTS / "deploy-life.py"))
RELEASE = runpy.run_path(str(SCRIPTS / "life_release.py"))
TOOLS = ("deploy-gcp.py","deploy-gcp.ps1","deploy-life.py","life_release.py","build-gcp.sh","life-host.go.in")


def package(output, gateway, target):
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED) as z:
        for path in sorted(gateway.rglob("*")):
            if path.is_file():
                z.write(path, "gateway/"+path.relative_to(gateway).as_posix())
        for name in TOOLS:
            z.write(SCRIPTS/name, "scripts/"+name)
        z.writestr("release.json", json.dumps(target, indent=2)+"\n")
        z.write(SCRIPTS/"gcp-source-guide.md", "scripts/gcp-source-guide.md")
        z.write(SCRIPTS/"gcp-source-guide.md", "README.md")
        z.writestr("Deploy-to-GCP.cmd", '@echo off\r\ncd /d "%~dp0"\r\npython -X utf8 scripts\\deploy-gcp.py deploy\r\nif errorlevel 1 (pause & exit /b 1)\r\npause\r\n')


def publish(gateway, target, build_dir):
    archive=build_dir/"gateway.tgz"
    # Only files collected by the source allowlist enter the archive.
    with tarfile.open(archive,"w:gz") as tar:
        for path in sorted(gateway.rglob("*")):
            if path.is_file():
                tar.add(path,arcname=path.relative_to(gateway).as_posix(),recursive=False)
    sha=hashlib.sha256(archive.read_bytes()).hexdigest()
    opts=["-o","BatchMode=yes","-o","StrictHostKeyChecking=yes","-o","ConnectTimeout=8"]
    host=target["ssh_alias"]
    ssh=["ssh",*opts,host]
    remote=subprocess.check_output(ssh+["mktemp /tmp/bob-source.XXXXXXXX"],encoding="utf-8").strip()
    if not re.fullmatch(r"/tmp/bob-source\.[A-Za-z0-9]+",remote):
        raise ValueError("Unexpected staging filename returned by remote")
    try:
        subprocess.run(["scp",*opts,str(archive),host+":"+remote],check=True)
        args=(remote,sha,target["version"],target["origin"],str(target["port"]))
        cmd="bash -s -- "+" ".join(map(shlex.quote,args))
        script=(SCRIPTS/"build-gcp.sh").read_text(encoding="utf-8")+"\n"+RELEASE["REMOTE"]
        subprocess.run(ssh+[cmd],input=script.encode("utf-8"),check=True)
    finally:
        subprocess.run(ssh+["rm -f -- "+shlex.quote(remote)],check=False)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("action",choices=["deploy","package"])
    p.add_argument("--repo",type=Path,default=ROOT)
    p.add_argument("--host")
    p.add_argument("--url")
    p.add_argument("--port",type=int)
    p.add_argument("--output",type=Path)
    opts=p.parse_args()
    repo=opts.repo.resolve()
    manifest=ROOT/"release.json"
    target=json.loads(manifest.read_text(encoding="utf-8")) if manifest.is_file() else {}
    host=opts.host or target.get("ssh_alias","")
    url=opts.url or target.get("origin","")
    port=opts.port if opts.port is not None else target.get("port",8080)
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.@-]*",host) or not re.fullmatch(r"https://[a-zA-Z0-9.-]+",url) or not 0<port<65536:
        p.error("Provide the SSH alias, HTTPS origin and gateway port from the service inventory.")
    if opts.action=="package" and not opts.output:p.error("Supply --output for a source ZIP")
    with tempfile.TemporaryDirectory(prefix="bob-gcp-") as stage:
        tmp=Path(stage)
        gateway=tmp/"gateway"
        BUILD["stage_gateway"](repo,None,gateway)
        code=(gateway/"life/life.go").read_text(encoding="utf-8")
        version=re.search(r'^const Version = "([a-zA-Z0-9.-]+)"$',code,re.MULTILINE)
        if not version:raise ValueError("Unrecognized Life module version")
        target={"ssh_alias":host,"origin":url,"port":port,"version":version[1]}
        if opts.action=="package":
            package(opts.output,gateway,target)
            print("Source package:",opts.output)
        else:
            publish(gateway,target,tmp)


if __name__=="__main__":
    try:
        main()
    except (OSError,ValueError,subprocess.SubprocessError) as err:
        sys.exit(str(err))
