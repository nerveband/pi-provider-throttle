#!/usr/bin/env bash
# Removes the optional daily update job for this package.
set -euo pipefail

LABEL="io.github.nerveband.pi-extension-update"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL."
