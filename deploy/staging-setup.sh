#!/usr/bin/env bash
#
# Sets up the staging copy of the API on this box, once (9 October 2026).
#
# Run by the live deploy (deploy.sh) before it replaces the live API, so the
# box sets itself up with no one logging in. Every step checks first and does
# nothing when it is already done, so running it on every deploy is free.
#
#   /opt/balans/staging           its own checkout, branch "staging"
#   /opt/balans/.env.staging      the live settings, with staging's overrides
#   balans-staging-deploy.timer   deploys it when the staging branch moves
#
# And on the live side, the two settings that hand the test number's
# messages to staging. The live API picks them up as deploy.sh replaces it.
#
# Never prints a setting's value.

set -euo pipefail

LIVE_APP="/opt/balans/app"
STAGING_APP="/opt/balans/staging"
LIVE_ENV="/opt/balans/.env"
STAGING_ENV="/opt/balans/.env.staging"

# Meta's test number and its test business account (found 9 October 2026).
TEST_PHONE_ID="1247987061741015"
TEST_WABA_ID="1834007831276676"

say() { printf '\n\033[1;35m[staging] %s\033[0m\n' "$*"; }

# -- The live side: hand the test number's messages over ----------------------
add_live() {
  local key="$1" value="$2"
  if ! grep -q "^${key}=" "$LIVE_ENV"; then
    printf '%s=%s\n' "$key" "$value" | sudo tee -a "$LIVE_ENV" >/dev/null
    say "live: $key added"
  fi
}
add_live WA_STAGING_PHONE_NUMBER_ID "$TEST_PHONE_ID"
add_live STAGING_WEBHOOK_URL "http://balans-staging-api:4000/webhooks/whatsapp"

# -- Staging's settings: the live ones, with its own on top --------------------
if [ ! -f "$STAGING_ENV" ]; then
  say "writing $STAGING_ENV from the live settings"
  tmp=$(mktemp)
  # Everything staging replaces or must not have, taken out first.
  grep -v -E '^(DATABASE_SCHEMA|WA_PHONE_NUMBER_ID|WA_BUSINESS_ACCOUNT_ID|PUBLIC_BASE_URL|ALERTS_ENABLED|PAYSTACK_SECRET_KEY|WA_STAGING_PHONE_NUMBER_ID|STAGING_WEBHOOK_URL|WA_FLOWS_DRAFT)=' "$LIVE_ENV" >"$tmp" || true
  cat >>"$tmp" <<EOF

# -- Staging (staging-setup.sh) ------------------------------------------------
DATABASE_SCHEMA=staging
WA_PHONE_NUMBER_ID=$TEST_PHONE_ID
WA_BUSINESS_ACCOUNT_ID=$TEST_WABA_ID
PUBLIC_BASE_URL=https://staging.balans.ng
ALERTS_ENABLED=false
# No Paystack key: card payments are off on staging until a test key is added.
EOF
  sudo install -m 600 -o root -g root "$tmp" "$STAGING_ENV"
  rm -f "$tmp"
fi

# -- Staging's checkout --------------------------------------------------------
if [ ! -d "$STAGING_APP/.git" ]; then
  say "cloning the staging branch into $STAGING_APP"
  origin=$(git -C "$LIVE_APP" remote get-url origin)
  sudo mkdir -p "$STAGING_APP"
  sudo chown "$(id -u):$(id -g)" "$STAGING_APP"
  git clone --quiet --branch staging "$origin" "$STAGING_APP"
  # One commit behind, so the watcher sees the branch move and does the first
  # deploy itself, with its rollback and health check, rather than this script.
  git -C "$STAGING_APP" reset --hard --quiet HEAD~1
  chmod +x "$STAGING_APP/deploy/"*.sh
fi

# -- Staging's watcher ---------------------------------------------------------
if [ ! -f /etc/systemd/system/balans-staging-deploy.timer ]; then
  say "installing the staging deploy timer"
  sudo cp "$LIVE_APP/deploy/balans-staging-deploy.service" "$LIVE_APP/deploy/balans-staging-deploy.timer" /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now balans-staging-deploy.timer
fi

say "ready"
