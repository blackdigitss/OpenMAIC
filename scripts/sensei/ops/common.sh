#!/bin/zsh
# Shared paths for Sensei operations. Layout (all under the Sensei folder):
#   OpenMAIC-sensei/   build slot A (git worktree, detached at the sensei branch)
#   .sensei-b/         build slot B (created by the first update)
#   .current           symlink → the live slot; launchd services run from here
#   Library/           everything that must survive updates: files, cache, backups,
#                      openmaic-data (classrooms + jobs), logs, status
#   sensei.env         the one settings file (keys, access code); linked into each slot as .env.local

export SENSEI_ROOT="${SENSEI_ROOT:-$HOME/Documents/Claude MacOs/Sensei}"
export SLOT_A="$SENSEI_ROOT/OpenMAIC-sensei"
export SLOT_B="$SENSEI_ROOT/.sensei-b"
export CURRENT="$SENSEI_ROOT/.current"
export LIB="$SENSEI_ROOT/Library"
export ENV_FILE="$SENSEI_ROOT/sensei.env"
export LOGS="$LIB/logs"
export STATUS="$LIB/update-status.json"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" >/dev/null
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
mkdir -p "$LOGS" "$LIB/openmaic-data"

log() { print -r -- "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# iMessage to the student's phone when SENSEI_NOTIFY_IMESSAGE is set in sensei.env.
notify() {
  local handle
  handle=$(grep -E '^SENSEI_NOTIFY_IMESSAGE=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
  log "notify: $1"
  [ -z "$handle" ] && return 0
  osascript -e "tell application \"Messages\" to send \"$1\" to participant \"$handle\" of (1st account whose service type = iMessage)" >/dev/null 2>&1 || true
}

write_status() { # state message
  print -r -- "{\"state\":\"$1\",\"message\":\"${2//\"/\\\"}\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"version\":\"$(git -C "$CURRENT" rev-parse --short HEAD 2>/dev/null)\"}" > "$STATUS"
}

# Point a slot's data/ and .env.local at the shared locations.
link_shared() {
  local slot="$1"
  [ -e "$slot/data" ] && [ ! -L "$slot/data" ] && mv "$slot/data" "$slot/data.local-$(date +%s)"
  ln -sfn "$LIB/openmaic-data" "$slot/data"
  ln -sfn "$ENV_FILE" "$slot/.env.local"
}
