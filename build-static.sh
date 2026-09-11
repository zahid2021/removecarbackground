#!/usr/bin/env bash
# Publish clean URLs: /account not /account.html
set -euo pipefail
rm -rf dist
mkdir -p dist

# Homepage
cp index.html dist/index.html

PAGES=(
  account blog contact disclaimer editor examples
  invite login meet privacy signup terms transformer
)

for page in "${PAGES[@]}"; do
  if [ -f "${page}.html" ]; then
    mkdir -p "dist/${page}"
    cp "${page}.html" "dist/${page}/index.html"
  fi
done

for f in manifest.webmanifest sw.js; do
  [ -f "$f" ] && cp "$f" dist/
done

for d in css js icons images assets; do
  [ -d "$d" ] && cp -R "$d" dist/
done

echo "Static publish ready (clean URLs)"
find dist -maxdepth 2 -type f -name 'index.html' | sort | head -40
