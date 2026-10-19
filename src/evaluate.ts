// The guard's decisions, as pure functions over what the APIs returned: which alerts to raise, which
// servers to stop, and the estimated monthly bill. No I/O here, so every rule is unit-tested.

import type { Config } from './config.ts'
import type { CloudSnapshot, Server } from './hcloud.ts'
import type { DedicatedTraffic } from './robot.ts'

export interface State {
  version: 1
  /** Cloud resources seen so far ("server:123"). Undefined until the first run records a baseline. */
  known?: string[]
  /** When each alert key was last sent, for reminders. */
  lastSent: Record<string, string>
  /** When the guard asked a server to shut down, so a server that ignores it gets powered off. */
  shutdownAt: Record<string, string>
}

export const emptyState = (): State => ({ version: 1, lastSent: {}, shutdownAt: {} })

export interface Alert {
  key: string
  priority: 'urgent' | 'high' | 'default'
  title: string
  message: string
  /** Send even if this key was sent recently (a new event, not a reminder). */
  force?: boolean
}

export interface Action {
  kind: 'shutdown' | 'poweroff'
  serverId: number
  serverName: string
}

export interface Inputs {
  cloud?: CloudSnapshot
  dedicated?: DedicatedTraffic[]
}

/** A server that ignores the ACPI shutdown this long gets a hard power-off. */
export const POWEROFF_AFTER_MS = 3 * 60_000
const TIB = 1024 ** 4
const eur = (n: number) => `€${n.toFixed(2)}`
const tib = (bytes: number) => (bytes / TIB).toFixed(2)
const price = (s: string | undefined) => (s ? Number(s) : 0)

export interface Estimate {
  total: number
  items: { label: string, eur: number }[]
}

/**
 * Estimated monthly cost of everything in the project at today's list prices, plus traffic overage
 * so far. Grandfathered servers are billed below list price, so this errs high.
 */
export function estimateMonthly(cloud: CloudSnapshot): Estimate {
  const p = cloud.pricing
  const items: Estimate['items'] = []
  const backupFactor = 1 + price(p.server_backup.percentage) / 100

  for (const s of cloud.servers) {
    const lp = s.server_type.prices.find(x => x.location === s.location.name)
    const base = price(lp?.price_monthly.net)
    items.push({ label: `server ${s.name} (${s.server_type.name}${s.backup_window ? ', backups' : ''})`, eur: s.backup_window ? base * backupFactor : base })
    const over = Math.max(0, (s.outgoing_traffic ?? 0) - (s.included_traffic ?? 0))
    if (over > 0) items.push({ label: `traffic overage ${s.name} (${tib(over)} TiB)`, eur: (over / TIB) * price(lp?.price_per_tb_traffic?.net) })
  }
  for (const v of cloud.volumes) items.push({ label: `volume ${v.name} (${v.size} GB)`, eur: v.size * price(p.volume.price_per_gb_month.net) })
  for (const i of cloud.snapshots) items.push({ label: `snapshot ${i.description || i.id} (${(i.image_size ?? 0).toFixed(1)} GB)`, eur: (i.image_size ?? 0) * price(p.image.price_per_gb_month.net) })
  for (const ip of cloud.primaryIps) {
    const lp = p.primary_ips.find(x => x.type === ip.type)?.prices.find(x => x.location === ip.location?.name)
    items.push({ label: `primary ${ip.type} ${ip.name}`, eur: price(lp?.price_monthly.net) })
  }
  for (const ip of cloud.floatingIps) {
    const lp = p.floating_ips.find(x => x.type === ip.type)?.prices.find(x => x.location === ip.home_location.name)
    items.push({ label: `floating ${ip.type} ${ip.name}`, eur: price(lp?.price_monthly.net) })
  }
  for (const lb of cloud.loadBalancers) {
    const lp = lb.load_balancer_type.prices.find(x => x.location === lb.location.name)
    items.push({ label: `load balancer ${lb.name}`, eur: price(lp?.price_monthly.net) })
    const over = Math.max(0, (lb.outgoing_traffic ?? 0) - lb.included_traffic)
    if (over > 0) items.push({ label: `traffic overage ${lb.name} (${tib(over)} TiB)`, eur: (over / TIB) * price(lp?.price_per_tb_traffic?.net) })
  }
  items.sort((a, b) => b.eur - a.eur)
  return { total: items.reduce((a, b) => a + b.eur, 0), items }
}

function resourceKeys(cloud: CloudSnapshot): Map<string, string> {
  const m = new Map<string, string>()
  for (const s of cloud.servers) m.set(`server:${s.id}`, `server ${s.name} (${s.server_type.name}, ${s.location.name})`)
  for (const v of cloud.volumes) m.set(`volume:${v.id}`, `volume ${v.name} (${v.size} GB)`)
  for (const i of cloud.snapshots) m.set(`snapshot:${i.id}`, `snapshot ${i.description || i.id}`)
  for (const ip of cloud.primaryIps) m.set(`primary_ip:${ip.id}`, `primary ${ip.type} ${ip.name}`)
  for (const ip of cloud.floatingIps) m.set(`floating_ip:${ip.id}`, `floating ${ip.type} ${ip.name}`)
  for (const lb of cloud.loadBalancers) m.set(`load_balancer:${lb.id}`, `load balancer ${lb.name}`)
  return m
}

const running = (s: Server) => s.status === 'running' || s.status === 'starting'

export function evaluate(inputs: Inputs, cfg: Config, prev: State, now: Date) {
  const alerts: Alert[] = []
  const actions: Action[] = []
  const state: State = { ...prev, lastSent: { ...prev.lastSent }, shutdownAt: { ...prev.shutdownAt } }
  const dry = cfg.mode === 'dry-run'

  if (inputs.cloud) {
    const cloud = inputs.cloud

    // 1. Traffic: warn, then stop the server before it runs into paid overage.
    for (const s of cloud.servers) {
      if (!running(s)) delete state.shutdownAt[s.id]
      if (!s.included_traffic) continue
      const pct = ((s.outgoing_traffic ?? 0) / s.included_traffic) * 100
      const usage = `${tib(s.outgoing_traffic ?? 0)} of ${tib(s.included_traffic)} TiB (${pct.toFixed(1)}%)`
      if (pct >= cfg.trafficKillPercent) {
        let what = 'It is off.'
        if (running(s)) {
          const asked = state.shutdownAt[s.id]
          if (!asked) {
            actions.push({ kind: 'shutdown', serverId: s.id, serverName: s.name })
            what = dry ? 'Dry-run: would shut it down.' : 'Shutting it down.'
          } else if (now.getTime() - Date.parse(asked) >= POWEROFF_AFTER_MS) {
            actions.push({ kind: 'poweroff', serverId: s.id, serverName: s.name })
            what = 'It ignored the shutdown; powering it off.'
          } else {
            what = 'Shutdown requested; waiting for it to stop.'
          }
        }
        alerts.push({
          key: `traffic-kill:${s.id}`,
          priority: 'urgent',
          title: `Hetzner traffic: ${s.name} over ${cfg.trafficKillPercent}%`,
          message: `${s.name} has sent ${usage} of its included traffic this billing period. ${what} It stays down while it's over ${cfg.trafficKillPercent}%: raise TRAFFIC_KILL_PERCENT to bring it back.`,
          // A real stop is news; in dry-run the same "would stop" is a reminder.
          force: !dry && actions.some(a => a.serverId === s.id)
        })
      } else if (pct >= cfg.trafficWarnPercent) {
        alerts.push({ key: `traffic-warn:${s.id}`, priority: 'high', title: `Hetzner traffic: ${s.name} at ${pct.toFixed(0)}%`, message: `${s.name} has sent ${usage} of its included traffic. It is shut down at ${cfg.trafficKillPercent}%.` })
      }
    }
    for (const lb of cloud.loadBalancers) {
      const pct = lb.included_traffic ? ((lb.outgoing_traffic ?? 0) / lb.included_traffic) * 100 : 0
      if (pct >= cfg.trafficWarnPercent) {
        alerts.push({ key: `traffic-lb:${lb.id}`, priority: 'urgent', title: `Hetzner traffic: load balancer ${lb.name} at ${pct.toFixed(0)}%`, message: `Load balancer ${lb.name} has sent ${pct.toFixed(1)}% of its included traffic. The guard can't stop load balancers; act in the console.` })
      }
    }

    // 2. Anything new in the project: a leaked token's first move is creating servers.
    const current = resourceKeys(cloud)
    if (prev.known) {
      const known = new Set(prev.known)
      for (const [key, label] of current) {
        if (!known.has(key)) alerts.push({ key: `new:${key}`, priority: 'high', title: 'Hetzner: new resource', message: `New in the Hetzner Cloud project: ${label}. If you didn't create it, revoke the API tokens and delete it.`, force: true })
      }
    } else {
      alerts.push({ key: 'baseline', priority: 'default', title: 'Hetzner billing guard is watching', message: `First run (${cfg.mode}). Recorded ${current.size} existing Cloud resources; anything new from now on raises an alert.`, force: true })
    }
    state.known = [...current.keys()].sort()

    // 3. The estimated monthly bill against the budget.
    const est = estimateMonthly(cloud)
    if (est.total > cfg.monthlyBudgetEur!) {
      const top = est.items.slice(0, 5).map(i => `${i.label}: ${eur(i.eur)}`).join('; ')
      alerts.push({ key: 'budget', priority: 'urgent', title: `Hetzner: estimated ${eur(est.total)}/mo, over budget`, message: `Estimated monthly bill ${eur(est.total)} (list prices, excl. VAT) is over MONTHLY_BUDGET_EUR ${eur(cfg.monthlyBudgetEur!)}. Biggest items: ${top}. The guard doesn't delete anything; check the console.` })
    }
  }

  // 4. Dedicated servers: unmetered, so alerts only.
  for (const d of inputs.dedicated ?? []) {
    if (d.peakHourOutGb > cfg.robotHourlyOutGb) {
      alerts.push({ key: `robot-hour:${d.ip}`, priority: 'high', title: `Hetzner traffic: ${d.name} ${d.peakHourOutGb.toFixed(0)} GB in an hour`, message: `${d.name} sent ${d.peakHourOutGb.toFixed(1)} GB in one hour today (limit ${cfg.robotHourlyOutGb} GB). Look for hotlinking or a crawler.` })
    }
    if (d.todayOutGb > cfg.robotDailyOutGb) {
      alerts.push({ key: `robot-day:${d.ip}`, priority: 'high', title: `Hetzner traffic: ${d.name} ${d.todayOutGb.toFixed(0)} GB today`, message: `${d.name} has sent ${d.todayOutGb.toFixed(1)} GB today (UTC; limit ${cfg.robotDailyOutGb} GB).` })
    }
  }

  return { alerts, actions, state }
}

/**
 * Which alerts to send now: new events always, ongoing problems once per `remindHours`. Keys that
 * are no longer raised are forgotten, so a problem that comes back alerts straight away.
 */
export function due(alerts: Alert[], state: State, now: Date, remindHours: number) {
  const lastSent: Record<string, string> = {}
  const send: Alert[] = []
  for (const a of alerts) {
    const last = state.lastSent[a.key]
    if (a.force || !last || now.getTime() - Date.parse(last) >= remindHours * 3_600_000) {
      send.push(a)
      lastSent[a.key] = now.toISOString()
    } else {
      lastSent[a.key] = last
    }
  }
  return { send, lastSent }
}
