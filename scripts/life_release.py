"""Run a Bob Life release using Python's standard library and the owner's SSH alias."""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent

REMOTE = r'''set -eu
stage=$1
expected=$2
version=$3
public=$4
port=$5
unit=bobbot.service
pid=$(systemctl show "$unit" -p MainPID --value)
test "$pid" -gt 1
test "$(uname -m)" = x86_64
# Existing credentials are checked without printing or copying them.
python3 - "$pid" <<'PY'
import sys
from pathlib import Path
env = dict(p.split(b'=',1) for p in (Path('/proc')/sys.argv[1]/'environ').read_bytes().split(b'\0') if b'=' in p)
if not env.get(b"BOBBOT_PIN"):
    sys.exit("Set the owner PIN on the existing service before switching.")
PY
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
    curl -fsS --max-time 6 "http://127.0.0.1:$port"/api/version >/dev/null
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
  curl -fsS --max-time 8 "$1/api/life/version" | python3 -c 'import json,sys; v=json.load(sys.stdin); sys.exit(0 if v.get("version")==sys.argv[1] and (not sys.argv[2] or v.get("build")==sys.argv[2]) else 1)' "$version" "${BOB_SOURCE_BUILD:-}" &&
  test "$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' "$1/api/life/items")" = 401 &&
  curl -fsS --max-time 8 "$1/" | grep 'life-ui.js' >/dev/null &&
  curl -fsS --max-time 8 "$1/life.webmanifest" | python3 -c 'import json,sys; m=json.load(sys.stdin); sys.exit(0 if m.get("id")==m.get("scope")=="/" else 1)' &&
  curl -fsS --max-time 8 "$1/sw.js" | grep notificationclick >/dev/null &&
  curl -fsS --max-time 8 "$1/push-client.js" >/dev/null &&
  curl -fsS --max-time 8 "$1/life-calendar.mjs" >/dev/null
}
switched=1
mv -f "$new" "$live"
sudo -n systemctl restart "$unit"
ok=0
for delay in 1 2 3 5; do sleep "$delay"; if check "http://127.0.0.1:$port"; then ok=1; break; fi; done
test "$ok" = 1
check "$public"
if [ -n "${BOB_SOURCE_DIR:-}" ]; then
    link_dir=$(mktemp -d "$wd/.life-sources/link.XXXXXXXX")
    ln -s "$BOB_SOURCE_DIR" "$link_dir/current"
    mv -Tf "$link_dir/current" "$wd/.life-sources/current"
    rmdir "$link_dir"
fi
echo "Verified $version at $public (previous binary: $backup)"
'''


def verify(path, expected):
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("Invalid SHA-256 in release manifest")
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(part)
    if h.hexdigest() != expected:
        raise ValueError("Checksum mismatch for " + path.name)

def deploy(binary, host, origin, port, version, digest):
    if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@-]*", host)
        or not re.fullmatch(r"https://[a-zA-Z0-9.-]+", origin)
        or not 1 <= port <= 65535):
        raise ValueError("Invalid release destination")
    verify(binary, digest)
    ssh_options = ["-o","BatchMode=yes","-o","StrictHostKeyChecking=yes","-o","ConnectTimeout=8"]
    ssh = ["ssh",*ssh_options,host]
    baseline = subprocess.run(ssh+["curl -fsS --max-time 8 "+shlex.quote(f"http://127.0.0.1:{port}/api/version")],check=True,capture_output=False,stdout=subprocess.PIPE)
    identity = json.loads(baseline.stdout)
    if identity.get("name")!="bobbot" or "Go" not in identity.get("engine",""):
        raise ValueError("Target is not the Bob Go gateway")
    remote=subprocess.check_output(ssh+["mktemp /tmp/bob-life.XXXXXXXX"]).decode("ascii").strip()
    if not re.fullmatch(r"/tmp/bob-life\.[A-Za-z0-9]+",remote): raise ValueError("Unexpected staging path")
    try:
        subprocess.run(["scp",*ssh_options,str(binary),host+":"+remote],check=True)
        cmd="bash -s -- "+" ".join(shlex.quote(str(v)) for v in (remote,digest,version,origin,port))
        subprocess.run(ssh+[cmd],input=REMOTE.encode("utf-8"),check=True)
    finally:
        subprocess.run(ssh+["rm -f -- "+shlex.quote(remote)],check=False)

def preview(binary, version):
    if os.name!="nt": raise ValueError("The local preview binary targets Windows x64.")
    pin=getpass.getpass("Choose a PIN for this local session (at least 6 digits): ")
    if not re.fullmatch(r"\d{6,32}",pin): raise ValueError("Use 6 to 32 digits.")
    wd=Path(os.environ["LOCALAPPDATA"])/"BobLifePreview"
    wd.mkdir(parents=True,exist_ok=True)
    # One writer per preview data directory, including simultaneous double-clicks.
    import msvcrt
    with (wd/"session.lock").open("a+b") as lock:
        lock.seek(0)
        try: msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        except OSError: raise ValueError("A local Bob preview is already running.")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1",0)); port=sock.getsockname()[1]
        env=dict(os.environ, PORT=str(port), BOBBOT_LISTEN_HOST="127.0.0.1", BOBBOT_PIN=pin, BOBBOT_SECRET=secrets.token_hex(32))
        for key in ("GEMINI_API_KEY","GOOGLE_API_KEY"): env.pop(key,None)
        proc=subprocess.Popen([str(binary)],cwd=wd,env=env)
        try:
            url=f"http://127.0.0.1:{port}"
            for _ in range(50):
                if proc.poll() is not None: raise ValueError("Preview gateway stopped during startup.")
                try:
                    with urllib.request.urlopen(url+"/api/life/version",timeout=1) as f:
                        if json.load(f).get("version")!=version: raise ValueError("Preview version mismatch.")
                    break
                except OSError: time.sleep(.1)
            else: raise ValueError("Preview startup timed out.")
            print("Open",url,"and enter your chosen PIN. Press Ctrl+C to stop.",flush=True)
            webbrowser.open(url)
            proc.wait()
        finally:
            if proc.poll() is None:
                proc.terminate();proc.wait(timeout=8)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action",choices=["deploy","preview","verify"])
    parser.add_argument("--host",help="Override the configured SSH alias")
    args=parser.parse_args()
    data=json.loads((ROOT/"release.json").read_text(encoding="utf-8"))
    linux,win=ROOT/"bobbot",ROOT/"bobbot-local.exe"
    if args.action=="verify":
        for path in (linux,win): verify(path,data["sha256"][path.name])
        print("Verified",data["version"],"Linux and Windows SHA-256.")
    elif args.action=="deploy":
        deploy(linux,args.host or data["ssh_alias"],data["origin"],data["port"],data["version"],data["sha256"][linux.name])
    else:
        verify(win,data["sha256"][win.name]);preview(win,data["version"])
if __name__=="__main__":
    try: main()
    except KeyboardInterrupt: pass
    except (OSError,ValueError,subprocess.SubprocessError) as err:
        sys.exit(str(err))
