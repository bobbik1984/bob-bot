"""Build Bob Life on top of the owner's working Go gateway; publish one verified binary."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import urllib.request

VERSION = "0.4.0-life.1"


def run(cmd, cwd=None, env=None, **opts):
    return subprocess.run(cmd, cwd=cwd, env=env, check=True, **opts)


def git(repo, *args):
    return run(["git", "-C", str(repo), *args], stdout=subprocess.PIPE).stdout


# The service's live executable is the only file replaced. The same binary is copied
# back if either the local or public probe fails; data and credentials stay on the VM.
REMOTE = r'''set -eu
stage=$1
expected=$2
version=$3
public=$4
unit=bobbot.service
pid=$(systemctl show "$unit" -p MainPID --value)
test "$pid" -gt 1
live=$(readlink -f "/proc/$pid/exe")
wd=$(systemctl show "$unit" -p WorkingDirectory --value)
test -n "$wd" && test "$live" = "$wd/bobbot" && test -w "$wd"
test "$(stat -c %u "$live")" = "$(id -u)"
test "$(sha256sum "$stage" | cut -d ' ' -f1)" = "$expected"
exec 9>"$wd/.life-release.lock"
flock -n 9
backup=$(mktemp "$wd/bobbot.previous.XXXXXXXX")
cp -p "$live" "$backup"
new=$(mktemp "$wd/.bobbot.next.XXXXXXXX")
cp "$stage" "$new"; chmod --reference="$live" "$new"
switched=0
cleanup() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ "$rc" -ne 0 ] && [ "$switched" = 1 ]; then
    cp -p "$backup" "$new"; mv -f "$new" "$live"
    sudo -n systemctl restart "$unit"
    systemctl is-active --quiet "$unit"
    curl -fsS --max-time 6 http://127.0.0.1:8080/api/version >/dev/null
    echo "Previous binary restored" >&2
  fi
  rm -f "$stage" "$new"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
# Must already have working passwordless restart privileges before the switch.
sudo -n -l systemctl restart "$unit" >/dev/null
check(){
  curl -fsS --max-time 8 "$1/api/life/version" | python3 -c 'import json,sys; assert json.load(sys.stdin)["version"]==sys.argv[1]' "$version" &&
  test "$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' "$1/api/life/items")" = 401 &&
  curl -fsS --max-time 8 "$1/" | grep -q 'life-ui.js'
}
switched=1
mv -f "$new" "$live"
sudo -n systemctl restart "$unit"
ok=0
for delay in 1 2 3 5; do sleep "$delay"; if check http://127.0.0.1:8080; then ok=1; break; fi; done
test "$ok" = 1
check "$public"
echo "Verified $version at $public (previous binary: $backup)"
'''


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repo", type=Path, default=Path.cwd())
    p.add_argument("--ref", default="FETCH_HEAD")
    p.add_argument("--host", default="gcp")
    p.add_argument("--url", default="https://bot.bobbik.org")
    p.add_argument("--build-only", action="store_true")
    args = p.parse_args()
    repo = args.repo.resolve()
    ref = git(repo, "rev-parse", "--verify", args.ref + "^{commit}").decode("ascii").strip()
    if not re.fullmatch(r"[0-9a-f]{40}", ref) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@-]*", args.host):
        raise ValueError("Unexpected revision or SSH alias")
    if args.url != "https://bot.bobbik.org":
        raise ValueError("This release targets the GCP Bob gateway")
    with tempfile.TemporaryDirectory(prefix="bob-life-") as tmp:
        stage = Path(tmp)
        gw = stage / "gateway"
        gw.mkdir()
        # Stage the local working files, including the user's unpublished gateway work.
        source = repo / "gateway"
        for name in ("main.go", "features.go", "go.mod"):
            shutil.copy2(source / name, gw / name)
        for extra in source.glob("*.go"):
            if extra.name not in ("main.go", "features.go", "life_host.go"):
                shutil.copy2(extra, gw / extra.name)
        if (source/"go.sum").exists():
            shutil.copy2(source/"go.sum",gw/"go.sum")
        shutil.copytree(source / "public", gw / "public")
        for name in git(repo, "ls-tree", "-r", "--name-only", ref, "--", "gateway/life").decode("utf-8").splitlines():
            target = stage / name
            if not target.resolve().is_relative_to(gw / "life"):
                raise ValueError("Unexpected path")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(git(repo, "show", f"{ref}:{name}"))
        (gw / "life_host.go").write_bytes(git(repo,"show",ref+":scripts/life-host.go.in"))
        entry = gw / "main.go"
        code = entry.read_text(encoding="utf-8-sig")
        anchor = "mux := http.NewServeMux()"
        if code.count(anchor) != 1 or "mountLife(mux)" in code:
            raise ValueError("Unrecognized gateway entry; review integration first")
        entry.write_text(code.replace(anchor, anchor + "\n\tmountLife(mux)"), encoding="utf-8")
        run(["go", "mod", "edit", "-require=bobbot/life@v0.0.0", "-replace=bobbot/life=./life"], cwd=gw)
        run(["go","test","./..."],cwd=gw/"life")
        run(["go","test","./..."],cwd=gw)
        run(["go","build","-o",str(stage/"bobbot"),"."],cwd=gw,
            env=dict(os.environ,CGO_ENABLED="0",GOOS="linux",GOARCH="amd64"))
        if args.build_only:
            print("Build and unit tests passed.")
            return
        with urllib.request.urlopen(args.url+"/api/version",timeout=10) as response:
            before=json.load(response)
        if before.get("name")!="bobbot" or "Go" not in before.get("engine",""):
            raise ValueError("Public site is not the expected Bob Go gateway")
        ssh=["ssh","-o","BatchMode=yes","-o","StrictHostKeyChecking=yes","-o","ConnectTimeout=8",args.host]
        remote=run(ssh+["mktemp /tmp/bob-life.XXXXXXXX"],stdout=subprocess.PIPE).stdout.decode("ascii").strip()
        if not re.fullmatch(r"/tmp/bob-life\.[A-Za-z0-9]+",remote):
            raise ValueError("Unexpected staging path")
        binfile=stage/"bobbot"
        digest=hashlib.sha256(binfile.read_bytes()).hexdigest()
        run(["scp","-o","BatchMode=yes","-o","StrictHostKeyChecking=yes",str(binfile),args.host+":"+remote])
        command="bash -s -- "+" ".join(shlex.quote(s) for s in (remote,digest,VERSION,args.url))
        run(ssh+[command],input=REMOTE.encode("utf-8"))


if __name__=="__main__":
    main()
