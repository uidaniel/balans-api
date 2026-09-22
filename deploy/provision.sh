#!/usr/bin/env bash
#
# One-time setup for a fresh Ubuntu LTS (arm64) EC2 instance in eu-west-1.
#
# Tested against the 24.04 and 26.04 images. Docker publishes per release and
# is sometimes behind, so the install checks and falls back rather than dying
# on a 404 about a codename.
#
# Run it once, as ubuntu, on a box that has nothing on it:
#
#   curl -fsSL https://raw.githubusercontent.com/uidaniel/balans-api/main/deploy/provision.sh | bash
#
# Safe to run twice. Every step checks whether it has already happened, so a
# half-finished run can simply be started again.

set -euo pipefail

REPO="https://github.com/uidaniel/balans-api.git"
ROOT="/opt/balans"
APP="$ROOT/app"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# --------------------------------------------------------------------------
# Swap
# --------------------------------------------------------------------------
#
# 2GB of RAM and Chrome in the same box. A render peaks well above its average
# and without swap the kernel picks a process to kill — usually the largest,
# which is Chrome, in the middle of somebody's invoice. Swap makes that a slow
# render instead of a missing PDF.

if ! swapon --show | grep -q '/swapfile'; then
  say "Adding 2GB of swap"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  # Swap is the safety net, not the plan: only reach for it under real pressure.
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf >/dev/null
  sudo sysctl -p /etc/sysctl.d/99-swap.conf >/dev/null
else
  say "Swap already present, leaving it"
fi

# --------------------------------------------------------------------------
# Docker
# --------------------------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl git

  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc

  # Docker publishes per Ubuntu release, and a release can be out for months
  # before they do. On 26.04 that would fail at `apt-get update` with a 404
  # about a codename — which reads like a broken script rather than a missing
  # upstream package, and is the wrong thing to be debugging at this point.
  #
  # So: ask whether the repository actually has this release, and fall back to
  # the previous LTS if not. Docker's packages for 24.04 run fine on a newer
  # Ubuntu; the dependencies are the same.
  CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"

  if ! curl -fsS --head "https://download.docker.com/linux/ubuntu/dists/$CODENAME/Release" >/dev/null 2>&1; then
    say "Docker has no packages for $CODENAME yet; using the noble (24.04) repository"
    CODENAME="noble"
  fi

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $CODENAME stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

  # A last resort rather than a preference. Ubuntu's own docker.io is older and
  # ships no compose plugin, so it is what stands between a new Ubuntu and a
  # dead end — not something to land on quietly.
  if ! sudo apt-get update -qq \
     || ! sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
    say "Docker's own repository did not work; falling back to Ubuntu's packages"
    sudo rm -f /etc/apt/sources.list.d/docker.list
    sudo apt-get update -qq
    sudo apt-get install -y -qq docker.io docker-compose-v2
  fi

  # Whatever route got us here, compose has to exist — everything below is
  # `docker compose`, and the older `docker-compose` is a different command.
  if ! docker compose version >/dev/null 2>&1; then
    echo "docker compose is not available after install; cannot continue" >&2
    exit 1
  fi

  sudo usermod -aG docker "$USER"
  sudo systemctl enable --now docker
else
  say "Docker already installed"
fi

# --------------------------------------------------------------------------
# The code
# --------------------------------------------------------------------------

sudo mkdir -p "$ROOT"
sudo chown "$USER:$USER" "$ROOT"

if [ -d "$APP/.git" ]; then
  say "Updating the repository"
  git -C "$APP" fetch --quiet origin main
  git -C "$APP" reset --hard --quiet origin/main
else
  say "Cloning the repository"
  git clone --quiet "$REPO" "$APP"
fi

# --------------------------------------------------------------------------
# Secrets
# --------------------------------------------------------------------------
#
# Deliberately outside the repository: a `git pull` cannot touch it and a
# stray `git add -A` cannot stage it.

if [ ! -f "$ROOT/.env" ]; then
  say "No $ROOT/.env yet"
  touch "$ROOT/.env"
  chmod 600 "$ROOT/.env"
  cat <<'NOTE'

  Nothing can start without it. Put the production environment there now:

      nano /opt/balans/.env

  Copy from your .env.local, with four changes:

      NODE_ENV=production
      LOG_LEVEL=info
      WA_FLOWS_DRAFT=false
      MONNIFY_BASE_URL=<the production one, not sandbox>

  Leave PORT and CHROME_PATH out entirely. The Dockerfile sets both, and
  setting PORT here would make it disagree with what Caddy proxies to.

  Then run this script again.

NOTE
  exit 1
fi

chmod 600 "$ROOT/.env"

# --------------------------------------------------------------------------
# systemd
# --------------------------------------------------------------------------
#
# So the bot comes back after a reboot without anybody logging in. `restart:
# always` in compose survives a crash; it does not survive the box restarting.

say "Installing the service"
sudo tee /etc/systemd/system/balans.service >/dev/null <<UNIT
[Unit]
Description=Balans API
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$APP/deploy
ExecStart=/usr/bin/docker compose up -d --build
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable balans.service

say "Building and starting — the first build takes a few minutes"
cd "$APP/deploy"
sudo docker compose up -d --build

say "Waiting for health"
for i in $(seq 1 40); do
  if curl -fsS --max-time 3 http://127.0.0.1:80/health >/dev/null 2>&1; then
    printf '\n\033[1;32mUp. http://127.0.0.1/health answered.\033[0m\n'
    break
  fi
  sleep 5
  [ "$i" = 40 ] && {
    printf '\n\033[1;31mStill not healthy. Logs:\033[0m\n'
    sudo docker compose logs --tail 60
    exit 1
  }
done

cat <<'DONE'

Next, and not before:

  1. Point Cloudflare at this instance's Elastic IP — BOTH records:
       api.balans.ng       A  <elastic ip>   proxy ON
       payment.balans.ng   A  <elastic ip>   proxy ON

  2. Cloudflare SSL/TLS mode must be Full (strict). On Flexible, Cloudflare
     talks plain HTTP to this box and Meta's webhook signature is checked
     over a connection that is not the one it thinks it is.

  3. Caddy gets its certificates on the first real request to each hostname.
     Give it a minute, then:

       curl https://api.balans.ng/health
       curl https://payment.balans.ng/health

  4. Only once both answer 200: stop the Cloudflare tunnel on the laptop.

To deploy a change later:  /opt/balans/app/deploy/deploy.sh
DONE
