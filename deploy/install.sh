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

install -d -m 755 /opt/billing-guard/src
install -m 644 src/*.ts /opt/billing-guard/src/
install -m 644 package.json /opt/billing-guard/

install -d -m 700 /etc/billing-guard
if ! [ -e /etc/billing-guard/env ]; then
  install -m 600 deploy/env.example /etc/billing-guard/env
  echo "install: fill in /etc/billing-guard/env, then: systemctl enable --now billing-guard.timer"
fi

install -m 644 deploy/billing-guard.service deploy/billing-guard.timer /etc/systemd/system/
systemctl daemon-reload
echo "install: done. First run by hand: systemctl start billing-guard && journalctl -u billing-guard -n 30"
