#!/bin/zsh
# launchd entry points. `serve.sh app` runs the web app, `serve.sh worker` the lecture worker.
source "${0:A:h}/common.sh"
cd "$CURRENT" || exit 1
# Settings come from .env.local (a link to sensei.env), read by Next and by the worker.
case "$1" in
  app)
    # Never serve a public URL without the access code gate.
    if [ -n "$(envget SENSEI_PUBLIC_URL)" ] && [ ${#$(envget ACCESS_CODE)} -lt 6 ]; then
      log "refusing to start: SENSEI_PUBLIC_URL is set but ACCESS_CODE is missing or shorter than 6"; sleep 60; exit 1
    fi
    # Loopback only: the phone reaches Sensei through the Cloudflare Tunnel, never the LAN.
    exec node_modules/.bin/next start -H 127.0.0.1 -p "${SENSEI_PORT:-3000}" ;;
  worker) exec node_modules/.bin/tsx scripts/sensei/worker.ts ;;
  backup) exec node_modules/.bin/tsx scripts/sensei/cli.ts backup ;;
  *) echo "usage: serve.sh app|worker|backup"; exit 2 ;;
esac
