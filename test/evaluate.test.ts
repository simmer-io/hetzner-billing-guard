import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { due, emptyState, estimateMonthly, evaluate, POWEROFF_AFTER_MS, type State } from '../src/evaluate.ts'
import { cfg, cloud, server, TIB } from './fixtures.ts'

const now = new Date('2026-10-19T12:00:00Z')
const watched = (): State => ({ ...emptyState(), known: ['server:1'] })
const keys = (alerts: { key: string }[]) => alerts.map(a => a.key)

describe('traffic', () => {
  it('stays quiet under the warning threshold', () => {
    const r = evaluate({ cloud: cloud({ servers: [server({ outgoing_traffic: 9 * TIB })] }) }, cfg(), watched(), now)
    assert.deepEqual(r.alerts, [])
    assert.deepEqual(r.actions, [])
  })

  it('warns at the warning threshold without acting', () => {
    const r = evaluate({ cloud: cloud({ servers: [server({ outgoing_traffic: 10 * TIB })] }) }, cfg(), watched(), now)
    assert.deepEqual(keys(r.alerts), ['traffic-warn:1'])
    assert.deepEqual(r.actions, [])
  })

  it('shuts a running server down at the kill threshold, and says so right away', () => {
    const r = evaluate({ cloud: cloud({ servers: [server({ outgoing_traffic: 18 * TIB })] }) }, cfg(), watched(), now)
    assert.deepEqual(r.actions, [{ kind: 'shutdown', serverId: 1, serverName: 'app' }])
    assert.equal(r.alerts[0]!.key, 'traffic-kill:1')
    assert.equal(r.alerts[0]!.force, true)
  })

  it('waits while a requested shutdown is in progress, then powers off a server that ignores it', () => {
    const s = server({ outgoing_traffic: 19 * TIB })
    const asked = { ...watched(), shutdownAt: { 1: new Date(now.getTime() - 60_000).toISOString() } }
    assert.deepEqual(evaluate({ cloud: cloud({ servers: [s] }) }, cfg(), asked, now).actions, [])
    const late = { ...watched(), shutdownAt: { 1: new Date(now.getTime() - POWEROFF_AFTER_MS).toISOString() } }
    assert.deepEqual(evaluate({ cloud: cloud({ servers: [s] }) }, cfg(), late, now).actions, [{ kind: 'poweroff', serverId: 1, serverName: 'app' }])
  })

  it('leaves a server that is already off alone, keeps reminding, and forgets the old shutdown request', () => {
    const r = evaluate({ cloud: cloud({ servers: [server({ status: 'off', outgoing_traffic: 19 * TIB })] }) }, cfg(), { ...watched(), shutdownAt: { 1: now.toISOString() } }, now)
    assert.deepEqual(r.actions, [])
    assert.deepEqual(keys(r.alerts), ['traffic-kill:1'])
    assert.equal(r.alerts[0]!.force, false)
    assert.deepEqual(r.state.shutdownAt, {})
  })

  it('in dry-run proposes the same actions, but as reminders rather than news', () => {
    const r = evaluate({ cloud: cloud({ servers: [server({ outgoing_traffic: 19 * TIB })] }) }, cfg({ mode: 'dry-run' }), watched(), now)
    assert.equal(r.actions.length, 1)
    assert.equal(r.alerts[0]!.force, false)
    assert.match(r.alerts[0]!.message, /Dry-run/)
  })

  it('ignores servers with no included traffic figure', () => {
    const r = evaluate({ cloud: cloud({ servers: [server({ included_traffic: null, outgoing_traffic: 99 * TIB })] }) }, cfg(), watched(), now)
    assert.deepEqual(r.actions, [])
  })
})

describe('new resources', () => {
  it('records a baseline on the first run and says it is watching', () => {
    const r = evaluate({ cloud: cloud() }, cfg(), emptyState(), now)
    assert.deepEqual(keys(r.alerts), ['baseline'])
    assert.deepEqual(r.state.known, ['server:1'])
  })

  it('alerts once for each resource that appears later', () => {
    const c = cloud({ servers: [server(), server({ id: 2, name: 'miner', server_type: { name: 'ccx63', prices: [] } })], volumes: [{ id: 7, name: 'v', size: 500, location: { name: 'fsn1' } }] })
    const r = evaluate({ cloud: c }, cfg(), watched(), now)
    assert.deepEqual(keys(r.alerts), ['new:server:2', 'new:volume:7'])
    assert.match(r.alerts[0]!.message, /miner \(ccx63, fsn1\)/)
    assert.deepEqual(keys(evaluate({ cloud: c }, cfg(), r.state, now).alerts), [])
  })

  it('keeps the old baseline when the Cloud API could not be read', () => {
    const r = evaluate({}, cfg(), watched(), now)
    assert.deepEqual(r.state.known, ['server:1'])
  })
})

describe('budget', () => {
  it('estimates servers, backups, volumes, snapshots, IPs and overage at list price', () => {
    const c = cloud({
      servers: [server({ backup_window: '22-02', outgoing_traffic: 22 * TIB })],
      volumes: [{ id: 7, name: 'v', size: 100, location: { name: 'fsn1' } }],
      snapshots: [{ id: 9, type: 'snapshot', description: 'pre-rebuild', image_size: 10, created: '' }],
      primaryIps: [{ id: 3, name: 'ip', type: 'ipv4', location: { name: 'fsn1' } }]
    })
    const e = estimateMonthly(c)
    // 10.99 × 1.2 backups + 2 TiB overage × €1 + 100 GB × 0.044 + 10 GB × 0.011 + 0.50
    assert.ok(Math.abs(e.total - (13.188 + 2 + 4.4 + 0.11 + 0.5)) < 1e-9, String(e.total))
    assert.match(e.items[0]!.label, /server app \(cpx21, backups\)/)
  })

  it('alerts when the estimate is over budget, naming the biggest items', () => {
    const r = evaluate({ cloud: cloud() }, cfg({ monthlyBudgetEur: 5 }), watched(), now)
    assert.deepEqual(keys(r.alerts), ['budget'])
    assert.match(r.alerts[0]!.message, /server app \(cpx21\): €10\.99/)
  })
})

describe('dedicated servers', () => {
  it('alerts on a busy hour or a busy day, and never acts', () => {
    const r = evaluate({ dedicated: [{ name: 'bigbox', ip: '192.0.2.1', todayOutGb: 2500, peakHourOutGb: 300 }] }, cfg(), watched(), now)
    assert.deepEqual(keys(r.alerts), ['robot-hour:192.0.2.1', 'robot-day:192.0.2.1'])
    assert.deepEqual(r.actions, [])
  })
})

describe('due', () => {
  const a = { key: 'k', priority: 'high' as const, title: 't', message: 'm' }

  it('sends a new alert, holds it until the reminder interval, then sends it again', () => {
    const first = due([a], emptyState(), now, 6)
    assert.equal(first.send.length, 1)
    const soon = due([a], { ...emptyState(), lastSent: first.lastSent }, new Date(now.getTime() + 3_600_000), 6)
    assert.equal(soon.send.length, 0)
    const later = due([a], { ...emptyState(), lastSent: first.lastSent }, new Date(now.getTime() + 6 * 3_600_000), 6)
    assert.equal(later.send.length, 1)
  })

  it('always sends forced alerts, and forgets resolved ones so a relapse alerts at once', () => {
    const sent = { ...emptyState(), lastSent: { k: now.toISOString(), old: now.toISOString() } }
    const r = due([{ ...a, force: true }], sent, now, 6)
    assert.equal(r.send.length, 1)
    assert.deepEqual(Object.keys(r.lastSent), ['k'])
  })
})
