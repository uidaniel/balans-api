#!/usr/bin/env bash
#
# Turns pushing to main into deploying. Run once, on the box:
#
#   /opt/balans/app/deploy/install-watcher.sh
#
# After this there is nothing to log into. `git push` is the deploy, and the
# change is live within about a minute.
#
# Safe to run again: it replaces the units and restarts the timer, which is
# what you want after editing either of them.

set -euo pipefail

APP="/opt/balans/app"
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
bad() { printf '\n\033[1;31m%s\033[0m\n' "$*"; exit 1; }

[ -d "$APP/.git" ] || bad "No checkout at $APP."

say "Checking this user can build without being asked for a password"
# deploy.sh runs `sudo docker`. Under systemd there is no terminal to type a
# password into, so a sudo that prompts means every deploy fails at the build
# with nothing obvious in the log to say why.
sudo -n true 2>/dev/null || bad \
  "sudo asks $USER for a password, so the timer could never build.
Give this user passwordless sudo, or run the units as a user that has it."

say "Making the scripts executable"
# git carries the bit, but a checkout made on Windows may not have it.
chmod +x "$APP/deploy/deploy.sh" "$APP/deploy/watch.sh" "$APP/deploy/install-watcher.sh"

say "Installing the units"
sudo cp "$APP/deploy/balans-deploy.service" "$APP/deploy/balans-deploy.timer" /etc/systemd/system/
sudo systemctl daemon-reload

say "Starting the timer"
sudo systemctl enable --now balans-deploy.timer

say "Where it stands"
systemctl list-timers balans-deploy.timer --no-pager || true

cat <<'DONE'

Done. Pushing to main is now the deploy.

  Watch one happen:      journalctl -u balans-deploy -f
  Deploy right now:      sudo systemctl start balans-deploy
  Stop deploying:        sudo systemctl disable --now balans-deploy.timer

A commit that fails to come up healthy is rolled back and recorded in
/opt/balans/.failed-deploy, and is not tried again. Pushing anything new
clears that by itself — so a bad deploy is fixed the same way as any other
bug, by pushing the fix.

DONE
