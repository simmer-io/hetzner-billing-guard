// Read-mostly client for the Hetzner Cloud API (https://docs.hetzner.cloud). The only writes are
// the shutdown and poweroff server actions.

const API = 'https://api.hetzner.cloud/v1'
/** Storage Boxes moved to the newer Hetzner API; the same project token works there. */
const HETZNER_API = 'https://api.hetzner.com/v1'
const TIMEOUT_MS = 15_000
/** 50 per page × 20 pages: far more than we run, and a hard stop on a runaway loop. */
const MAX_PAGES = 20

interface Money { net: string, gross: string }
export interface LocationPrice { location: string, price_monthly: Money, included_traffic?: number, price_per_tb_traffic?: Money }

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
export interface StorageBox { id: number, name: string, location: { name: string }, storage_box_type: { name: string, prices: LocationPrice[] } }

export interface Pricing {
  currency: string
  image: { price_per_gb_month: Money }
  volume: { price_per_gb_month: Money }
  server_backup: { percentage: string }
  primary_ips: { type: string, prices: LocationPrice[] }[]
  floating_ips: { type: string, prices: LocationPrice[] }[]
}

/** Everything in the project except servers. A part is undefined when it couldn't be read. */
export interface Inventory {
  volumes?: Volume[]
  snapshots?: Image[]
  primaryIps?: PrimaryIp[]
  floatingIps?: FloatingIp[]
  loadBalancers?: LoadBalancer[]
  storageBoxes?: StorageBox[]
  pricing?: Pricing
}

export class HcloudError extends Error {}

/** A short, secret-free reason for a failed fetch: the error name plus its system code (ENOTFOUND, ETIMEDOUT…). */
export function why(e: unknown): string {
  const err = e as Error & { cause?: { code?: string } }
  return [err.name, err.cause?.code].filter(Boolean).join(' ')
}

export class Hcloud {
  #token: string
  constructor(token: string) {
    this.#token = token
  }

  async #request<T>(method: 'GET' | 'POST', path: string, base = API): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.#token}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        body: method === 'POST' ? '{}' : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (e) {
      throw new HcloudError(`${method} ${path}: ${why(e)}`)
    }
    if (!res.ok) {
      // The error body names the problem (e.g. "unauthorized"); it never echoes the token.
      const body = await res.json().catch(() => undefined) as { error?: { code?: string } } | undefined
      throw new HcloudError(`${method} ${path}: HTTP ${res.status}${body?.error?.code ? ` ${body.error.code}` : ''}`)
    }
    return res.json() as Promise<T>
  }

  async #list<T>(path: string, key: string, base = API): Promise<T[]> {
    const out: T[] = []
    const sep = path.includes('?') ? '&' : '?'
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.#request<Record<string, unknown> & { meta?: { pagination?: { next_page: number | null } } }>('GET', `${path}${sep}per_page=50&page=${page}`, base)
      const items = body[key]
      if (!Array.isArray(items)) throw new HcloudError(`GET ${path}: response has no "${key}" list`)
      out.push(...(items as T[]))
      if (!body.meta?.pagination?.next_page) return out
    }
    throw new HcloudError(`GET ${path}: more than ${MAX_PAGES} pages`)
  }

  /** Servers on their own: the traffic cap depends only on this, so nothing else can block it. */
  servers(): Promise<Server[]> {
    return this.#list<Server>('/servers', 'servers')
  }

  /** The rest of the project. Each part is read independently; failures come back as errors. */
  async inventory(): Promise<{ inventory: Inventory, errors: string[] }> {
    const parts = {
      volumes: this.#list<Volume>('/volumes', 'volumes'),
      snapshots: this.#list<Image>('/images?type=snapshot', 'images'),
      primaryIps: this.#list<PrimaryIp>('/primary_ips', 'primary_ips'),
      floatingIps: this.#list<FloatingIp>('/floating_ips', 'floating_ips'),
      loadBalancers: this.#list<LoadBalancer>('/load_balancers', 'load_balancers'),
      storageBoxes: this.#list<StorageBox>('/storage_boxes', 'storage_boxes', HETZNER_API),
      pricing: this.#request<{ pricing: Pricing }>('GET', '/pricing').then((b) => {
        if (!b.pricing?.currency) throw new HcloudError('GET /pricing: unexpected response')
        return b.pricing
      })
    }
    const keys = Object.keys(parts) as (keyof typeof parts)[]
    const settled = await Promise.allSettled(keys.map(k => parts[k]))
    const inventory: Record<string, unknown> = {}
    const errors: string[] = []
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') inventory[keys[i]!] = r.value
      else errors.push((r.reason as Error).message)
    })
    return { inventory: inventory as Inventory, errors }
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
