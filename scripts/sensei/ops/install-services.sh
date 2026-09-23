#!/bin/zsh
# One-time setup: run Sensei as always-on macOS services (launchd).
#   com.sensei.app     web app on :3000, restarts if it stops
#   com.sensei.worker  lecture worker, restarts if it stops
#   com.sensei.update  Sunday 3:00 zero-downtime update
#   com.sensei.backup  nightly 3:30 database backup
source "${0:A:h}/common.sh"
AGENTS="$HOME/Library/LaunchAgents"
OPS="$CURRENT/scripts/sensei/ops"
mkdir -p "$AGENTS" "$LIB/backups"

[ -L "$CURRENT" ] || { echo "Run bootstrap-slot.sh first."; exit 1; }

plist() { # label program-args-xml extra-xml
  cat > "$AGENTS/$1.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>$2</array>
  <key>StandardOutPath</key><string>$LOGS/$1.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$1.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  $3
</dict></plist>
PL
  launchctl bootout "gui/$UID/$1" 2>/dev/null
  launchctl bootstrap "gui/$UID" "$AGENTS/$1.plist"
}

arg() { print -r -- "<string>$1</string>"; }
plist com.sensei.app "$(arg /bin/zsh)$(arg "$OPS/serve.sh")$(arg app)" "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>"
plist com.sensei.worker "$(arg /bin/zsh)$(arg "$OPS/serve.sh")$(arg worker)" "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>"
plist com.sensei.update "$(arg /bin/zsh)$(arg "$OPS/update.sh")" "<key>StartCalendarInterval</key><dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>"
plist com.sensei.backup "$(arg /bin/zsh)$(arg "$OPS/serve.sh")$(arg backup)" "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>"
log "Sensei services installed."
