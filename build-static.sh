#!/usr/bin/env bash
# Publish clean URLs: /account not /account.html
# Also overwrite legacy *.html paths with redirect stubs (CDN may keep old files).
set -euo pipefail
rm -rf dist
mkdir -p dist

# Homepage
cp index.html dist/index.html

PAGES=(
  account blog contact disclaimer editor examples
  invite login meet privacy signup terms
)

write_redirect_stub() {
  local from="$1"  # e.g. account.html or transformer.html
  local to="$2"    # e.g. /account or /
  cat > "dist/${from}" <<EOF
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="0;url=${to}" />
  <link rel="canonical" href="https://removecarbackground.com${to}" />
  <title>Redirecting…</title>
  <script>
    location.replace("${to}" + location.search + location.hash);
  </script>
</head>
<body>
  <p><a href="${to}">Continue</a></p>
</body>
</html>
EOF
}

for page in "${PAGES[@]}"; do
  if [ -f "${page}.html" ]; then
    mkdir -p "dist/${page}"
    cp "${page}.html" "dist/${page}/index.html"
    # Kill legacy /page.html URL in address bar
    write_redirect_stub "${page}.html" "/${page}"
  fi
done

# transformer → homepage only
if [ -f transformer.html ]; then
  mkdir -p dist/transformer
  cp transformer.html dist/transformer/index.html
  write_redirect_stub "transformer.html" "/"
fi

# Real homepage last (do not replace with redirect stub)
cp index.html dist/index.html

for f in manifest.webmanifest sw.js; do
  [ -f "$f" ] && cp "$f" dist/
done

for d in css js icons images assets; do
  [ -d "$d" ] && cp -R "$d" dist/
done

echo "Static publish ready (clean URLs + .html redirects)"
ls dist/*.html 2>/dev/null | head -20 || true
find dist -maxdepth 2 -type f -name 'index.html' | sort | head -40
