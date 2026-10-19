// Read-mostly client for the Hetzner Cloud API (https://docs.hetzner.cloud). The only writes are
// the shutdown and poweroff server actions.

const API = 'https://api.hetzner.cloud/v1'
const TIMEOUT_MS = 15_000
/** 50 per page × 20 pages: far more than we run, and a hard stop on a runaway loop. */
const MAX_PAGES = 20

interface Money { net: string, gross: string }
interface LocationPrice { location: string, price_monthly: Money, included_traffic?: number, price_per_tb_traffic?: Money }

export interface Server {
  id: number
  name: string
  status: string
  created: string
  server_type: { name: string, prices: LocationPrice[] }
  location: { name: string }
  backup_window: string | null
  outgoing_traffic: number | null
  included_traffic: number | null
}

export interface Volume { id: number, name: string, size: number, location: { name: string } }
export interface Image { id: number, type: string, description: string, image_size: number | null, created: string }
export interface PrimaryIp { id: number, name: string, type: string, location?: { name: string } }
export interface FloatingIp { id: number, name: string, type: string, home_location: { name: string } }
export interface LoadBalancer {
  id: number
  name: string
  location: { name: string }
  load_balancer_type: { name: string, prices: LocationPrice[] }
  outgoing_traffic: number | null
  included_traffic: number
}

export interface Pricing {
  currency: string
  image: { price_per_gb_month: Money }
  volume: { price_per_gb_month: Money }
  server_backup: { percentage: string }
  primary_ips: { type: string, prices: LocationPrice[] }[]
  floating_ips: { type: string, prices: LocationPrice[] }[]
}

export interface CloudSnapshot {
  servers: Server[]
  volumes: Volume[]
  snapshots: Image[]
  primaryIps: PrimaryIp[]
  floatingIps: FloatingIp[]
  loadBalancers: LoadBalancer[]
  pricing: Pricing
}

export class HcloudError extends Error {}

export class Hcloud {
  #token: string
  constructor(token: string) {
    this.#token = token
  }

  async #request<T>(method: 'GET' | 'POST', path: string): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.#token}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        body: method === 'POST' ? '{}' : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (e) {
      throw new HcloudError(`${method} ${path}: ${(e as Error).name}`)
    }
    if (!res.ok) {
      // The error body names the problem (e.g. "unauthorized"); it never echoes the token.
      const body = await res.json().catch(() => undefined) as { error?: { code?: string } } | undefined
      throw new HcloudError(`${method} ${path}: HTTP ${res.status}${body?.error?.code ? ` ${body.error.code}` : ''}`)
    }
    return res.json() as Promise<T>
  }

  async #list<T>(path: string, key: string): Promise<T[]> {
    const out: T[] = []
    const sep = path.includes('?') ? '&' : '?'
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.#request<Record<string, unknown> & { meta?: { pagination?: { next_page: number | null } } }>('GET', `${path}${sep}per_page=50&page=${page}`)
      out.push(...(body[key] as T[]))
      if (!body.meta?.pagination?.next_page) return out
    }
    throw new HcloudError(`GET ${path}: more than ${MAX_PAGES} pages`)
  }

  async snapshot(): Promise<CloudSnapshot> {
    const [servers, volumes, snapshots, primaryIps, floatingIps, loadBalancers, pricing] = await Promise.all([
      this.#list<Server>('/servers', 'servers'),
      this.#list<Volume>('/volumes', 'volumes'),
      this.#list<Image>('/images?type=snapshot', 'images'),
      this.#list<PrimaryIp>('/primary_ips', 'primary_ips'),
      this.#list<FloatingIp>('/floating_ips', 'floating_ips'),
      this.#list<LoadBalancer>('/load_balancers', 'load_balancers'),
      this.#request<{ pricing: Pricing }>('GET', '/pricing').then(b => b.pricing)
    ])
    return { servers, volumes, snapshots, primaryIps, floatingIps, loadBalancers, pricing }
  }

  /** ACPI shutdown: lets the OS stop cleanly (databases flush). */
  async shutdown(id: number) {
    await this.#request('POST', `/servers/${id}/actions/shutdown`)
  }

  /** Hard power-off, for a server that ignored the shutdown. */
  async poweroff(id: number) {
    await this.#request('POST', `/servers/${id}/actions/poweroff`)
  }
}
