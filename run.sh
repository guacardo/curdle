#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-8788}"

# Locate bun (PATH or fallback to ~/.bun/bin)
if command -v bun >/dev/null 2>&1; then
  BUN=bun
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
else
  echo "error: bun not found." >&2
  echo "install: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "error: ffmpeg not found." >&2
  case "$(uname -s)" in
    Linux*)  echo "install: sudo pacman -S ffmpeg   (or your distro's equivalent)" >&2 ;;
    Darwin*) echo "install: brew install ffmpeg" >&2 ;;
    *)       echo "install ffmpeg from https://ffmpeg.org/download.html" >&2 ;;
  esac
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "==> installing dependencies"
  "$BUN" install
fi

case "$(uname -s)" in
  Linux*)  OPENER="xdg-open" ;;
  Darwin*) OPENER="open" ;;
  *)       OPENER="" ;;
esac

URL="http://localhost:${PORT}"

if [ -n "$OPENER" ] && command -v "$OPENER" >/dev/null 2>&1; then
  ( sleep 0.6 && "$OPENER" "$URL" >/dev/null 2>&1 ) &
fi

PORT="$PORT" exec "$BUN" server/index.ts
