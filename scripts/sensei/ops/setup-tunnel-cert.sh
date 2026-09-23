#!/bin/zsh
# Tunnel setup using cloudflared's own login (cert.pem) — for when the API token can't
# create tunnels. Run `cloudflared tunnel login` first (authorize once in any browser).
# Usage: setup-tunnel-cert.sh sensei.example.com
source "${0:A:h}/common.sh"
host="$1"
[ -f "$HOME/.cloudflared/cert.pem" ] || { echo "Authorize first: cloudflared tunnel login"; exit 1; }
code=$(envget ACCESS_CODE)
[ ${#code} -lt 6 ] && { echo "Set ACCESS_CODE (6+ characters) in $ENV_FILE first."; exit 1; }

launchctl kickstart -k "gui/$UID/com.sensei.gate" 2>/dev/null
for i in {1..60}; do curl -sf -o /dev/null http://127.0.0.1:3001/api/health && break; sleep 2; done
gate=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/sensei/courses)
[ "$gate" = 401 ] || { echo "Access code gate not active through the gatekeeper (got $gate)."; exit 1; }

cloudflared tunnel info sensei >/dev/null 2>&1 || cloudflared tunnel create sensei || exit 1
id=$(cloudflared tunnel list -o json | /usr/bin/python3 -c 'import json,sys; print(next(t["id"] for t in json.load(sys.stdin) if t["name"]=="sensei"))')
cloudflared tunnel route dns --overwrite-dns sensei "$host" || exit 1
cat > "$HOME/.cloudflared/sensei.yml" <<CFG
tunnel: $id
credentials-file: $HOME/.cloudflared/$id.json
ingress:
  - hostname: $host
    service: http://127.0.0.1:3001
  - service: http_status:404
CFG

AGENTS="$HOME/Library/LaunchAgents"
cat > "$AGENTS/com.sensei.tunnel.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.sensei.tunnel</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v cloudflared)</string><string>tunnel</string><string>--no-autoupdate</string>
    <string>--config</string><string>$HOME/.cloudflared/sensei.yml</string><string>run</string><string>sensei</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/com.sensei.tunnel.log</string>
  <key>StandardErrorPath</key><string>$LOGS/com.sensei.tunnel.log</string>
</dict></plist>
PL
launchctl bootout "gui/$UID/com.sensei.tunnel" 2>/dev/null
for i in {1..20}; do launchctl print "gui/$UID/com.sensei.tunnel" >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap "gui/$UID" "$AGENTS/com.sensei.tunnel.plist"

grep -q '^SENSEI_PUBLIC_URL=' "$ENV_FILE" && sed -i '' "s#^SENSEI_PUBLIC_URL=.*#SENSEI_PUBLIC_URL=https://$host#" "$ENV_FILE" || print "SENSEI_PUBLIC_URL=https://$host" >> "$ENV_FILE"
for i in {1..40}; do
  remote=$(curl -s -o /dev/null -w '%{http_code}' "https://$host/api/sensei/courses")
  [ "$remote" = 401 ] && break; sleep 3
done
[ "$remote" = 401 ] && echo "Live: https://$host/sensei" || echo "Warning: https://$host returned $remote (expected 401)."
