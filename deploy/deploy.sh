#!/usr/bin/env bash
#
# Ship whatever is on main.
#
#   ssh ubuntu@<elastic-ip> '/opt/balans/app/deploy/deploy.sh'
#
# Caddy is left alone unless its Caddyfile changed. Only the API is rebuilt
# and replaced, so the certificates and the listening sockets are not
# disturbed by an ordinary deploy, and Caddy holds requests while the API
# restarts (see lb_try_duration in the Caddyfile).

set -euo pipefail

APP="${BALANS_APP:-/opt/balans/app}"
# Staging sets these (balans-staging-deploy.service); the live box sets none.
BRANCH="${BALANS_BRANCH:-main}"
STAGING=$([ "$BRANCH" = "main" ] && echo 0 || echo 1)
# Every compose call names its file. Through sudo, COMPOSE_FILE from the
# environment is dropped, and staging would then act on the live project —
# replacing the live API with staging's build. Never again by accident.
if [ "$STAGING" = "1" ]; then
  DC=(sudo docker compose -f "$APP/deploy/docker-compose.staging.yml")
  SERVICE=staging-api
else
  DC=(sudo docker compose -f "$APP/deploy/docker-compose.yml")
  SERVICE=api
fi
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
  say "Fetching $BRANCH"
  git fetch --quiet origin "$BRANCH"
  git reset --hard --quiet "origin/$BRANCH"
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
"${DC[@]}" build "$SERVICE"

# The Caddyfile is bind-mounted as a single file, and `git reset` replaces the
# file rather than rewriting it, so a running Caddy keeps reading the old one.
# Compared with what Caddy actually has, not with git, so a change is picked
# up even by the deploy after the one that shipped it. Validated in a
# throwaway container first: a bad Caddyfile must never replace a working one.
if [ "$STAGING" = "0" ] && ! "${DC[@]}" exec -T caddy cat /etc/caddy/Caddyfile 2>/dev/null | cmp -s - "$APP/deploy/Caddyfile"; then
  if "${DC[@]}" run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    say "Caddyfile changed — recreating Caddy"
    "${DC[@]}" up -d --no-deps --force-recreate caddy
  else
    printf '\n\033[1;31mNew Caddyfile does not validate; keeping the running one.\033[0m\n'
  fi
fi

# The staging copy, set up on this box the first time (staging-setup.sh).
# Before the live API is replaced, so it starts with the settings that hand
# the test number's messages over. Never allowed to stop a live deploy.
if [ "$STAGING" = "0" ] && [ -x "$APP/deploy/staging-setup.sh" ]; then
  "$APP/deploy/staging-setup.sh" || printf '
[1;33mStaging setup did not finish; the live deploy carries on.[0m
'
fi

say "Replacing the API"
"${DC[@]}" up -d --no-deps "$SERVICE"

# Staging must never answer to the live API's name on the shared network:
# Caddy sends payment.balans.ng to "api", and a second container there takes
# a share of live traffic. Stopped at once if it does.
if [ "$STAGING" = "1" ]; then
  aliases=$(sudo docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{range $v.Aliases}}{{.}} {{end}}{{end}}' balans-staging-api 2>/dev/null || true)
  if printf ' %s ' "$aliases" | grep -q ' api '; then
    sudo docker stop balans-staging-api >/dev/null 2>&1 || true
    printf '
[1;31mStaging answered to "api" on the live network; stopped it.[0m
'
    exit 1
  fi
fi

say "Waiting for health"
for i in $(seq 1 30); do
  # Asked inside the new container itself, live and staging alike (9 October
  # 2026). Live used to curl Caddy on port 80, which answers a request for a
  # host it has no site for by itself, so a deploy could pass with the API
  # down and never roll back.
  if "${DC[@]}" exec -T "$SERVICE" node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    printf '\n\033[1;32mHealthy on %s\033[0m\n' "$AFTER"

    # Old images pile up fast — each is ~400MB with Chromium in it, and a full
    # disk is a much worse outage than a slow deploy.
    sudo docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 3
done

printf '\n\033[1;31mNot healthy after 90s. Last 60 lines:\033[0m\n'
"${DC[@]}" logs --tail 60 "$SERVICE"
printf '\n\033[1;33mTo go back:  git -C %s reset --hard %s && %s/deploy/deploy.sh\033[0m\n' "$APP" "$BEFORE" "$APP"
exit 1
