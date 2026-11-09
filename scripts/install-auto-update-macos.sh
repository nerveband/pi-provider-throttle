#!/usr/bin/env bash
# Installs a macOS LaunchAgent that updates installed Pi packages once a day.
# Opt-in: run this only if you want automatic updates.
set -euo pipefail

LABEL="io.github.nerveband.pi-extension-update"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
PI_BIN="$(command -v pi || true)"

if [[ -z "$PI_BIN" ]]; then
  echo "Could not find pi on PATH. Install Pi first." >&2
  exit 1
fi

mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PI_BIN</string>
    <string>update</string>
    <string>--extensions</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>11</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/pi-extension-update.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/pi-extension-update.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
echo "Installed $LABEL. It runs pi update --extensions daily at 11:00."
echo "Log: $LOG_DIR/pi-extension-update.log"
echo "Remove it with: scripts/uninstall-auto-update-macos.sh"
