#!/bin/sh
# Install or update the guard on a systemd host. Run as root from a checkout of this repo:
#   sudo sh deploy/install.sh
# Needs Node.js 24+ at /usr/local/bin/node. Leaves an existing /etc/billing-guard/env alone.
set -eu
cd "$(dirname "$0")/.."

node_bin=/usr/local/bin/node
if ! [ -x "$node_bin" ] || [ "$("$node_bin" -p 'process.versions.node.split(".")[0] >= 24')" != true ]; then
  echo "install: Node.js 24+ is required at $node_bin" >&2
  exit 1
fi
# The service can't see /root or /home (ProtectHome), so Node must not live there (as mise or nvm installs do).
case "$(readlink -f "$node_bin")" in
  /root/*|/home/*) echo "install: $node_bin points into /root or /home, which the service can't read. Install Node system-wide." >&2; exit 1 ;;
esac

# Replace the code completely, so a removed file never lingers.
rm -rf /opt/billing-guard.new
install -d -m 755 /opt/billing-guard.new/src
install -m 644 src/*.ts /opt/billing-guard.new/src/
install -m 644 package.json /opt/billing-guard.new/
rm -rf /opt/billing-guard
mv /opt/billing-guard.new /opt/billing-guard

install -d -m 700 -o root -g root /etc/billing-guard
if [ -e /etc/billing-guard/env ]; then
  chown root:root /etc/billing-guard/env
  chmod 600 /etc/billing-guard/env
else
  install -m 600 -o root -g root deploy/env.example /etc/billing-guard/env
  echo "install: fill in /etc/billing-guard/env, then: systemctl enable --now billing-guard.timer"
fi

install -m 644 deploy/billing-guard.service deploy/billing-guard.timer /etc/systemd/system/
systemctl daemon-reload
echo "install: done ($(git rev-parse --short HEAD 2>/dev/null || echo unknown)). Run once by hand: systemctl start billing-guard; journalctl -u billing-guard -n 30"
