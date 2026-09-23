#!/usr/bin/env bash
#
# Ship whatever is on main.
#
#   ssh ubuntu@<elastic-ip> '/opt/balans/app/deploy/deploy.sh'
#
# Caddy is deliberately left alone. Only the API is rebuilt and replaced, so
# the certificates and the listening sockets are never disturbed by a deploy.

set -euo pipefail

APP="/opt/balans/app"
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

cd "$APP"

BEFORE=$(git rev-parse --short HEAD)

# `DEPLOY_NO_FETCH=1` builds whatever is checked out instead of going to
# main. Only watch.sh sets it, and only to put a known-good commit back after
# a bad one: rolling back means building something main has moved past, and
# the fetch below would undo the rollback on the way to doing it.
if [ "${DEPLOY_NO_FETCH:-}" = "1" ]; then
  say "Building what is checked out ($BEFORE), not fetching"
else
  say "Fetching"
  git fetch --quiet origin main
  git reset --hard --quiet origin/main
fi

AFTER=$(git rev-parse --short HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  say "Already on $AFTER — rebuilding anyway, in case the environment changed"
else
  say "$BEFORE -> $AFTER"
  git --no-pager log --oneline "$BEFORE..$AFTER" | head -20
fi

cd "$APP/deploy"

say "Building"
sudo docker compose build api

say "Replacing the API"
sudo docker compose up -d --no-deps api

say "Waiting for health"
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:80/health >/dev/null 2>&1; then
    printf '\n\033[1;32mHealthy on %s\033[0m\n' "$AFTER"

    # Old images pile up fast — each is ~400MB with Chromium in it, and a full
    # disk is a much worse outage than a slow deploy.
    sudo docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 3
done

printf '\n\033[1;31mNot healthy after 90s. Last 60 lines:\033[0m\n'
sudo docker compose logs --tail 60 api
printf '\n\033[1;33mTo go back:  git -C %s reset --hard %s && %s/deploy/deploy.sh\033[0m\n' "$APP" "$BEFORE" "$APP"
exit 1
