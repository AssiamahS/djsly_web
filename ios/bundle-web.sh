#!/usr/bin/env bash
# Copies the static web app (repo root) into the iOS bundle folder. Run from the repo root.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/ios/DJ5ly/Resources/web"
rm -rf "$DEST"; mkdir -p "$DEST"
rsync -a --exclude '.git' --exclude '.github' --exclude 'ios' --exclude 'infra' --exclude 'server' --exclude 'tools' --exclude 'README.md' --exclude 'sw.js' "$ROOT/" "$DEST/"
echo "bundled $(find "$DEST" -type f | wc -l | tr -d ' ') files into $DEST"
