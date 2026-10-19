# Hetzner billing guard

Hetzner has no spending cap. This small script is one: it runs every 5 minutes on a machine **outside** Hetzner, and:

1. **Shuts Cloud servers down before they run into traffic overage.** Each Cloud server includes a monthly traffic allowance (20 TB in the EU) and Hetzner bills extra per TB beyond it. The guard alerts at 50% of the allowance and shuts the server down at 90%. A stopped server sends no traffic, so the bill stops growing.
2. **Alerts on anything new in your Cloud project.** A leaked API token's first move is usually to create servers. Every new server, volume, snapshot, IP or load balancer raises an alert.
3. **Alerts when the estimated monthly bill passes your budget**, with the biggest items listed.
4. **Watches dedicated (Robot) servers' traffic** and alerts on a busy hour or day. Dedicated servers on a 1 Gbit/s port have unmetered traffic, so this is an early warning for hotlinking or abuse, not a cap. The guard never acts on them.
5. **Tells you when it stops working.** Every run pings a [healthchecks.io](https://healthchecks.io) check, so if the guard dies, healthchecks.io alerts you.

Alerts go to [ntfy](https://ntfy.sh): a phone app, no account needed.

Version 1 of this tool ran as a GitHub Actions cron. GitHub disables scheduled workflows in repos with no activity for 60 days, which silently switched the guard off. Version 2 runs as a systemd timer and reports its own health.

## What it does and doesn't do

- **It never deletes anything.** It only shuts down or powers off Cloud servers, in `enforce` mode. Deleting would stop the server's own charge too, but it can't be undone. Budget and new-resource alerts ask you to act.
- **Powered-off Cloud servers are still billed** for the server itself. Shutting down caps the traffic charges, which are the part that can grow without limit.
- **A server stays down** while it's over the kill threshold: if you start it again, the next run stops it. To bring it back before the billing period resets, raise `TRAFFIC_KILL_PERCENT`.
- **The estimate uses today's list prices** from the API. Older servers on grandfathered prices cost less, so the estimate errs high.
- **Hetzner's traffic figures can lag** a little, so set the kill threshold with some headroom.
- **Shutdown escalates.** The guard sends a clean ACPI shutdown first. A server still running 3 minutes later gets a hard power-off.

## Setup

You need a small Linux host with systemd **outside Hetzner**, so it keeps working if Hetzner servers are stopped or the account is in trouble. Any $4–6/month VM works. It also needs Node.js 24 or newer at `/usr/local/bin/node`. The guard has no runtime dependencies.

1. **Hetzner Cloud token:** Console → your project → Security → API tokens → *Read & Write*. Write is needed only to shut servers down. Make a dedicated token for the guard.
2. **Optional Robot user**, for dedicated servers: Robot → Settings → Webservice and app settings.
3. **ntfy topic:** pick a long random name and subscribe to it in the ntfy app. Anyone who knows the name can read or send to it.
4. **Optional healthchecks.io check:** period 5 minutes, grace 15 minutes.
5. **Install**, as root on the guard host:
   ```sh
   git clone https://github.com/simmer-io/hetzner-billing-guard /opt/src/hetzner-billing-guard
   cd /opt/src/hetzner-billing-guard && sh deploy/install.sh
   $EDITOR /etc/billing-guard/env          # from deploy/env.example; keep GUARD_MODE=dry-run at first
   node --env-file=/etc/billing-guard/env /opt/billing-guard/src/main.ts --test-alert
   systemctl enable --now billing-guard.timer
   journalctl -u billing-guard -f
   ```
6. **Switch to enforce** after a day of dry-run reports look right: set `GUARD_MODE=enforce` in `/etc/billing-guard/env`.

The first run records the resources that exist today and sends a "watching" notification. Only resources created after that raise new-resource alerts.

## Configuration

All settings are environment variables. See [`deploy/env.example`](deploy/env.example).

| Variable | Default | Meaning |
|---|---|---|
| `GUARD_MODE` | `dry-run` | `enforce` also shuts servers down. |
| `HCLOUD_TOKEN` | | Cloud API token (one project per install). |
| `MONTHLY_BUDGET_EUR` | | Required with a Cloud token. Alert above this estimate. |
| `ROBOT_USER`, `ROBOT_PASSWORD` | | Optional Robot webservice login. |
| `NTFY_URL` | | Required. `https://ntfy.sh/<topic>` or your own server. |
| `NTFY_TOKEN` | | Optional ntfy access token. |
| `HEALTHCHECK_URL` | | Optional healthchecks.io ping URL. |
| `TRAFFIC_WARN_PERCENT` | `50` | Alert at this share of included traffic. |
| `TRAFFIC_KILL_PERCENT` | `90` | Shut down at this share. |
| `ROBOT_HOURLY_OUT_GB` | `200` | Dedicated-server alert: GB sent in one hour. |
| `ROBOT_DAILY_OUT_GB` | `2000` | Dedicated-server alert: GB sent today (UTC). |
| `REMIND_HOURS` | `6` | Repeat an unresolved alert this often. |

## Security notes

- The Cloud token can stop and start servers in its project, and Hetzner tokens can't be scoped more narrowly. So treat the guard host like a production box: SSH keys only, no other services, and the env file readable only by root.
- The service runs as a throwaway systemd user with a read-only filesystem, except for its own state directory.
- Error messages and logs never include tokens.

## Development

```sh
mise install        # Node, pnpm, gitleaks (or bring your own Node 24+)
pnpm install
pnpm check          # typecheck + tests
```

The decision logic lives in `src/evaluate.ts` as pure functions, and every rule has a test in `test/`.

## License

MIT
