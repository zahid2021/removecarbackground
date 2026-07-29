#!/usr/bin/env bash
set -euo pipefail
rm -rf dist
mkdir -p dist
# Copy public frontend assets only
cp -R index.html *.html css js icons images assets manifest.webmanifest sw.js dist/ 2>/dev/null || true
# Prefer relative config already pointing at API host
echo "Static publish ready in dist/"
