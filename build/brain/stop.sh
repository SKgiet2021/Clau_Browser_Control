#!/bin/bash
# stop.sh — stop the background brain.
# Run:  bash build/brain/stop.sh
DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/brain.pid"
STOPPED=""
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill -9 "$PID" 2>/dev/null || true
    STOPPED="PID $PID"
  fi
  rm -f "$PID_FILE"
fi
# also catch any brain.js not tracked by the pid file
EXTRA="$(pgrep -f "brain.js" 2>/dev/null)"
if [ -n "$EXTRA" ]; then
  echo "$EXTRA" | xargs kill 2>/dev/null || true
  STOPPED="${STOPPED:+$STOPPED, }matched by name: $(echo $EXTRA | tr '\n' ' ')"
fi
if [ -n "$STOPPED" ]; then
  echo "✓ Brain stopped ($STOPPED)."
else
  echo "Brain wasn't running."
fi