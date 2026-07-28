#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi
echo "Starting RemoveCarBackground on http://127.0.0.1:5173"
exec .venv/bin/uvicorn backend:app --host 0.0.0.0 --port 5173 --reload
