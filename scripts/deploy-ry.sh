#!/usr/bin/env bash
# Deploy bob-bot from this machine (x1t) to the RY VPS and verify https://ry.bobbik.org.
#
# RY is in mainland China and often cannot reach GitHub, so it never has to: this script sends the commit straight
# to RY over SSH (git's own delta transfer, into a side ref that does not touch RY's checked-out branch), then RY
# resets its checkout to that commit, installs dependencies if they changed, restarts bobbot.service and stamps
# the build. GitHub is only a backup copy, pushed from here as a courtesy and never required.
#
# Usage:
#   bash scripts/deploy-ry.sh               # deploy the commit you are on (clean tree, branch main)
#   bash scripts/deploy-ry.sh --no-github   # skip the backup push to GitHub
#   bash scripts/deploy-ry.sh --via-github  # old way: RY pulls from GitHub (only if RY can reach it)
#
# Overrides: BOB_RY_HOST, BOB_RY_DIR, BOB_RY_SERVICE, BOB_RY_URL, BOB_RY_BRANCH
set -euo pipefail

HOST="${BOB_RY_HOST:-ubuntu@82.157.186.181}"
APP_DIR="${BOB_RY_DIR:-/home/ubuntu/bob-bot}"
SERVICE="${BOB_RY_SERVICE:-bobbot}"
URL="${BOB_RY_URL:-https://ry.bobbik.org}"
BRANCH="${BOB_RY_BRANCH:-main}"

MODE="direct"; BACKUP=1
for arg in "$@"; do
  case "$arg" in
    --no-github)  BACKUP=0 ;;
    --via-github) MODE="github" ;;
    --no-push)    MODE="github"; BACKUP=0 ;; # the old flag: deploy what is already on GitHub
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
export GIT_SSH_COMMAND="ssh -o BatchMode=yes"

if [[ "$MODE" == "direct" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Working tree has uncommitted changes. Commit them first: only a commit is deployed." >&2
    exit 1
  fi
  if [[ "$(git rev-parse --abbrev-ref HEAD)" != "$BRANCH" ]]; then
    echo "You are not on $BRANCH. Switch to it, or set BOB_RY_BRANCH to deploy this branch." >&2
    exit 1
  fi
  if [[ "$BACKUP" == "1" ]]; then
    echo "==> backing up $BRANCH to GitHub (not required for the deploy)"
    timeout 60 git push origin "$BRANCH" 2>&1 | sed 's/^/    /' || echo "    GitHub push failed; deploying anyway. Push again later so the backup catches up."
  fi
  echo "==> sending $(git rev-parse --short HEAD) to $HOST"
  git push --force --quiet "$HOST:$APP_DIR" "HEAD:refs/deploy/$BRANCH"
  TARGET="refs/deploy/$BRANCH"
else
  echo "==> RY will pull $BRANCH from GitHub"
  TARGET="origin/$BRANCH"
fi

echo "==> deploying on $HOST ($APP_DIR)"
ssh -o BatchMode=yes "$HOST" bash -s -- "$APP_DIR" "$SERVICE" "$BRANCH" "$MODE" "$TARGET" <<'REMOTE'
set -euo pipefail
APP_DIR="$1"; SERVICE="$2"; BRANCH="$3"; MODE="$4"; TARGET="$5"
cd "$APP_DIR"
if [[ ! -d .git ]]; then
  echo "$APP_DIR is not a git checkout. Run the one-time setup from README (Deploy to RY)." >&2
  exit 1
fi

if [[ "$MODE" == "github" ]]; then git fetch --prune origin; fi
OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse "$TARGET")"

# Resetting throws away edits made directly on RY. Keep them as a patch first, so nothing is lost silently.
if ! git diff --quiet "$NEW" -- . ':(exclude)prototype/data'; then
  mkdir -p "$HOME/bob-bot-discarded"
  PATCH="$HOME/bob-bot-discarded/$(date +%Y%m%d-%H%M%S).patch"
  git diff "$NEW" -- . ':(exclude)prototype/data' > "$PATCH"
  echo "==> RY had changes that are not in this commit; saved as $PATCH, then replaced"
  git diff --stat "$NEW" | tail -8 | sed 's/^/    /'
fi
git reset --hard "$NEW"
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
