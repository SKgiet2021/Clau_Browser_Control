#!/bin/bash
# uninstall.sh — remove the brain LaunchAgent (it will no longer auto-start).
PLIST="$HOME/Library/LaunchAgents/com.nocdp.brain.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "✓ Uninstalled. The brain will no longer auto-start at login."
echo "  (Any currently-running brain process from this script has been stopped.)"