import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { due, emptyState, estimateMonthly, evaluate, includedTraffic, MAX_SENDS, POWEROFF_AFTER_MS, type Alert, type State } from '../src/evaluate.ts'
import type { Inventory, Server } from '../src/hcloud.ts'
import { cfg, inventory, server, TIB } from './fixtures.ts'

const now = new Date('2026-10-19T12:00:00Z')
const watched = (over: Partial<State> = {}): State => ({ ...emptyState(), known: ['server:1'], ...over })
const keys = (alerts: { key: string }[]) => alerts.map(a => a.key)
const run = (servers: Server[], state = watched(), c = cfg(), inv: Inventory = inventory()) => evaluate({ servers, inventory: inv }, c, state, now)
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()

describe('traffic', () => {
  it('stays quiet under the warning threshold', () => {
    const r = run([server({ outgoing_traffic: 9 * TIB })])
    assert.deepEqual(r.alerts, [])
    assert.deepEqual(r.actions, [])
    assert.deepEqual(r.problems, [])
  })

  it('warns at the warning threshold without acting', () => {
    const r = run([server({ outgoing_traffic: 10 * TIB })])
    assert.deepEqual(keys(r.alerts), ['traffic-warn:1'])
    assert.deepEqual(r.actions, [])
  })

  it('shuts a running server down at the kill threshold, and says so right away', () => {
    const r = run([server({ outgoing_traffic: 18 * TIB })])
    assert.deepEqual(r.actions, [{ kind: 'shutdown', serverId: 1, serverName: 'app' }])
    assert.equal(r.alerts[0]!.key, 'traffic-kill:1')
    assert.equal(r.alerts[0]!.force, true)
  })

  it('waits while a requested shutdown is in progress, then powers off a server that ignores it', () => {
    const s = server({ outgoing_traffic: 19 * TIB })
    assert.deepEqual(run([s], watched({ shutdownAt: { 1: ago(60_000) } })).actions, [])
    assert.deepEqual(run([s], watched({ shutdownAt: { 1: ago(POWEROFF_AFTER_MS) } })).actions, [{ kind: 'poweroff', serverId: 1, serverName: 'app' }])
  })

  for (const status of ['starting', 'initializing', 'stopping', 'migrating', 'rebuilding', 'unknown']) {
    it(`treats a "${status}" server as not off: stops it, and escalates to power-off`, () => {
      const s = server({ status, outgoing_traffic: 19 * TIB })
      assert.deepEqual(run([s]).actions.map(a => a.kind), ['shutdown'])
      const late = run([s], watched({ shutdownAt: { 1: ago(POWEROFF_AFTER_MS) } }))
      assert.deepEqual(late.actions.map(a => a.kind), ['poweroff'])
      assert.doesNotMatch(late.alerts[0]!.message, /It is off/)
    })
  }

  it('leaves a server that is off alone, keeps reminding, and forgets the old stop request', () => {
    const r = run([server({ status: 'off', outgoing_traffic: 19 * TIB })], watched({ shutdownAt: { 1: now.toISOString() } }))
    assert.deepEqual(r.actions, [])
    assert.deepEqual(keys(r.alerts), ['traffic-kill:1'])
    assert.equal(r.alerts[0]!.force, false)
    assert.deepEqual(r.state.shutdownAt, {})
  })

  it('in dry-run proposes the same actions, but as reminders rather than news', () => {
    const r = run([server({ outgoing_traffic: 19 * TIB })], watched(), cfg({ mode: 'dry-run' }))
    assert.equal(r.actions.length, 1)
    assert.equal(r.alerts[0]!.force, false)
    assert.match(r.alerts[0]!.message, /Dry-run/)
  })

  it('falls back to the type price list when the server has no included-traffic figure', () => {
    const r = run([server({ included_traffic: null, outgoing_traffic: 19 * TIB })])
    assert.deepEqual(r.actions.map(a => a.kind), ['shutdown'])
  })

  it('with no price for its own location, uses the smallest allowance, so the cap trips early', () => {
    const money = { net: '1', gross: '1' }
    const s = server({ included_traffic: null, location: { name: 'hil' }, outgoing_traffic: TIB, server_type: { name: 'x', prices: [{ location: 'fsn1', price_monthly: money, included_traffic: 20 * TIB }, { location: 'ash', price_monthly: money, included_traffic: TIB }] } })
    assert.equal(includedTraffic(s), TIB)
    assert.deepEqual(run([s]).actions.map(a => a.kind), ['shutdown'])
  })

  it('raises the alert on the first power-off, and an urgent "won\'t stop" after repeated ones', () => {
    const s = server({ outgoing_traffic: 19 * TIB })
    const first = run([s], watched({ shutdownAt: { 1: ago(POWEROFF_AFTER_MS) } }))
    assert.equal(first.alerts[0]!.force, true)
    const stuck = run([s], watched({ shutdownAt: { 1: ago(POWEROFF_AFTER_MS) }, poweroffs: { 1: 2 } }))
    assert.equal(stuck.alerts.find(x => x.key === 'traffic-kill:1')!.force, false)
    const a = stuck.alerts.find(x => x.key === 'poweroff-stuck:1')!
    assert.equal(a.priority, 'urgent')
    assert.equal(a.remindMinutes, 30)
    assert.equal(stuck.problems.length, 1)
  })

  it('forgets power-off attempts once the server is off', () => {
    assert.deepEqual(run([server({ status: 'off' })], watched({ poweroffs: { 1: 3 } })).state.poweroffs, {})
  })

  it('fails loudly when no traffic figures exist at all, instead of silently uncapping', () => {
    const noFigures = server({ included_traffic: null, server_type: { name: 'cpx21', prices: [] } })
    for (const s of [noFigures, server({ outgoing_traffic: null })]) {
      const r = run([s])
      assert.equal(r.alerts[0]!.key, 'traffic-unknown:1')
      assert.equal(r.alerts[0]!.priority, 'urgent')
      assert.equal(r.problems.length, 1)
    }
  })

  it('a per-server override raises one server\'s cap and leaves the others capped', () => {
    const r = run([server({ outgoing_traffic: 19 * TIB }), server({ id: 2, name: 'other', outgoing_traffic: 19 * TIB })], watched({ known: ['server:1', 'server:2'] }), cfg({ killOverrides: { 1: 120 } }))
    assert.deepEqual(r.actions.map(a => a.serverId), [2])
    assert.deepEqual(keys(r.alerts), ['traffic-warn:1', 'traffic-kill:2'])
  })

  it('still enforces the cap when the rest of the inventory could not be read', () => {
    const r = evaluate({ servers: [server({ outgoing_traffic: 19 * TIB })] }, cfg(), watched(), now)
    assert.deepEqual(r.actions.map(a => a.kind), ['shutdown'])
  })
})

describe('new resources', () => {
  const miner = server({ id: 2, name: 'miner', server_type: { ...server().server_type, name: 'ccx63' } })

  it('records a baseline on the first run and says it is watching', () => {
    const r = run([server()], emptyState())
    assert.deepEqual(keys(r.alerts), ['baseline'])
    assert.deepEqual(r.state.known, ['server:1'])
  })

  it('warns in the baseline message when no healthcheck is configured', () => {
    assert.match(run([server()], emptyState(), cfg({ healthcheckUrl: undefined })).alerts[0]!.message, /No HEALTHCHECK_URL/)
  })

  it('raises one alert listing everything new', () => {
    const r = run([server(), miner], watched(), cfg(), inventory({ volumes: [{ id: 7, name: 'v', size: 500, location: { name: 'fsn1' } }] }))
    const a = r.alerts.find(x => x.key === 'new-resources')!
    assert.equal(a.force, true)
    assert.match(a.message, /miner \(ccx63, fsn1\); volume v \(500 GB\)/)
    assert.deepEqual(Object.keys(r.state.pendingNew).sort(), ['server:2', 'volume:7'])
  })

  it('keeps an undelivered alert pending and resends it next run', () => {
    const first = run([server(), miner])
    // main.ts clears pendingNew only after delivery; here delivery failed.
    const second = run([server(), miner], first.state)
    const a = second.alerts.find(x => x.key === 'new-resources')!
    assert.equal(a.force, true)
    assert.match(a.message, /miner/)
  })

  it('is quiet once the alert was delivered', () => {
    const first = run([server(), miner])
    assert.deepEqual(keys(run([server(), miner], { ...first.state, pendingNew: {} }).alerts), [])
  })

  it('caps the list for a flood of new resources', () => {
    const many = Array.from({ length: 300 }, (_, i) => server({ id: 100 + i, name: `s${i}` }))
    const r = run([server(), ...many])
    const a = r.alerts.filter(x => x.key === 'new-resources')
    assert.equal(a.length, 1)
    assert.match(a[0]!.title, /300 new resources/)
    assert.match(a[0]!.message, /and 290 more/)
  })

  it('a kind that could not be read keeps its known keys, so it is not "new" when it comes back', () => {
    const vol = { id: 7, name: 'v', size: 10, location: { name: 'fsn1' } }
    const base = watched({ known: ['server:1', 'volume:7'] })
    const blind = run([server()], base, cfg(), inventory({ volumes: undefined }))
    assert.deepEqual(blind.state.known, ['server:1', 'volume:7'])
    assert.deepEqual(keys(run([server()], blind.state, cfg(), inventory({ volumes: [vol] })).alerts), [])
  })

  it('keeps an undelivered alert for a resource deleted in the meantime', () => {
    const first = run([server(), miner])
    const second = run([server()], first.state)
    assert.match(second.alerts.find(x => x.key === 'new-resources')!.message, /miner .*\(since deleted\)/)
  })

  it('keeps an undelivered alert when its kind could not be read this run', () => {
    const vol = { id: 7, name: 'v', size: 10, location: { name: 'fsn1' } }
    const first = run([server()], watched(), cfg(), inventory({ volumes: [vol] }))
    const blind = run([server()], first.state, cfg(), inventory({ volumes: undefined }))
    assert.deepEqual(Object.keys(blind.state.pendingNew), ['volume:7'])
    assert.match(blind.alerts.find(x => x.key === 'new-resources')!.message, /volume v/)
    assert.doesNotMatch(blind.alerts.find(x => x.key === 'new-resources')!.message, /since deleted/)
  })

  it('waits for a complete inventory before recording the baseline', () => {
    const r = run([server()], emptyState(), cfg(), inventory({ volumes: undefined }))
    assert.equal(r.state.known, undefined)
    assert.ok(!keys(r.alerts).includes('baseline'))
  })

  it('keeps the old baseline when the server list could not be read', () => {
    const r = evaluate({ inventory: inventory() }, cfg(), watched(), now)
    assert.deepEqual(r.state.known, ['server:1'])
  })
})

describe('budget', () => {
  it('estimates servers, backups, volumes, snapshots, IPs, storage boxes and overage at list price', () => {
    const e = estimateMonthly([server({ backup_window: '22-02', outgoing_traffic: 22 * TIB })], inventory({
      volumes: [{ id: 7, name: 'v', size: 100, location: { name: 'fsn1' } }],
      snapshots: [{ id: 9, type: 'snapshot', description: 'pre-rebuild', image_size: 10, created: '' }],
      primaryIps: [{ id: 3, name: 'ip', type: 'ipv4', location: { name: 'fsn1' } }, { id: 4, name: 'ip6', type: 'ipv6', location: { name: 'fsn1' } }],
      storageBoxes: [{ id: 5, name: 'box', location: { name: 'fsn1' }, storage_box_type: { name: 'bx11', prices: [{ location: 'fsn1', price_monthly: { net: '3.20', gross: '3.20' } }] } }]
    }) as Required<Inventory>)
    // 10.99 × 1.2 backups + 2 TiB overage × €1 + 100 GB × 0.044 + 10 GB × 0.011 + 0.50 IPv4 + 3.20 box (IPv6 free)
    assert.ok(Math.abs(e.total - (13.188 + 2 + 4.4 + 0.11 + 0.5 + 3.2)) < 1e-9, String(e.total))
    assert.match(e.items[0]!.label, /server app \(cpx21, backups\)/)
    assert.deepEqual(e.unpriced, [])
  })

  it('uses the highest price when the server\'s location has none, and flags things with no price at all', () => {
    const elsewhere = server({ location: { name: 'hel1' } })
    assert.equal(estimateMonthly([elsewhere], inventory() as Required<Inventory>).total, 10.99)
    const r = run([server({ server_type: { name: 'old', prices: [] }, included_traffic: 20 * TIB })])
    assert.ok(keys(r.alerts).includes('unpriced'))
  })

  it('alerts when the estimate is over budget, naming the biggest items', () => {
    const r = run([server()], watched(), cfg({ monthlyBudget: 5 }))
    assert.deepEqual(keys(r.alerts), ['budget'])
    assert.match(r.alerts[0]!.message, /server app \(cpx21\): €10\.99/)
  })

  it('with part of the inventory missing, still alerts on a known overrun as "at least"', () => {
    const r = run([server()], watched(), cfg({ monthlyBudget: 5 }), inventory({ storageBoxes: undefined }))
    const a = r.alerts.find(x => x.key === 'budget')!
    assert.match(a.title, /at least €10\.99/)
    assert.match(a.message, /Not counted .*storageBoxes/)
  })

  it('notes a non-EUR account', () => {
    const inv = inventory()
    const r = run([server()], watched(), cfg(), { ...inv, pricing: { ...inv.pricing!, currency: 'USD' } })
    assert.deepEqual(keys(r.alerts), ['currency'])
  })
})

describe('dedicated servers', () => {
  const d = { id: 7, name: 'bigbox', addresses: ['192.0.2.1'], lastHourOutGb: 0, last24hOutGb: 0 }

  it('alerts on a busy hour or a busy day, and never acts', () => {
    const r = evaluate({ dedicated: [{ ...d, last24hOutGb: 2500, lastHourOutGb: 300 }] }, cfg(), watched(), now)
    assert.deepEqual(keys(r.alerts), ['robot-hour:7', 'robot-day:7'])
    assert.deepEqual(r.actions, [])
  })

  it('alerts on a metered server nearing its quota', () => {
    const r = evaluate({ dedicated: [{ ...d, quotaGb: 20_000, monthOutGb: 19_000 }] }, cfg(), watched(), now)
    assert.deepEqual(keys(r.alerts), ['robot-quota:7'])
    assert.equal(r.alerts[0]!.priority, 'urgent')
  })

  it('alerts when a server has no address to watch', () => {
    assert.deepEqual(keys(evaluate({ dedicated: [{ ...d, addresses: [] }] }, cfg(), watched(), now).alerts), ['robot-unwatched:7'])
  })
})

describe('due', () => {
  const a: Alert = { key: 'k', priority: 'high', title: 't', message: 'm' }

  it('sends a new alert, holds it until the reminder interval, then sends it again', () => {
    const first = due([a], emptyState(), now, 6)
    assert.equal(first.send.length, 1)
    const at = (h: number) => new Date(now.getTime() + h * 3_600_000)
    assert.equal(due([a], { ...emptyState(), lastSent: first.lastSent }, at(1), 6).send.length, 0)
    assert.equal(due([a], { ...emptyState(), lastSent: first.lastSent }, at(6), 6).send.length, 1)
  })

  it('honors a per-alert reminder interval', () => {
    const fast = { ...a, remindMinutes: 30 }
    const first = due([fast], emptyState(), now, 6)
    assert.equal(due([fast], { ...emptyState(), lastSent: first.lastSent }, new Date(now.getTime() + 30 * 60_000), 6).send.length, 1)
  })

  it('always sends forced alerts, and forgets resolved ones so a relapse alerts at once', () => {
    const r = due([{ ...a, force: true }], { ...emptyState(), lastSent: { k: now.toISOString(), old: now.toISOString() } }, now, 6)
    assert.equal(r.send.length, 1)
    assert.deepEqual(Object.keys(r.lastSent), ['k'])
  })

  it('never folds forced (one-off) alerts into the summary', () => {
    const many: Alert[] = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, priority: 'high', title: `t${i}`, message: 'm' }))
    const r = due([...many, { key: 'baseline', priority: 'default', title: 'b', message: 'm', force: true }], emptyState(), now, 6)
    assert.ok(r.send.some(a => a.key === 'baseline'))
    assert.equal(r.send.length, MAX_SENDS)
  })

  it('caps sends per run, most urgent first, and leaves the overflow due next run', () => {
    const many: Alert[] = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, priority: i === 19 ? 'urgent' : 'default', title: `t${i}`, message: 'm' }))
    const r = due(many, emptyState(), now, 6)
    assert.equal(r.send.length, MAX_SENDS)
    assert.equal(r.send[0]!.key, 'k19')
    assert.equal(r.send.at(-1)!.key, 'more')
    assert.equal(Object.keys(r.lastSent).length, MAX_SENDS - 1)
  })
})
