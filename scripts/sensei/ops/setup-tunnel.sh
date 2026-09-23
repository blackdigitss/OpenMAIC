#!/bin/zsh
# Put Sensei on your own domain through a Cloudflare Tunnel (API token, no browser login).
# Internet → Cloudflare → tunnel → gatekeeper (:3001, limits code guessing) → app (:3000, loopback only).
# Usage: setup-tunnel.sh sensei.example.com      (needs CLOUDFLARE_API_TOKEN with Tunnel + DNS edit)
source "${0:A:h}/common.sh"
host="$1"
[ -z "$host" ] && { echo "usage: setup-tunnel.sh <hostname, e.g. sensei.example.com>"; exit 2; }
[ -z "$CLOUDFLARE_API_TOKEN" ] && source ~/.zshrc >/dev/null 2>&1
[ -z "$CLOUDFLARE_API_TOKEN" ] && { echo "CLOUDFLARE_API_TOKEN is not set."; exit 1; }
code=$(envget ACCESS_CODE)
[ ${#code} -lt 6 ] && { echo "Set ACCESS_CODE (6+ characters) in $ENV_FILE first."; exit 1; }

api() { # method path [json]
  local args=(-s -X "$1" "https://api.cloudflare.com/client/v4$2" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json")
  [ -n "$3" ] && args+=(--data "$3")
  curl "${args[@]}"
}
py() { /usr/bin/python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

command -v cloudflared >/dev/null || brew install cloudflared || exit 1

# The gate must be up and the access code active before anything is public.
launchctl kickstart -k "gui/$UID/com.sensei.app"; launchctl kickstart -k "gui/$UID/com.sensei.gate" 2>/dev/null
for i in {1..60}; do curl -sf -o /dev/null http://127.0.0.1:3001/api/health && break; sleep 2; done
gate=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/sensei/courses)
[ "$gate" = 401 ] || { echo "Access code gate is not active through the gatekeeper (got $gate). Not opening the tunnel."; exit 1; }

zone_name=${host#*.}
account=$(api GET /accounts | py 'print(d["result"][0]["id"])')
zone=$(api GET "/zones?name=$zone_name" | py 'print(d["result"][0]["id"])') || { echo "Domain $zone_name is not in this Cloudflare account."; exit 1; }

tunnel=$(api GET "/accounts/$account/cfd_tunnel?name=sensei&is_deleted=false" | py 'r=d["result"]; print(r[0]["id"] if r else "")')
if [ -z "$tunnel" ]; then
  secret=$(openssl rand -base64 32)
  tunnel=$(api POST "/accounts/$account/cfd_tunnel" "{\"name\":\"sensei\",\"config_src\":\"cloudflare\",\"tunnel_secret\":\"$secret\"}" | py 'print(d["result"]["id"])') || exit 1
fi
api PUT "/accounts/$account/cfd_tunnel/$tunnel/configurations" \
  "{\"config\":{\"ingress\":[{\"hostname\":\"$host\",\"service\":\"http://127.0.0.1:3001\"},{\"service\":\"http_status:404\"}]}}" \
  | py 'assert d["success"], d["errors"]' || exit 1

record=$(api GET "/zones/$zone/dns_records?name=$host" | py 'r=d["result"]; print(r[0]["id"] if r else "")')
dns="{\"type\":\"CNAME\",\"name\":\"$host\",\"content\":\"$tunnel.cfargotunnel.com\",\"proxied\":true,\"comment\":\"Sensei tunnel\"}"
if [ -n "$record" ]; then api PUT "/zones/$zone/dns_records/$record" "$dns"; else api POST "/zones/$zone/dns_records" "$dns"; fi | py 'assert d["success"], d["errors"]' || exit 1

mkdir -p "$HOME/.cloudflared"
api GET "/accounts/$account/cfd_tunnel/$tunnel/token" | py 'print(d["result"])' > "$HOME/.cloudflared/sensei.token"
chmod 600 "$HOME/.cloudflared/sensei.token"

AGENTS="$HOME/Library/LaunchAgents"
cat > "$AGENTS/com.sensei.tunnel.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.sensei.tunnel</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>-c</string>
    <string>exec $(command -v cloudflared) tunnel --no-autoupdate run --token "\$(cat $HOME/.cloudflared/sensei.token)"</string>
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

for i in {1..30}; do
  remote=$(curl -s -o /dev/null -w '%{http_code}' "https://$host/api/sensei/courses")
  [ "$remote" = 401 ] && break; sleep 3
done
[ "$remote" = 401 ] && echo "Live: https://$host/sensei (code required, 3 tries per device)." || echo "Warning: https://$host returned $remote (expected 401); DNS may still be propagating."
