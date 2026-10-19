# Hetzner billing guard

Hetzner has no spending cap. This small script adds one for the cost that can grow without limit, **traffic on Cloud servers**, and alerts on the rest. It runs every 5 minutes on a machine **outside** Hetzner:

1. **It caps Cloud server traffic.** Each Cloud server includes a monthly traffic allowance (20 TB in the EU) and Hetzner bills per TB beyond it. The guard alerts at 50% of the allowance. At 90% it shuts the server down, and powers it off if it ignores the shutdown, so the overage never starts.
2. **It alerts on anything new in your Cloud project.** A leaked API token's first move is usually creating servers. New servers, volumes, snapshots, IPs, load balancers and Storage Boxes all raise an alert. The alert is retried until it's actually delivered.
3. **It alerts when the estimated monthly run-rate passes your budget**, and names the biggest items.
4. **It watches dedicated (Robot) servers' traffic** and alerts on a busy hour or day. 1 Gbit/s servers have unmetered traffic, so for them this is an early warning for hotlinking or abuse. Servers with a traffic quota (for example 10 Gbit/s uplinks) are checked against it month to date. The guard never acts on dedicated servers.
5. **It tells you when it isn't working.** Every run pings a [healthchecks.io](https://healthchecks.io) check. A run that couldn't fully do its job reports a failure: an API it couldn't read, an action or alert that failed, a broken state file. If the guard stops running at all, healthchecks.io notices the missing pings.

Alerts go to [ntfy](https://ntfy.sh), a phone app that needs no account.

Version 1 of this tool ran as a GitHub Actions cron. GitHub disables scheduled workflows in repos with no activity for 60 days, which silently switched the guard off. Version 2 runs as a systemd timer and reports its own health.

## What it can't do

Read this before you rely on it.

- **It never deletes anything, so a leaked token can still run up a bill.** Servers created with a stolen token keep billing even when powered off, until someone deletes them. The guard alerts within 5 minutes; deleting is up to you. Act on a "new resources" alert immediately.
- **Some costs are invisible to it:**
  - Object Storage and its egress (billed per account, not in the Cloud API).
  - Anything in other Cloud projects (one install watches one project).
  - Traffic on dedicated servers beyond alerting.
- **The estimate is a run-rate, not your bill.** It prices what exists now at today's list prices, plus traffic overage so far. Resources deleted earlier in the month aren't counted. Grandfathered servers cost less than list price, so it errs high for what exists. Anything with no price in the API is reported as "unpriced".
- **A stopped server stays stopped** while it's over its threshold: if you start it again, the next run stops it. To bring one server back before the month resets, give it its own threshold with `KILL_OVERRIDES=<server id>=<percent>` (up to 200%). The other servers stay capped.
- **Traffic figures lag a little**, so the kill threshold leaves headroom. Robot reports only completed hours, so dedicated-server alerts can arrive up to about 2 hours late.
- **The Robot API doesn't say which timezone its hours are in.** The guard assumes UTC, and reads only hours that are complete either way.

## Setup

You need a small Linux host with systemd **outside Hetzner**, so it keeps working if Hetzner servers are stopped or the account is in trouble. Any $4–6/month VM works. It also needs Node.js 24 or newer, installed system-wide at `/usr/local/bin/node`: the service can't read `/root` or `/home`, so a mise or nvm install there won't work. The guard has no runtime dependencies.

1. **Hetzner Cloud token:** Console → your project → Security → API tokens → *Read & Write*. Write is needed only to shut servers down. Make a dedicated token for the guard.
2. **Robot user**, optional, for dedicated servers: Robot → Settings → Webservice and app settings.
3. **ntfy topic:** a protected topic with an access token is best. Otherwise pick a long random topic name. Subscribe to it in the ntfy app.
4. **healthchecks.io check:** period 5 minutes, grace 15 minutes. It's required for enforce mode.
5. **Install**, as root on the guard host:
   ```sh
   git clone https://github.com/simmer-io/hetzner-billing-guard /opt/src/hetzner-billing-guard
   cd /opt/src/hetzner-billing-guard && sh deploy/install.sh
   $EDITOR /etc/billing-guard/env      # from deploy/env.example; keep GUARD_MODE=dry-run at first
   systemd-run --pipe --wait -p EnvironmentFile=/etc/billing-guard/env /usr/local/bin/node /opt/billing-guard/src/main.ts --test-alert
   systemctl start billing-guard && journalctl -u billing-guard -n 30
   systemctl enable --now billing-guard.timer
   ```
   The env file uses systemd's format: one `NAME=value` per line, no quotes, and no comments after a value. The `systemd-run` test reads it exactly as the service does.
6. **Switch to enforce** after a day of dry-run reports look right: set `GUARD_MODE=enforce` in `/etc/billing-guard/env`. To update later, run `git pull` and `sh deploy/install.sh` again.

The first run records the resources that exist today and sends a "watching" notification. Only resources created after that raise new-resource alerts.

## Configuration

All settings are environment variables. See [`deploy/env.example`](deploy/env.example).

| Variable | Default | Meaning |
|---|---|---|
| `GUARD_MODE` | `dry-run` | `enforce` also shuts servers down. |
| `HCLOUD_TOKEN` | | Cloud API token (one project per install). |
| `MONTHLY_BUDGET_EUR` | | Required with a Cloud token. Alert above this run-rate. |
| `ROBOT_USER`, `ROBOT_PASSWORD` | | Optional Robot webservice login. |
| `NTFY_URL` | | Required. `https://ntfy.sh/<topic>` or your own server. |
| `NTFY_TOKEN` | | Optional ntfy access token. |
| `HEALTHCHECK_URL` | | healthchecks.io ping URL. Required in enforce mode. |
| `TRAFFIC_WARN_PERCENT` | `50` | Alert at this share of included traffic. |
| `TRAFFIC_KILL_PERCENT` | `90` | Shut down at this share (at most 100). Also the alert level for dedicated-server quotas. |
| `KILL_OVERRIDES` | | Per-server thresholds, `<id>=<percent>,…` (at most 200). |
| `ROBOT_HOURLY_OUT_GB` | `200` | Dedicated-server alert: GB sent in one hour. |
| `ROBOT_DAILY_OUT_GB` | `2000` | Dedicated-server alert: GB sent in 24 hours. |
| `REMIND_HOURS` | `6` | Repeat an unresolved alert this often. |

## Security notes

- **The Cloud token is powerful.** It can create, stop and delete anything in its project, because Hetzner tokens can't be scoped more narrowly. So the guard host is now a place where a token like that can leak. Treat it as a production box: SSH keys only, no other services, and the env file readable only by root.
- **The service runs locked down,** as a throwaway systemd user with a read-only filesystem except for its own state directory, and no access to `/home`.
- **Logs, alerts and healthcheck messages never include tokens.**
- **Alerts include server names and spending**, so keep the ntfy topic private.

## Development

```sh
mise install        # Node, pnpm, gitleaks (or bring your own Node 24+)
pnpm install
pnpm check          # typecheck + tests
```

The decision logic lives in `src/evaluate.ts` as pure functions, and every rule has a test in `test/`.

## License

MIT
