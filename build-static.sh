#!/usr/bin/env bash
set -euo pipefail
rm -rf dist
mkdir -p dist
for f in index.html account.html blog.html contact.html disclaimer.html editor.html examples.html invite.html login.html meet.html privacy.html signup.html terms.html transformer.html manifest.webmanifest sw.js; do
  [ -f "$f" ] && cp "$f" dist/
done
for d in css js icons images assets; do
  [ -d "$d" ] && cp -R "$d" dist/
done
echo "Static publish ready"
ls dist | head
