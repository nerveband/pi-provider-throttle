#!/usr/bin/env bash
# Installs a macOS LaunchAgent that updates this Pi package once a day.
# Opt-in: run this only if you want automatic updates.
#
# launchd does not read your shell profile, so this writes explicit paths for
# node and Pi. Plain `pi` would fail with "env: node: No such file or directory".
set -euo pipefail

LABEL="io.github.nerveband.pi-extension-update"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
PRINT_ONLY="${1:-}"

NODE_BIN="$(command -v node || true)"
PI_BIN="$(command -v pi || true)"

if [[ -z "$NODE_BIN" || -z "$PI_BIN" ]]; then
  echo "Could not find node and pi on PATH. Install Pi first." >&2
  exit 1
fi

# Pi ships as a node script with a "#!/usr/bin/env node" line, so resolve the
# script itself and run it with an absolute node path.
PI_SCRIPT="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$PI_BIN")"
NODE_DIR="$(dirname "$NODE_BIN")"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"

if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Node $NODE_MAJOR is too old. Pi needs Node 20 or newer." >&2
  exit 1
fi

PLIST_BODY="$(cat <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PI_SCRIPT</string>
    <string>update</string>
    <string>git:github.com/nerveband/pi-provider-throttle</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$HOME</string>
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
)"

if [[ "$PRINT_ONLY" == "--print" ]]; then
  echo "$PLIST_BODY"
  exit 0
fi

mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
printf '%s\n' "$PLIST_BODY" > "$PLIST"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$UID" "$PLIST" || {
  echo "Could not load the job. Run this from a logged-in desktop session, not a headless shell." >&2
  exit 1
}
echo "Installed $LABEL. It updates pi-provider-throttle daily at 11:00."
echo "Node:   $NODE_BIN"
echo "Pi:     $PI_SCRIPT"
echo "Log:    $LOG_DIR/pi-extension-update.log"
echo "Test:   launchctl kickstart -k gui/$UID/$LABEL"
echo "Remove: scripts/uninstall-auto-update-macos.sh"
