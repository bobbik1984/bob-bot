#!/usr/bin/env bash
# Build and update the RY owner's independent Go gateway.
set -euo pipefail
scripts=$(cd "$(dirname "$0")" && pwd)
exec python3 "$scripts/deploy-gcp.py" deploy --target "$scripts/../release-ry.json" "$@"
