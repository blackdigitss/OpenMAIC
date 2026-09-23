#!/bin/zsh
# Zero-downtime weekly update (DECISIONS A11, A15, A16).
#  1. Merge the latest upstream OpenMAIC into the sensei branch in the IDLE slot.
#  2. Install, run Sensei's tests, build, and smoke-test it on a spare port.
#  3. Only then point .current at it and restart the services.
# Any failure leaves the live app untouched and tells the student what happened.
# Usage: update.sh [--force] | update.sh rollback
source "${0:A:h}/common.sh"
exec >> "$LOGS/update.log" 2>&1
set -o pipefail

live=$(readlink "$CURRENT")
[ "$live" = "$SLOT_A" ] && idle="$SLOT_B" || idle="$SLOT_A"

if [ "$1" = "rollback" ]; then
  # Only a slot that passed its smoke test is a valid rollback target.
  [ -f "$idle/.sensei-good" ] || { log "rollback: no verified previous build"; notify "Sensei can't roll back: there is no verified previous version."; exit 1; }
  ln -sfn "$idle" "$CURRENT"
  launchctl kickstart -k "gui/$UID/com.sensei.app"; launchctl kickstart -k "gui/$UID/com.sensei.worker"
  write_status ok "Rolled back to the previous version"
  notify "Sensei rolled back to the previous version."
  exit 0
fi

fail() {
  log "FAILED: $1"
  write_status failed "$1"
  notify "Sensei update skipped: $1 Your app is unchanged."
  exit 1
}

log "=== update start (live: $live) ==="
cd "$live" || fail "live slot missing."
git fetch -q upstream || fail "couldn't reach GitHub."
git fetch -q origin || fail "couldn't reach your GitHub fork."

# Deploy what was merged on GitHub: fast-forward the local sensei ref to origin/sensei.
if git merge-base --is-ancestor sensei origin/sensei; then
  git update-ref refs/heads/sensei origin/sensei
elif ! git merge-base --is-ancestor origin/sensei sensei; then
  fail "the sensei branch on this Mac and on GitHub have diverged. Ask Claude to reconcile them."
fi

# Up to date only if the live build already contains both the latest sensei and upstream.
live_head=$(git -C "$live" rev-parse HEAD)
if git merge-base --is-ancestor sensei "$live_head" && git merge-base --is-ancestor upstream/main "$live_head" && [ "$1" != "--force" ]; then
  log "already up to date"
  write_status ok "Already up to date"
  exit 0
fi

# Never swap builds while a lecture or a lesson is being generated.
db=$(envget SENSEI_DATABASE_URL)
running=$(psql "${db:-sensei}" -Atc "select count(*) from sensei_job where status='running'" 2>/dev/null) || fail "couldn't reach the database."
[ "$running" = 0 ] || fail "a lecture is being processed; will try again next time."

if grep -l '"status": *"running"' "$LIB/openmaic-data/classroom-jobs/"*.json >/dev/null 2>&1; then
  fail "a lesson is being generated; will try again next time."
fi

# Prepare the idle slot at the current sensei commit, then merge upstream there.
if [ ! -d "$idle/.git" ] && [ ! -f "$idle/.git" ]; then
  git worktree add -q --detach "$idle" sensei || fail "couldn't create the build folder."
fi
cd "$idle" || fail "build folder missing."
[ "$idle" = "$DEV" ] && fail "refusing to build in the development folder."
rm -f "$idle/.sensei-good"
git reset -q --hard && git clean -qfd -e node_modules -e .next
git checkout -q --detach sensei || fail "couldn't check out sensei."
base=$(git rev-parse sensei)
if ! git merge -q --no-edit upstream/main -m "Merge upstream OpenMAIC $(git rev-parse --short upstream/main)"; then
  files=$(git diff --name-only --diff-filter=U | head -5 | tr '\n' ' ')
  git merge --abort
  fail "OpenMAIC changed files Sensei also touches ($files). Ask Claude to merge it."
fi
link_shared "$idle"

log "installing"
pnpm install --frozen-lockfile >> "$LOGS/update.log" 2>&1 || pnpm install >> "$LOGS/update.log" 2>&1 || fail "dependency install failed."
log "testing"
node_modules/.bin/vitest run tests/sensei >> "$LOGS/update.log" 2>&1 || fail "Sensei's tests failed on the new version."
log "building"
pnpm build >> "$LOGS/update.log" 2>&1 || fail "the new version didn't build."

log "smoke test"
node_modules/.bin/next start -p 3101 >> "$LOGS/update.log" 2>&1 &
smoke=$!
ok=0
for i in {1..60}; do
  sleep 2
  if curl -sf -o /dev/null http://localhost:3101/api/health; then ok=1; break; fi
done
code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3101/sensei)
kill $smoke 2>/dev/null; wait $smoke 2>/dev/null
[ $ok = 1 ] && [ "$code" = 200 ] || fail "the new version didn't start correctly."

# Swap and restart.
git rev-parse HEAD > "$idle/.sensei-good"
ln -sfn "$idle" "$CURRENT"
launchctl kickstart -k "gui/$UID/com.sensei.app"
launchctl kickstart -k "gui/$UID/com.sensei.worker"
launchctl kickstart -k "gui/$UID/com.sensei.gate" 2>/dev/null
# Advance the branch only if nobody committed to it during the build.
git update-ref refs/heads/sensei HEAD "$base" || log "sensei branch moved during the update; left unchanged"
# Keep the fork's main a clean mirror of upstream (the established weekly habit).
git push -q origin upstream/main:main 2>/dev/null || log "fork push skipped"
git push -q origin sensei 2>/dev/null || log "sensei branch push skipped"

changes=$(git log --oneline "$(git rev-parse HEAD^1)..upstream/main" 2>/dev/null | wc -l | tr -d ' ')
write_status ok "Updated with $changes OpenMAIC changes"
log "=== update done ($changes upstream commits) ==="
notify "Sensei updated overnight ($changes improvements from OpenMAIC). Everything passed its checks."
