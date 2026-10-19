// Read-only client for the Hetzner Robot webservice (dedicated servers,
// https://robot.hetzner.com/doc/webservice/en.html). The guard only reads traffic and never acts on
// dedicated servers.
// - 1 Gbit/s servers have unmetered traffic ("unlimited"): alerts are an early warning for abuse.
// - Servers with a traffic quota (e.g. 10 Gbit/s uplinks, "20 TB") are billed per TB beyond it, so
//   month-to-date traffic is checked against the quota.
// Robot only reports completed hours and days. Hours are taken as UTC (the docs don't say), so the
// newest data is the last completed UTC hour; if Robot's hours are local German time, they are older
// and still complete. Robot allows 200 requests per hour; one run makes at most 4.

import { why } from './hcloud.ts'

const API = 'https://robot-ws.your-server.de'
const TIMEOUT_MS = 15_000
const HOUR = 3_600_000

export interface DedicatedTraffic {
  name: string
  /** IPv4 addresses and IPv6 subnets watched. Empty means the server can't be watched. */
  addresses: string[]
  /** GB sent in the last completed hour, and in the 24 completed hours up to it. */
  lastHourOutGb: number
  last24hOutGb: number
  /** For servers with a traffic quota: the quota and the GB sent this month (completed hours). */
  quotaGb?: number
  monthOutGb?: number
}

export class RobotError extends Error {}

interface RobotServer {
  server_ip: string | null
  server_name: string
  traffic?: string
  ip?: string[] | null
  subnet?: { ip: string, mask: string }[] | null
}
type Buckets = Record<string, Record<string, { out?: number }>>

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const hh = (d: Date) => String(d.getUTCHours()).padStart(2, '0')

/** "20 TB" → 20000 GB. Decimal, so a quota alert comes early rather than late. null for "unlimited". */
export function quotaGb(traffic: string | undefined): number | null {
  const m = /^\s*([\d.]+)\s*(TB|GB)\s*$/i.exec(traffic ?? '')
  if (!m) return null
  return Number(m[1]) * (m[2]!.toUpperCase() === 'TB' ? 1000 : 1)
}

export class Robot {
  #auth: string
  constructor(user: string, password: string) {
    this.#auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
  }

  async #request<T>(path: string, form?: URLSearchParams): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${API}${path}`, {
        method: form ? 'POST' : 'GET',
        headers: { Authorization: this.#auth, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (e) {
      throw new RobotError(`${path}: ${why(e)}`)
    }
    // For /traffic, 404 means none of the addresses were found: a wrong list, not "no traffic".
    if (!res.ok) throw new RobotError(`${path}: HTTP ${res.status}`)
    return res.json() as Promise<T>
  }

  async #traffic(type: 'day' | 'month', from: string, to: string, ips: string[], subnets: string[]): Promise<Buckets> {
    const form = new URLSearchParams({ type, from, to, single_values: 'true' })
    for (const ip of ips) form.append('ip[]', ip)
    for (const s of subnets) form.append('subnet[]', s)
    const body = await this.#request<{ traffic?: { data?: Buckets } }>('/traffic', form)
    return body.traffic?.data ?? {}
  }

  async traffic(now: Date): Promise<DedicatedTraffic[]> {
    const servers = (await this.#request<{ server: RobotServer }[]>('/server')).map(s => s.server)
    const watched = servers.map((s) => {
      const ips = [...new Set([s.server_ip, ...(s.ip ?? [])].filter((x): x is string => !!x))]
      const subnets = (s.subnet ?? []).map(x => x.ip)
      return { s, ips, subnets }
    })
    const allIps = watched.flatMap(w => w.ips)
    const allSubnets = watched.flatMap(w => w.subnets)
    if (!allIps.length && !allSubnets.length) return watched.map(w => ({ name: w.s.server_name, addresses: [], lastHourOutGb: 0, last24hOutGb: 0 }))

    // The 24 completed hours ending with the last completed one, split at midnight (one request per day).
    const last = new Date(Math.floor(now.getTime() / HOUR) * HOUR - HOUR)
    const first = new Date(last.getTime() - 23 * HOUR)
    const days = ymd(first) === ymd(last) ? [[first, last]] : [[first, new Date(`${ymd(first)}T23:00:00Z`)], [new Date(`${ymd(last)}T00:00:00Z`), last]]
    const hourly: { day: string, data: Buckets }[] = []
    for (const [a, b] of days) hourly.push({ day: ymd(a!), data: await this.#traffic('day', `${ymd(a!)}T${hh(a!)}`, `${ymd(b!)}T${hh(b!)}`, allIps, allSubnets) })

    // Month to date for servers with a quota: completed days before today, plus today's completed hours.
    const metered = watched.some(w => quotaGb(w.s.traffic) !== null)
    const today = ymd(last)
    const monthStart = `${today.slice(0, 8)}01`
    let daily: Buckets = {}
    if (metered && today !== monthStart) {
      const yesterday = ymd(new Date(Date.parse(`${today}T00:00:00Z`) - 24 * HOUR))
      daily = await this.#traffic('month', monthStart, yesterday, allIps, allSubnets)
    }

    const sum = (b: Record<string, { out?: number }> | undefined, pick: (key: string) => boolean = () => true) =>
      Object.entries(b ?? {}).filter(([k]) => pick(k)).reduce((a, [, v]) => a + (v.out ?? 0), 0)
    const lastHourKey = (k: string) => Number(k.slice(-2)) === last.getUTCHours()

    return watched.map(({ s, ips, subnets }) => {
      const addresses = [...ips, ...subnets]
      let last24hOutGb = 0
      let lastHourOutGb = 0
      let todayOutGb = 0
      for (const addr of addresses) {
        for (const h of hourly) {
          last24hOutGb += sum(h.data[addr])
          if (h.day === today) {
            lastHourOutGb += sum(h.data[addr], lastHourKey)
            todayOutGb += sum(h.data[addr])
          }
        }
      }
      const quota = quotaGb(s.traffic)
      const t: DedicatedTraffic = { name: s.server_name, addresses, lastHourOutGb, last24hOutGb }
      if (quota !== null) {
        t.quotaGb = quota
        t.monthOutGb = addresses.reduce((a, addr) => a + sum(daily[addr]), 0) + todayOutGb
      }
      return t
    })
  }
}
