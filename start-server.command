#!/usr/bin/env bash
# Launch the ThreeJS UE TPS/FPS dev server on macOS. Prefers python3, falls
# back to python on PATH. Double-clickable in Finder (.command) or run from a
# terminal: ./start-server.command
cd "$(dirname "$0")" || exit 1

if command -v python3 >/dev/null 2>&1; then
  python3 serve.py
elif command -v python >/dev/null 2>&1; then
  python serve.py
else
  echo "Python 3 is not installed. Install it from https://www.python.org/ or run: brew install python"
  read -r -p "Press Enter to close..."
  exit 1
fi
