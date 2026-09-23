#!/usr/bin/env bash
#
# Deploy when main moves.
#
# Run once a minute by balans-deploy.timer. Pushing to main is the deploy;
# there is nothing else to do and nothing to log into.
#
# This decides *whether* to deploy. How to deploy is deploy.sh, which is still
# the thing to run by hand when you want one now.
#
# The reason it exists: pushing and deploying were two separate manual acts,
# so the box ran whatever commit somebody last remembered to ship. Nothing
# announced the difference, and the gap was only ever found by noticing that
# a fix was not live.
#
# Two things matter for something that runs unattended.
#
# It must not loop. A commit that fails is recorded and skipped, so a broken
# push costs one deploy rather than one a minute until somebody notices.
#
# It must not leave the API down. A human running deploy.sh reads the output
# and acts on it; at 3am nobody does. So a failed deploy puts the previous
# commit back and rebuilds it, and only gives up if that fails too.

set -euo pipefail

# Overridable only so the tests can point it at a scratch repository. On the
# box nothing sets these.
APP="${BALANS_APP:-/opt/balans/app}"

# Outside the repository, so a deploy can never reset it away.
FAILED="${BALANS_FAILED:-/opt/balans/.failed-deploy}"

cd "$APP"

git fetch --quiet origin main

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

[ "$LOCAL" = "$REMOTE" ] && exit 0

# A commit that already broke this box is not tried again every minute.
# Pushing anything at all clears it, because the sha stops matching — so the
# way out is the same as the way out of any bad deploy: push the fix.
if [ -f "$FAILED" ] && [ "$(cat "$FAILED")" = "$REMOTE" ]; then
  exit 0
fi

echo "main moved: ${LOCAL:0:7} -> ${REMOTE:0:7}"

if "$APP/deploy/deploy.sh"; then
  rm -f "$FAILED"
  exit 0
fi

# deploy.sh has already reset the checkout to main and printed why it is
# unhealthy. Put back what was working.
echo "deploy of ${REMOTE:0:7} failed — rolling back to ${LOCAL:0:7}"
echo "$REMOTE" >"$FAILED"
git reset --hard --quiet "$LOCAL"

if DEPLOY_NO_FETCH=1 "$APP/deploy/deploy.sh"; then
  echo "rolled back to ${LOCAL:0:7}; ${REMOTE:0:7} will not be tried again"
  exit 1
fi

echo "ROLLBACK ALSO FAILED — the API is down and this needs a person"
exit 1
