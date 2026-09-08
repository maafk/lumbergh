#!/usr/bin/env bash
# Package the HUD as a sideloadable .ehpk.
#
# A packed bundle is served from the Even app's own local origin, so it cannot reach
# Lumbergh with a relative /api request the way the browser and `evenhub qr` paths can —
# they load this page *from* Lumbergh. The URL therefore has to be baked in, and a pack
# without one produces an app that can only ever say "no link to lumbergh". So it is
# required, not defaulted.
#
#   ./pack.sh https://your-host.ts.net [output.ehpk]
set -euo pipefail
cd "$(dirname "$0")"

BASE="${1:-${LUMBERGH_URL:-}}"
OUT="${2:-$HOME/Downloads/lumbergh-hud.ehpk}"

if [[ -z "$BASE" ]]; then
  echo "usage: ./pack.sh <lumbergh-url> [output.ehpk]" >&2
  echo "   or: LUMBERGH_URL=https://host ./pack.sh" >&2
  echo >&2
  echo "The URL is baked into the bundle. Without it the packed app has no way to" >&2
  echo "reach Lumbergh and shows 'no link to lumbergh' on the glasses." >&2
  exit 2
fi
BASE="${BASE%/}"

if ! grep -qF "$BASE" plugin/app.json; then
  echo "warning: $BASE is not in plugin/app.json's network whitelist —" >&2
  echo "         the host may block the request. Add it and re-pack." >&2
fi

DIST="$(mktemp -d)"
trap 'rm -rf "$DIST"' EXIT

# Runtime files only: the vendored .d.ts files and the READMEs are documentation and
# have no business riding onto the glasses.
mkdir -p "$DIST/vendor"
cp index.html ./*.js "$DIST/"
cp vendor/*.js "$DIST/vendor/"
rm -f "$DIST/pack.sh"

cat > "$DIST/config.js" <<CONFIG
// Written by pack.sh — a packed bundle cannot reach Lumbergh same-origin.
export const LUMBERGH_URL = "$BASE";
CONFIG

evenhub pack plugin/app.json "$DIST" -o "$OUT"
echo "baked $BASE into $(basename "$OUT") ($(find "$DIST" -type f | wc -l) files)"
