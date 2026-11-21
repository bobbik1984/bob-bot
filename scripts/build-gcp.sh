# Preamble to the standard release check and rollback script. Executed by bash -s.
set -euo pipefail
archive=$1
expected=$2
version=$3
origin=$4
port=$5
umask 077
unit=bobbot.service
pid=$(systemctl show -p MainPID --value "$unit")
wd=$(systemctl show -p WorkingDirectory --value "$unit")
test "$pid" -gt 1 && test -n "$wd"
test "$(readlink -f "/proc/$pid/exe")" = "$wd/bobbot"
test "$(sha256sum "$archive" | cut -d ' ' -f1)" = "$expected"
curl -fsS --max-time 6 "http://127.0.0.1:$port/api/version" |
  python3 -c 'import json,sys; x=json.load(sys.stdin); sys.exit(0 if x.get("name")=="bobbot" and "Go" in x.get("engine","") else "Unexpected gateway identity")'
sudo -n -l systemctl restart "$unit" >/dev/null

mkdir -p "$wd/.life-sources"
exec 8>"$wd/.life-sources/build.lock"
flock -n 8 || { echo "Another source build is active" >&2; exit 1; }
src=$(mktemp -d "$wd/.life-sources/release.XXXXXXXX")
echo "Building in $src"
tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$src"
cd "$src"
if [ -f life/ingest_store.py ]; then
    python3 -c 'import sqlite3, openpyxl'
    for converter in pdfinfo pdftotext pdftoppm; do command -v "$converter" >/dev/null; done
fi
go_bin=/usr/local/bin/go
if [ ! -x "$go_bin" ]; then go_bin=$(command -v go || true); fi
if [ -z "$go_bin" ] && [ -x /usr/local/go/bin/go ]; then go_bin=/usr/local/go/bin/go; fi
test -x "$go_bin" || { echo "Go compiler missing in SSH session" >&2; exit 1; }
"$go_bin" version
export CGO_ENABLED=0 GOTOOLCHAIN=local GOPROXY=off GOWORK=off
"$go_bin" test -p 1 ./...
"$go_bin" build -p 1 -trimpath -buildvcs=false -ldflags "-s -w -X bobbot/life.publicOrigin=$origin -X bobbot/life.sourceBuild=$expected" -o bobbot.candidate .
BOB_SOURCE_BUILD=$expected
BOB_SOURCE_DIR=$src
set -- "$src/bobbot.candidate" "$(sha256sum "$src/bobbot.candidate" | cut -d ' ' -f1)" "$version" "$origin" "$port"
