#!/usr/bin/env bash
# Bootstraps a Debian 12 VM as the worker host. Idempotent. Run as root from a copy of this directory:
#   sudo bash /tmp/worker/install.sh
# Expects /etc/agent-worker.env (BOARD_URL, WORKER_TOKEN, OPENCODE_API_KEY, OPENCODE_MODEL) or ./agent-worker.env next to this script.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE_VERSION="${OPENCODE_VERSION:-1.18.32}"
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
apt-get update -y -qq
apt-get install -y -qq curl git ca-certificates build-essential python3 python3-venv python3-pip tar gzip util-linux cron >/dev/null
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v; npm -v

echo "== swap (2 GB)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -q vm.swappiness=20

echo "== user + layout"
id agent >/dev/null 2>&1 || useradd -m -s /bin/bash agent
mkdir -p /srv/agent /srv/work /srv/templates /srv/lock
if [ ! -f /etc/agent-worker.env ]; then
  [ -f "$SRC/agent-worker.env" ] || { echo "missing /etc/agent-worker.env (or $SRC/agent-worker.env)"; exit 1; }
  install -m 600 -o root -g root "$SRC/agent-worker.env" /etc/agent-worker.env
fi
install -m 755 "$SRC/worker.mjs" /srv/agent/worker.mjs
install -m 755 "$SRC/run-tests" /srv/templates/run-tests
install -m 755 "$SRC/board-backup" /usr/local/bin/board-backup
mkdir -p /srv/backups
cat > /etc/cron.d/board-backup <<'CRON'
# daily board export (see worker/board-backup); runs as root because /etc/agent-worker.env is root-only
17 1 * * * root /usr/local/bin/board-backup >> /var/log/board-backup.log 2>&1
CRON
rm -rf /srv/templates/ts.new /srv/templates/py.new
cp -r "$SRC/templates/ts" /srv/templates/ts.new && rm -rf /srv/templates/ts.new/node_modules
[ -d /srv/templates/ts/node_modules ] && mv /srv/templates/ts/node_modules /srv/templates/ts.new/node_modules || true
rm -rf /srv/templates/ts && mv /srv/templates/ts.new /srv/templates/ts
cp -r "$SRC/templates/py" /srv/templates/py.new
[ -d /srv/templates/py/.venv ] && mv /srv/templates/py/.venv /srv/templates/py.new/.venv || true
rm -rf /srv/templates/py && mv /srv/templates/py.new /srv/templates/py

echo "== opencode $OPENCODE_VERSION"
if ! command -v opencode >/dev/null || [[ "$(opencode --version 2>/dev/null)" != "$OPENCODE_VERSION" ]]; then
  npm install -g "opencode-ai@$OPENCODE_VERSION" --no-audit --no-fund >/dev/null
fi
opencode --version

echo "== template dependencies"
(cd /srv/templates/ts && npm install --no-audit --no-fund >/dev/null)
[ -x /srv/templates/py/.venv/bin/pytest ] || { python3 -m venv /srv/templates/py/.venv && /srv/templates/py/.venv/bin/pip install -q -r /srv/templates/py/requirements.txt; }

echo "== opencode config + credential for the agent user (one data dir per worker)"
install -d -o agent -g agent /home/agent/.config/opencode /home/agent/.local/share/opencode
# migrate the first night's shared session store into worker 1's data dir, once
if [ ! -d /srv/agent/xdg-1/opencode ] && [ -d /home/agent/.local/share/opencode ]; then
  install -d -o agent -g agent /srv/agent/xdg-1 && cp -a /home/agent/.local/share/opencode /srv/agent/xdg-1/opencode
fi
cat > /home/agent/.config/opencode/opencode.json <<JSON
{ "\$schema": "https://opencode.ai/config.json", "model": "$(grep '^OPENCODE_MODEL=' /etc/agent-worker.env | cut -d= -f2- || echo opencode-go/deepseek-v4.1-flash)", "permission": "allow", "share": "$(grep '^OPENCODE_SHARE=' /etc/agent-worker.env | cut -d= -f2- | grep -E '^(auto|manual|disabled)$' || echo disabled)", "autoupdate": false }
JSON
key="$(grep '^OPENCODE_API_KEY=' /etc/agent-worker.env | cut -d= -f2-)"
[ -n "$key" ] || { echo "OPENCODE_API_KEY missing in /etc/agent-worker.env"; exit 1; }
for d in /home/agent/.local/share/opencode /srv/agent/xdg-1/opencode /srv/agent/xdg-2/opencode; do
  install -d -o agent -g agent "$d"
  printf '{"opencode-go":{"type":"api","key":"%s"}}\n' "$key" > "$d/auth.json"
  chmod 600 "$d/auth.json"
done
chown -R agent:agent /srv/work /srv/templates /srv/lock /srv/agent/xdg-1 /srv/agent/xdg-2 /home/agent

echo "== systemd"
install -m 644 "$SRC/agent-worker@.service" /etc/systemd/system/agent-worker@.service
install -m 644 "$SRC/opencode-web@.service" /etc/systemd/system/opencode-web@.service
if systemctl list-unit-files opencode-web.service >/dev/null 2>&1; then systemctl disable --now opencode-web.service 2>/dev/null || true; rm -f /etc/systemd/system/opencode-web.service; fi
systemctl daemon-reload
systemctl enable --now opencode-web@1 opencode-web@2 agent-worker@1 agent-worker@2
systemctl restart opencode-web@1 opencode-web@2 agent-worker@1 agent-worker@2
sleep 3
systemctl --no-pager --lines=3 status agent-worker@1 agent-worker@2 opencode-web@1 opencode-web@2 || true
echo "== done. Logs: journalctl -u agent-worker@1 -u agent-worker@2 -f"
