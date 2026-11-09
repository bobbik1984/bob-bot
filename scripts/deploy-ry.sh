#!/usr/bin/env bash
# Deploy bob-bot from this machine (x1t) to the RY VPS and verify https://ry.bobbik.org.
#
# Flow: commit on x1t -> this script pushes main -> RY pulls, installs deps if needed,
# restarts bobbot.service, stamps the build -> health check here and through Cloudflare.
#
# Usage:
#   bash scripts/deploy-ry.sh            # push current main branch, then deploy
#   bash scripts/deploy-ry.sh --no-push  # deploy whatever is already on GitHub
#
# Overrides: BOB_RY_HOST, BOB_RY_DIR, BOB_RY_SERVICE, BOB_RY_URL, BOB_RY_BRANCH
set -euo pipefail

HOST="${BOB_RY_HOST:-ubuntu@82.157.186.181}"
APP_DIR="${BOB_RY_DIR:-/home/ubuntu/bob-bot}"
SERVICE="${BOB_RY_SERVICE:-bobbot}"
URL="${BOB_RY_URL:-https://ry.bobbik.org}"
BRANCH="${BOB_RY_BRANCH:-main}"

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

if [[ "${1:-}" != "--no-push" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Working tree has uncommitted changes. Commit them first, or use --no-push to deploy what is already on GitHub." >&2
    exit 1
  fi
  echo "==> pushing $BRANCH to GitHub"
  git push origin "$BRANCH"
fi

echo "==> deploying on $HOST ($APP_DIR)"
ssh -o BatchMode=yes "$HOST" bash -s -- "$APP_DIR" "$SERVICE" "$BRANCH" <<'REMOTE'
set -euo pipefail
APP_DIR="$1"; SERVICE="$2"; BRANCH="$3"
cd "$APP_DIR"
if [[ ! -d .git ]]; then
  echo "$APP_DIR is not a git checkout. Run the one-time setup from README (Deploy to RY)." >&2
  exit 1
fi

git fetch --prune origin
OLD="$(git rev-parse HEAD)"
git reset --hard "origin/$BRANCH"
NEW="$(git rev-parse HEAD)"
CHANGED="$(git diff --name-only "$OLD" "$NEW" || true)"

if [[ "$OLD" != "$NEW" ]] && grep -qE '^prototype/(package|package-lock)\.json$' <<<"$CHANGED"; then
  echo "==> dependencies changed, installing"
  ( cd prototype && npm install --no-audit --no-fund )
fi

# The page shows this stamp in Settings, so whoever opens the site can confirm the build.
mkdir -p prototype/data
printf '{"commit":"%s","at":"%s"}\n' "$NEW" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > prototype/data/build.json

if [[ "$OLD" != "$NEW" ]] || ! systemctl is-active --quiet "$SERVICE"; then
  echo "==> restarting $SERVICE"
  sudo systemctl restart "$SERVICE"
else
  echo "==> code unchanged, service left running"
fi

code=""
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8787/ || true)"
  [[ "$code" == "200" ]] && break
  sleep 1
done
echo "==> server health: HTTP ${code:-none} at $NEW"
if [[ "${code:-}" != "200" ]]; then
  echo "service did not come back up; check: journalctl -u $SERVICE -n 50" >&2
  exit 1
fi
REMOTE

echo "==> checking $URL"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$URL/" || true)"
echo "==> $URL => ${code:-no response}"
if [[ "${code:-}" != "200" ]]; then
  echo "public check failed; is cloudflared running on RY? systemctl status cloudflared" >&2
  exit 1
fi
curl -s --max-time 10 "$URL/api/version" | sed 's/^/==> live build: /'
echo
echo "Done."
