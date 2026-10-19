// Read-only client for the Hetzner Robot webservice (dedicated servers,
// https://robot.hetzner.com/doc/webservice/en.html). It only reads traffic: dedicated servers on a
// 1 Gbit/s port have unmetered traffic, so this is an early warning, not a cap.
// Robot allows 200 requests per hour; one run makes two.

const API = 'https://robot-ws.your-server.de'
const TIMEOUT_MS = 15_000

export interface DedicatedTraffic {
  name: string
  ip: string
  /** GB sent so far today (UTC), and in the busiest hour of today. */
  todayOutGb: number
  peakHourOutGb: number
}

export class RobotError extends Error {}

type Values = Record<string, { out?: number }>

export class Robot {
  #auth: string
  constructor(user: string, password: string) {
    this.#auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
  }

  async #request<T>(path: string, form?: URLSearchParams): Promise<T | undefined> {
    let res: Response
    try {
      res = await fetch(`${API}${path}`, {
        method: form ? 'POST' : 'GET',
        headers: { Authorization: this.#auth, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (e) {
      throw new RobotError(`${path}: ${(e as Error).name}`)
    }
    // 404 means no data yet (for example just after midnight).
    if (res.status === 404) return undefined
    if (!res.ok) throw new RobotError(`${path}: HTTP ${res.status}`)
    return res.json() as Promise<T>
  }

  async traffic(now: Date): Promise<DedicatedTraffic[]> {
    const servers = (await this.#request<{ server: { server_ip: string | null, server_name: string } }[]>('/server')) ?? []
    const targets = servers.map(s => s.server).filter(s => s.server_ip)
    if (!targets.length) return []

    const day = now.toISOString().slice(0, 10)
    const form = new URLSearchParams({ type: 'day', from: `${day}T00`, to: `${day}T${String(now.getUTCHours()).padStart(2, '0')}`, single_values: 'true' })
    for (const t of targets) form.append('ip[]', t.server_ip!)
    const body = await this.#request<{ traffic: { data: Record<string, Values> } }>('/traffic', form)
    const data = body?.traffic.data ?? {}

    return targets.map((t) => {
      const hours = Object.values(data[t.server_ip!] ?? {}).map(v => v.out ?? 0)
      return {
        name: t.server_name,
        ip: t.server_ip!,
        todayOutGb: hours.reduce((a, b) => a + b, 0),
        peakHourOutGb: Math.max(0, ...hours)
      }
    })
  }
}
