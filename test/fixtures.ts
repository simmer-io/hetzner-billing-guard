import type { Config } from '../src/config.ts'
import type { CloudSnapshot, Server } from '../src/hcloud.ts'

export const TIB = 1024 ** 4

export const cfg = (over: Partial<Config> = {}): Config => ({
  mode: 'enforce',
  hcloudToken: 'x',
  ntfyUrl: 'https://ntfy.example/topic',
  trafficWarnPercent: 50,
  trafficKillPercent: 90,
  monthlyBudgetEur: 100,
  robotHourlyOutGb: 200,
  robotDailyOutGb: 2000,
  remindHours: 6,
  stateFile: '/dev/null',
  ...over
})

const money = (net: string) => ({ net, gross: net })

export const server = (over: Partial<Server> = {}): Server => ({
  id: 1,
  name: 'app',
  status: 'running',
  created: '2025-01-01T00:00:00Z',
  server_type: { name: 'cpx21', prices: [{ location: 'fsn1', price_monthly: money('10.99'), included_traffic: 20 * TIB, price_per_tb_traffic: money('1.00') }] },
  location: { name: 'fsn1' },
  backup_window: null,
  outgoing_traffic: 0,
  included_traffic: 20 * TIB,
  ...over
})

export const cloud = (over: Partial<CloudSnapshot> = {}): CloudSnapshot => ({
  servers: [server()],
  volumes: [],
  snapshots: [],
  primaryIps: [],
  floatingIps: [],
  loadBalancers: [],
  pricing: {
    currency: 'EUR',
    image: { price_per_gb_month: money('0.0110') },
    volume: { price_per_gb_month: money('0.0440') },
    server_backup: { percentage: '20.00' },
    primary_ips: [{ type: 'ipv4', prices: [{ location: 'fsn1', price_monthly: money('0.50') }] }],
    floating_ips: []
  },
  ...over
})
