#!/bin/bash
# start.sh — start the brain in the background. You can close the terminal.
# Run:  bash build/brain/start.sh
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || echo /usr/local/bin/node)"
PID_FILE="$DIR/brain.pid"
LOG="$DIR/brain.log"

if [ ! -x "$NODE" ]; then echo "node not found at $NODE"; exit 1; fi

# already running?
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Brain is already running (PID $(cat "$PID_FILE")). Use stop.sh to stop it."
  exit 0
fi
if curl -s -m 2 http://127.0.0.1:7878/ >/dev/null 2>&1; then
  echo "Port 7878 is already in use. Run stop.sh first, or check: lsof -i:7878"
  exit 1
fi

nohup "$NODE" "$DIR/brain.js" > "$LOG" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"
sleep 1
if kill -0 "$PID" 2>/dev/null && curl -s -m 2 http://127.0.0.1:7878/ >/dev/null 2>&1; then
  echo "✓ Brain started (PID $PID) — http://127.0.0.1:7878"
  echo "  Logs:  tail -f $LOG"
  echo "  Stop:  bash $DIR/stop.sh"
else
  echo "✗ Brain failed to start. Check $LOG"
  rm -f "$PID_FILE"
  exit 1
fi