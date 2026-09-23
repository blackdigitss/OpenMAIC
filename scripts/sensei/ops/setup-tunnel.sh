#!/bin/zsh
# Put Sensei on your own domain through a Cloudflare Tunnel, so the iPhone reaches the Mac
# from anywhere without opening router ports.
# Usage: setup-tunnel.sh sensei.example.com
# Uses ACCESS_CODE from sensei.env (generates a passphrase if none is set). A short numeric
# code should be paired with the Cloudflare rate-limit rule on /api/access-code/verify.
source "${0:A:h}/common.sh"
host="$1"
[ -z "$host" ] && { echo "usage: setup-tunnel.sh <hostname, e.g. sensei.yourdomain.com>"; exit 2; }
code=$(envget ACCESS_CODE)
if [ ${#code} -lt 6 ]; then
  # Five random dictionary words: typed once per device, far too long to guess.
  code=$(LC_ALL=C grep -E '^[a-z]{4,7}$' /usr/share/dict/words | sort -R | head -5 | paste -sd- -)
  sed -i '' '/^#* *ACCESS_CODE=/d' "$ENV_FILE"
  print "ACCESS_CODE=$code" >> "$ENV_FILE"
  echo "Your Sensei access code (saved in sensei.env): $code"
fi
# Next reads settings at startup: restart so the gate is actually on before going public.
launchctl kickstart -k "gui/$UID/com.sensei.app"; launchctl kickstart -k "gui/$UID/com.sensei.worker"
for i in {1..60}; do curl -sf -o /dev/null http://127.0.0.1:3000/api/health && break; sleep 2; done
gate=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/sensei/courses)
[ "$gate" = 401 ] || { echo "Access code gate is not active (got $gate). Not opening the tunnel."; exit 1; }

command -v cloudflared >/dev/null || brew install cloudflared || exit 1
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  echo "A browser window will open: log in to Cloudflare and pick the domain for $host."
  cloudflared tunnel login || exit 1
fi
cloudflared tunnel info sensei >/dev/null 2>&1 || cloudflared tunnel create sensei || exit 1
id=$(cloudflared tunnel list -o json | /usr/bin/python3 -c 'import json,sys; print(next(t["id"] for t in json.load(sys.stdin) if t["name"]=="sensei"))')
cloudflared tunnel route dns --overwrite-dns sensei "$host" || exit 1

cat > "$HOME/.cloudflared/config.yml" <<CFG
tunnel: $id
credentials-file: $HOME/.cloudflared/$id.json
ingress:
  - hostname: $host
    service: http://127.0.0.1:3000
  - service: http_status:404
CFG

AGENTS="$HOME/Library/LaunchAgents"
cat > "$AGENTS/com.sensei.tunnel.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.sensei.tunnel</string>
  <key>ProgramArguments</key><array><string>$(command -v cloudflared)</string><string>tunnel</string><string>run</string><string>sensei</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/com.sensei.tunnel.log</string>
  <key>StandardErrorPath</key><string>$LOGS/com.sensei.tunnel.log</string>
</dict></plist>
PL
launchctl bootout "gui/$UID/com.sensei.tunnel" 2>/dev/null
launchctl bootstrap "gui/$UID" "$AGENTS/com.sensei.tunnel.plist"
grep -q '^SENSEI_PUBLIC_URL=' "$ENV_FILE" && sed -i '' "s#^SENSEI_PUBLIC_URL=.*#SENSEI_PUBLIC_URL=https://$host#" "$ENV_FILE" || print "SENSEI_PUBLIC_URL=https://$host" >> "$ENV_FILE"
sleep 8
remote=$(curl -s -o /dev/null -w '%{http_code}' "https://$host/api/sensei/courses")
[ "$remote" = 401 ] || echo "Warning: https://$host/api/sensei/courses returned $remote (expected 401). Check before using."
echo "Done. On your iPhone open https://$host/sensei in Safari, enter your access code, then Share → Add to Home Screen."
