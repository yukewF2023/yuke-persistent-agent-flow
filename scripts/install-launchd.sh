#!/usr/bin/env bash
# Installs the local orchestrator fallback: runs `scripts/orch.sh manager-now` every 6 h while the Mac is awake.
# Requires the local `claude` CLI to be logged in (run `claude login` once). Uninstall: launchctl unload ~/Library/LaunchAgents/com.yuke.agents-orchestrator.plist
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HOME/Library/LaunchAgents/com.yuke.agents-orchestrator.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cp "$HERE/scripts/launchd/com.yuke.agents-orchestrator.plist" "$DEST"
launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"
echo "installed $DEST (every 6 h). Logs: /tmp/agents-orchestrator.log"
echo "run now: launchctl start com.yuke.agents-orchestrator"
