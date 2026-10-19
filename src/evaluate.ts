// The guard's decisions, as pure functions over what the APIs returned: which alerts to raise, which
// servers to stop, and the estimated monthly run-rate. No I/O here, so every rule is unit-tested.

import type { Config } from './config.ts'
import type { Inventory, LocationPrice, Server } from './hcloud.ts'
import type { DedicatedTraffic } from './robot.ts'

export interface State {
  version: 1
  /** Cloud resources seen so far ("server:123"). Undefined until the first run records a baseline. */
  known?: string[]
  /** New resources whose alert hasn't been delivered yet (key → label). Cleared only after delivery. */
  pendingNew: Record<string, string>
  /** When each alert key was last sent, for reminders. */
  lastSent: Record<string, string>
  /** When the guard last asked a server to stop, so a server that ignores it gets powered off. */
  shutdownAt: Record<string, string>
}

export const emptyState = (): State => ({ version: 1, pendingNew: {}, lastSent: {}, shutdownAt: {} })

export interface Alert {
  key: string
  priority: 'urgent' | 'high' | 'default'
  title: string
  message: string
  /** Send even if this key was sent recently (a new event, not a reminder). */
  force?: boolean
  /** Remind this often instead of every REMIND_HOURS. */
  remindMinutes?: number
}

export interface Action {
  kind: 'shutdown' | 'poweroff'
  serverId: number
  serverName: string
}

export interface Inputs {
  /** Undefined when the server list couldn't be read. */
  servers?: Server[]
  inventory?: Inventory
  dedicated?: DedicatedTraffic[]
}

/** A server still not off this long after a stop request gets a (repeated) hard power-off. */
export const POWEROFF_AFTER_MS = 3 * 60_000
/** New-resource alerts list at most this many resources by name. */
const LIST_MAX = 10
const TIB = 1024 ** 4
const money = (n: number, currency: string) => `${currency === 'EUR' ? '€' : `${currency} `}${n.toFixed(2)}`
const tib = (bytes: number) => (bytes / TIB).toFixed(2)
const price = (s: string | undefined) => (s ? Number(s) : 0)

/** The price for a location, or else the highest price for any location (so the estimate errs high). */
function priceAt(prices: LocationPrice[] | undefined, location: string | undefined): LocationPrice | undefined {
  const exact = prices?.find(p => p.location === location)
  if (exact) return exact
  return [...(prices ?? [])].sort((a, b) => price(b.price_monthly.net) - price(a.price_monthly.net))[0]
}

/** A server's included traffic: from the server, or else from its type's price list. */
export function includedTraffic(s: Server): number | undefined {
  return s.included_traffic || priceAt(s.server_type.prices, s.location.name)?.included_traffic || undefined
}

export interface Estimate {
  total: number
  currency: string
  items: { label: string, amount: number }[]
  /** Things that exist but have no price in the API: the total is too low by their cost. */
  unpriced: string[]
}

/**
 * Estimated monthly run-rate of everything in the project now, at list prices, plus traffic overage
 * so far. It isn't the month-to-date bill (resources deleted earlier this month are missing), and
 * grandfathered servers are billed below list price, so it errs high for what exists.
 */
export function estimateMonthly(servers: Server[], inv: Required<Inventory>): Estimate {
  const p = inv.pricing
  const items: Estimate['items'] = []
  const unpriced: string[] = []
  const add = (label: string, lp: LocationPrice | undefined, amount: (lp: LocationPrice) => number) => {
    if (!lp) unpriced.push(label)
    else items.push({ label, amount: amount(lp) })
  }
  const backupFactor = 1 + price(p.server_backup.percentage) / 100

  for (const s of servers) {
    const lp = priceAt(s.server_type.prices, s.location.name)
    add(`server ${s.name} (${s.server_type.name}${s.backup_window ? ', backups' : ''})`, lp, x => price(x.price_monthly.net) * (s.backup_window ? backupFactor : 1))
    const over = Math.max(0, (s.outgoing_traffic ?? 0) - (includedTraffic(s) ?? 0))
    if (over > 0) add(`traffic overage ${s.name} (${tib(over)} TiB)`, lp, x => (over / TIB) * price(x.price_per_tb_traffic?.net))
  }
  for (const v of inv.volumes) items.push({ label: `volume ${v.name} (${v.size} GB)`, amount: v.size * price(p.volume.price_per_gb_month.net) })
  for (const i of inv.snapshots) items.push({ label: `snapshot ${i.description || i.id} (${(i.image_size ?? 0).toFixed(1)} GB)`, amount: (i.image_size ?? 0) * price(p.image.price_per_gb_month.net) })
  for (const ip of inv.primaryIps) {
    // IPv6 primary IPs are free.
    if (ip.type === 'ipv6') continue
    add(`primary ${ip.type} ${ip.name}`, priceAt(p.primary_ips.find(x => x.type === ip.type)?.prices, ip.location?.name), x => price(x.price_monthly.net))
  }
  for (const ip of inv.floatingIps) add(`floating ${ip.type} ${ip.name}`, priceAt(p.floating_ips.find(x => x.type === ip.type)?.prices, ip.home_location.name), x => price(x.price_monthly.net))
  for (const lb of inv.loadBalancers) {
    const lp = priceAt(lb.load_balancer_type.prices, lb.location.name)
    add(`load balancer ${lb.name}`, lp, x => price(x.price_monthly.net))
    const over = Math.max(0, (lb.outgoing_traffic ?? 0) - lb.included_traffic)
    if (over > 0) add(`traffic overage ${lb.name} (${tib(over)} TiB)`, lp, x => (over / TIB) * price(x.price_per_tb_traffic?.net))
  }
  for (const b of inv.storageBoxes) add(`storage box ${b.name} (${b.storage_box_type.name})`, priceAt(b.storage_box_type.prices, b.location.name), x => price(x.price_monthly.net))
  items.sort((a, b) => b.amount - a.amount)
  return { total: items.reduce((a, b) => a + b.amount, 0), currency: p.currency, items, unpriced }
}

type Kind = 'server' | 'volume' | 'snapshot' | 'primary_ip' | 'floating_ip' | 'load_balancer' | 'storage_box'
const KIND_OF: Record<Kind, keyof Inventory | 'servers'> = {
  server: 'servers', volume: 'volumes', snapshot: 'snapshots', primary_ip: 'primaryIps', floating_ip: 'floatingIps', load_balancer: 'loadBalancers', storage_box: 'storageBoxes'
}

/** Resource keys and labels for every kind that could be read. */
function resources(servers: Server[], inv: Inventory): Map<string, string> {
  const m = new Map<string, string>()
  for (const s of servers) m.set(`server:${s.id}`, `server ${s.name} (${s.server_type.name}, ${s.location.name})`)
  for (const v of inv.volumes ?? []) m.set(`volume:${v.id}`, `volume ${v.name} (${v.size} GB)`)
  for (const i of inv.snapshots ?? []) m.set(`snapshot:${i.id}`, `snapshot ${i.description || i.id}`)
  for (const ip of inv.primaryIps ?? []) m.set(`primary_ip:${ip.id}`, `primary ${ip.type} ${ip.name}`)
  for (const ip of inv.floatingIps ?? []) m.set(`floating_ip:${ip.id}`, `floating ${ip.type} ${ip.name}`)
  for (const lb of inv.loadBalancers ?? []) m.set(`load_balancer:${lb.id}`, `load balancer ${lb.name}`)
  for (const b of inv.storageBoxes ?? []) m.set(`storage_box:${b.id}`, `storage box ${b.name} (${b.storage_box_type.name})`)
  return m
}

const PARTS = ['volumes', 'snapshots', 'primaryIps', 'floatingIps', 'loadBalancers', 'storageBoxes', 'pricing'] as const
/** Every part of the inventory was read (the budget check needs all of it). */
export function complete(inv: Inventory): inv is Required<Inventory> {
  return PARTS.every(k => inv[k] !== undefined)
}

const isOff = (s: Server) => s.status === 'off' || s.status === 'deleting'

export function evaluate(inputs: Inputs, cfg: Config, prev: State, now: Date) {
  const alerts: Alert[] = []
  const actions: Action[] = []
  /** Reasons the guard couldn't fully do its job this run: the run is reported as failed. */
  const problems: string[] = []
  const state: State = { ...prev, pendingNew: { ...prev.pendingNew }, lastSent: { ...prev.lastSent }, shutdownAt: { ...prev.shutdownAt } }
  const dry = cfg.mode === 'dry-run'

  // 1. Traffic: warn, then stop the server before it runs into paid overage.
  for (const s of inputs.servers ?? []) {
    if (isOff(s)) delete state.shutdownAt[s.id]
    const included = includedTraffic(s)
    if (!included || s.outgoing_traffic == null) {
      problems.push(`no traffic figures for server ${s.name}`)
      alerts.push({ key: `traffic-unknown:${s.id}`, priority: 'urgent', title: `Hetzner billing guard: can't see ${s.name}'s traffic`, message: `The API returned no ${s.outgoing_traffic == null ? 'outgoing' : 'included'} traffic for ${s.name}, so its traffic cap isn't working. Check it in the console.` })
      continue
    }
    const kill = cfg.killOverrides[s.id] ?? cfg.trafficKillPercent
    const pct = (s.outgoing_traffic / included) * 100
    const usage = `${tib(s.outgoing_traffic)} of ${tib(included)} TiB (${pct.toFixed(1)}%)`
    if (pct >= kill) {
      let what = 'It is off.'
      if (!isOff(s)) {
        const asked = state.shutdownAt[s.id]
        if (!asked) {
          actions.push({ kind: 'shutdown', serverId: s.id, serverName: s.name })
          what = dry ? `Dry-run: would shut it down (it is ${s.status}).` : 'Shutting it down.'
        } else if (now.getTime() - Date.parse(asked) >= POWEROFF_AFTER_MS) {
          actions.push({ kind: 'poweroff', serverId: s.id, serverName: s.name })
          what = `It is still ${s.status} after a stop request; powering it off.`
        } else {
          what = `Stop requested; it is ${s.status}.`
        }
      }
      alerts.push({
        key: `traffic-kill:${s.id}`,
        priority: 'urgent',
        title: `Hetzner traffic: ${s.name} over ${kill}%`,
        message: `${s.name} has sent ${usage} of its included traffic this month. ${what} It stays down while over ${kill}%. To bring just this server back, set KILL_OVERRIDES=${s.id}=<higher percent>.`,
        // A real stop is news; in dry-run the same "would stop" is a reminder.
        force: !dry && actions.some(a => a.serverId === s.id && a.kind === 'shutdown')
      })
    } else if (pct >= cfg.trafficWarnPercent) {
      alerts.push({ key: `traffic-warn:${s.id}`, priority: 'high', title: `Hetzner traffic: ${s.name} at ${pct.toFixed(0)}%`, message: `${s.name} has sent ${usage} of its included traffic. It is shut down at ${kill}%.` })
    }
  }
  for (const lb of inputs.inventory?.loadBalancers ?? []) {
    const pct = lb.included_traffic ? ((lb.outgoing_traffic ?? 0) / lb.included_traffic) * 100 : 0
    if (pct >= cfg.trafficWarnPercent) {
      alerts.push({ key: `traffic-lb:${lb.id}`, priority: 'urgent', title: `Hetzner traffic: load balancer ${lb.name} at ${pct.toFixed(0)}%`, message: `Load balancer ${lb.name} has sent ${pct.toFixed(1)}% of its included traffic. The guard can't stop load balancers; act in the console.` })
    }
  }

  // 2. Anything new in the project: a leaked token's first move is creating servers.
  if (inputs.servers && inputs.inventory) {
    const current = resources(inputs.servers, inputs.inventory)
    // A kind that couldn't be read keeps its old keys, so it doesn't look "new" when it comes back.
    const unread = (Object.keys(KIND_OF) as Kind[]).filter(k => k !== 'server' && inputs.inventory![KIND_OF[k] as keyof Inventory] === undefined)
    const carried = (prev.known ?? []).filter(key => unread.some(k => key.startsWith(`${k}:`)))
    if (prev.known) {
      const known = new Set(prev.known)
      const pending: Record<string, string> = {}
      for (const [key, label] of Object.entries(prev.pendingNew)) if (current.has(key)) pending[key] = label
      let fresh = 0
      for (const [key, label] of current) {
        if (!known.has(key)) {
          pending[key] = label
          fresh++
        }
      }
      const labels = Object.values(pending)
      if (labels.length) {
        const list = labels.slice(0, LIST_MAX).join('; ') + (labels.length > LIST_MAX ? `; and ${labels.length - LIST_MAX} more` : '')
        alerts.push({
          key: 'new-resources',
          priority: 'high',
          title: `Hetzner: ${labels.length} new resource${labels.length > 1 ? 's' : ''}`,
          message: `New in the Hetzner Cloud project: ${list}. If you didn't create ${labels.length > 1 ? 'them' : 'it'}, revoke the API tokens and delete ${labels.length > 1 ? 'them' : 'it'}.`,
          // Also resend an alert that wasn't delivered last run.
          force: fresh > 0 || Object.keys(prev.pendingNew).length > 0
        })
      }
      state.pendingNew = pending
    } else {
      alerts.push({ key: 'baseline', priority: 'default', title: 'Hetzner billing guard is watching', message: `First run (${cfg.mode}). Recorded ${current.size} existing Cloud resources; anything new from now on raises an alert.${cfg.healthcheckUrl ? '' : ' No HEALTHCHECK_URL is set, so nothing will tell you if the guard stops running.'}`, force: true })
      state.pendingNew = {}
    }
    state.known = [...new Set([...current.keys(), ...carried])].sort()

    // 3. The estimated monthly run-rate against the budget. Needs the complete inventory.
    const inv = inputs.inventory
    if (complete(inv)) {
      const est = estimateMonthly(inputs.servers, inv)
      const fmt = (n: number) => money(n, est.currency)
      if (est.currency !== 'EUR') {
        alerts.push({ key: 'currency', priority: 'default', title: 'Hetzner billing guard: account is not billed in EUR', message: `Prices come back in ${est.currency}; MONTHLY_BUDGET_EUR is compared in ${est.currency}.` })
      }
      if (est.unpriced.length) {
        alerts.push({ key: 'unpriced', priority: 'high', title: 'Hetzner billing guard: some resources have no price', message: `The estimate leaves these out, so the real bill is higher: ${est.unpriced.slice(0, LIST_MAX).join('; ')}.` })
      }
      if (est.total > cfg.monthlyBudget!) {
        const top = est.items.slice(0, 5).map(i => `${i.label}: ${fmt(i.amount)}`).join('; ')
        alerts.push({ key: 'budget', priority: 'urgent', title: `Hetzner: estimated ${fmt(est.total)}/mo, over budget`, message: `Estimated monthly run-rate ${fmt(est.total)} (list prices, excl. VAT) is over MONTHLY_BUDGET_EUR ${fmt(cfg.monthlyBudget!)}. Biggest items: ${top}. The guard doesn't delete anything; check the console.` })
      }
    }
  }

  // 4. Dedicated servers: alerts only.
  for (const d of inputs.dedicated ?? []) {
    if (!d.addresses.length) {
      alerts.push({ key: `robot-unwatched:${d.name}`, priority: 'high', title: `Hetzner billing guard: ${d.name} has no addresses`, message: `Robot lists no IP or subnet for ${d.name}, so its traffic isn't watched.` })
      continue
    }
    if (d.lastHourOutGb > cfg.robotHourlyOutGb) {
      alerts.push({ key: `robot-hour:${d.name}`, priority: 'high', title: `Hetzner traffic: ${d.name} ${d.lastHourOutGb.toFixed(0)} GB in an hour`, message: `${d.name} sent ${d.lastHourOutGb.toFixed(1)} GB in the last completed hour (limit ${cfg.robotHourlyOutGb} GB). Look for hotlinking or a crawler.` })
    }
    if (d.last24hOutGb > cfg.robotDailyOutGb) {
      alerts.push({ key: `robot-day:${d.name}`, priority: 'high', title: `Hetzner traffic: ${d.name} ${d.last24hOutGb.toFixed(0)} GB in 24h`, message: `${d.name} has sent ${d.last24hOutGb.toFixed(1)} GB in the last 24 completed hours (limit ${cfg.robotDailyOutGb} GB).` })
    }
    if (d.quotaGb !== undefined && d.monthOutGb !== undefined) {
      const pct = (d.monthOutGb / d.quotaGb) * 100
      if (pct >= cfg.trafficWarnPercent) {
        const over = pct >= cfg.trafficKillPercent
        alerts.push({ key: `robot-quota:${d.name}`, priority: over ? 'urgent' : 'high', title: `Hetzner traffic: ${d.name} at ${pct.toFixed(0)}% of its quota`, message: `${d.name} has sent ${d.monthOutGb.toFixed(0)} of its ${d.quotaGb.toFixed(0)} GB monthly quota; beyond it Hetzner bills per TB. The guard doesn't stop dedicated servers${over ? ': act now in Robot' : ''}.` })
      }
    }
  }

  return { alerts, actions, state, problems }
}

/** At most this many alerts per run; the rest are summarized in one more. */
export const MAX_SENDS = 8

/**
 * Which alerts to send now: new events always, ongoing problems once per reminder interval. Keys that
 * are no longer raised are forgotten, so a problem that comes back alerts straight away.
 */
export function due(alerts: Alert[], state: State, now: Date, remindHours: number) {
  const lastSent: Record<string, string> = {}
  let send: Alert[] = []
  for (const a of alerts) {
    const last = state.lastSent[a.key]
    const every = (a.remindMinutes ?? remindHours * 60) * 60_000
    if (a.force || !last || now.getTime() - Date.parse(last) >= every) send.push(a)
    else lastSent[a.key] = last
  }
  // Most urgent first; anything past the cap is folded into one summary (and stays due next run).
  const rank = { urgent: 0, high: 1, default: 2 }
  send.sort((a, b) => rank[a.priority] - rank[b.priority])
  if (send.length > MAX_SENDS) {
    const rest = send.slice(MAX_SENDS - 1)
    send = [...send.slice(0, MAX_SENDS - 1), { key: 'more', priority: rest[0]!.priority, title: `Hetzner billing guard: ${rest.length} more alerts`, message: rest.map(a => a.title).join('; '), force: true }]
  }
  for (const a of send) if (a.key !== 'more') lastSent[a.key] = now.toISOString()
  return { send, lastSent }
}
