#!/bin/bash
# install.sh — make the brain auto-start at login and stay alive (macOS LaunchAgent).
# Run once:  bash build/brain/install.sh
# After this, the brain is always running. You never start it manually again.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || echo /usr/local/bin/node)"
PLIST="$HOME/Library/LaunchAgents/com.nocdp.brain.plist"
LABEL="com.nocdp.brain"

if [ ! -x "$NODE" ]; then
  echo "Could not find node at: $NODE"
  echo "Open a terminal, run 'which node', and edit this script's NODE path."
  exit 1
fi

launchctl unload "$PLIST" 2>/dev/null || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/brain.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/brain.log</string>
  <key>StandardErrorPath</key><string>$DIR/brain.log</string>
  <key>WorkingDirectory</key><string>$DIR</string>
</dict>
</plist>
EOF

launchctl load "$PLIST"
echo "✓ Installed LaunchAgent '$LABEL'."
echo "  The brain will start at login and restart automatically if it crashes."
sleep 1
if curl -s -m 2 http://127.0.0.1:7878/ >/dev/null 2>&1; then
  echo "✓ Brain is up at http://127.0.0.1:7878"
else
  echo "  Brain not responding yet — check the log:  cat $DIR/brain.log"
fi
echo ""
echo "Logs:     tail -f $DIR/brain.log"
echo "Stop now: launchctl unload $PLIST"
echo "Uninstall: bash $DIR/uninstall.sh"