#!/usr/bin/env bash
# serve.sh — start a local static server for debugging the TalkForge-tts page
# Dev-only convenience (Python http.server on 127.0.0.1, no Host check). On Windows use TalkForge.bat.
#
# Usage:
#   chmod +x serve.sh
#   ./serve.sh          # serves on http://127.0.0.1:25000 (or next free port)
#   ./serve.sh 9000     # custom starting port

set -euo pipefail

START_PORT="${1:-25000}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "${DIR}"

# Find a free port starting from START_PORT
find_free_port() {
  local port="$1"
  while true; do
    if ! ss -ltn 2>/dev/null | grep -q ":${port} " && \
       ! netstat -ltn 2>/dev/null | grep -q ":${port} "; then
      # Double-check with a quick bind attempt
      if python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',$port)); s.close()" 2>/dev/null; then
        echo "$port"
        return
      fi
    fi
    port=$((port + 1))
    if [ "$port" -gt 65535 ]; then
      echo "No free port found" >&2
      exit 1
    fi
  done
}

PORT=$(find_free_port "$START_PORT")

if [ "$PORT" != "$START_PORT" ]; then
  echo "Port ${START_PORT} is in use. Using free port ${PORT} instead."
fi

echo "Serving ${DIR} at http://127.0.0.1:${PORT}/"
echo "Open: http://127.0.0.1:${PORT}/TalkForge-tts.html"
echo "Press Ctrl+C to stop."

if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server "${PORT}" --bind 127.0.0.1
elif command -v python >/dev/null 2>&1; then
  python -m http.server "${PORT}" --bind 127.0.0.1
else
  echo "Error: python3 or python is required." >&2
  exit 1
fi
