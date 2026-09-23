#!/bin/zsh
# Create build slot A from the sensei branch, build it, and make it live.
# The development worktree (OpenMAIC-sensei) is never served.
source "${0:A:h}/common.sh"
set -e
cd "$DEV"
[ -e "$SLOT_A" ] || git worktree add -q --detach "$SLOT_A" sensei
cd "$SLOT_A"
git checkout -q --detach sensei
link_shared "$SLOT_A"
pnpm install --frozen-lockfile > "$LOGS/bootstrap.log" 2>&1
node_modules/.bin/vitest run tests/sensei >> "$LOGS/bootstrap.log" 2>&1
SENSEI_BUILD_SHA=$(git rev-parse --short HEAD) pnpm build >> "$LOGS/bootstrap.log" 2>&1
git rev-parse HEAD > "$SLOT_A/.sensei-good"
ln -sfn "$SLOT_A" "$CURRENT"
log "slot A live at $(git rev-parse --short HEAD)"
