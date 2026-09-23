#!/bin/zsh
# launchd entry points. `serve.sh app` runs the web app, `serve.sh worker` the lecture worker.
source "${0:A:h}/common.sh"
cd "$CURRENT" || exit 1
# Settings come from .env.local (a link to sensei.env), read by Next and by the worker.
case "$1" in
  app) exec node_modules/.bin/next start -p "${SENSEI_PORT:-3000}" ;;
  worker) exec node_modules/.bin/tsx scripts/sensei/worker.ts ;;
  backup) exec node_modules/.bin/tsx scripts/sensei/cli.ts backup ;;
  *) echo "usage: serve.sh app|worker|backup"; exit 2 ;;
esac
