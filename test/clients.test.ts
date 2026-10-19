import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Hcloud, HcloudError } from '../src/hcloud.ts'
import { quotaGb, Robot } from '../src/robot.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

type Call = { url: URL, init: RequestInit }
function fakeFetch(handler: (url: URL, init: RequestInit) => unknown, calls: Call[] = []) {
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    const body = handler(url, init)
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return calls
}
const empty = (url: URL) => {
  const key = url.pathname.split('/').pop()!
  if (key === 'pricing') return { pricing: { currency: 'EUR' } }
  return { [key === 'images' ? 'images' : key]: [], meta: { pagination: { next_page: null } } }
}

describe('Hcloud', () => {
  it('follows pagination and sends the token as a bearer header', async () => {
    const calls = fakeFetch((url) => {
      const page = Number(url.searchParams.get('page'))
      return { servers: [{ id: page }], meta: { pagination: { next_page: page < 3 ? page + 1 : null } } }
    })
    const servers = await new Hcloud('secret').servers()
    assert.deepEqual(servers.map(s => s.id), [1, 2, 3])
    assert.ok(calls.every(c => (c.init.headers as Record<string, string>).Authorization === 'Bearer secret'))
  })

  it('stops after a bounded number of pages', async () => {
    fakeFetch(() => ({ servers: [], meta: { pagination: { next_page: 999 } } }))
    await assert.rejects(new Hcloud('t').servers(), /more than 20 pages/)
  })

  it('rejects a response without the expected list', async () => {
    fakeFetch(() => ({ items: [] }))
    await assert.rejects(new Hcloud('t').servers(), /no "servers" list/)
  })

  it('reports the HTTP status and error code, never the token', async () => {
    fakeFetch(() => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'invalid token secret' } }), { status: 401 }))
    await assert.rejects(new Hcloud('secret').servers(), (e: Error) => e instanceof HcloudError && /HTTP 401 unauthorized/.test(e.message) && !e.message.includes('secret'))
  })

  it('reads every inventory part, storage boxes from the newer API, and reports a failing part without losing the rest', async () => {
    const calls = fakeFetch(url => url.pathname.endsWith('/load_balancers') ? new Response('{}', { status: 503 }) : empty(url))
    const { inventory, errors } = await new Hcloud('t').inventory()
    assert.equal(inventory.loadBalancers, undefined)
    assert.deepEqual(inventory.volumes, [])
    assert.deepEqual(inventory.storageBoxes, [])
    assert.equal(inventory.pricing?.currency, 'EUR')
    assert.deepEqual(errors, ['GET /load_balancers?per_page=50&page=1: HTTP 503'])
    assert.ok(calls.some(c => c.url.host === 'api.hetzner.com' && c.url.pathname === '/v1/storage_boxes'))
    assert.ok(calls.some(c => c.url.pathname === '/v1/images' && c.url.searchParams.get('type') === 'snapshot'))
  })

  it('posts shutdown and poweroff actions', async () => {
    const calls = fakeFetch(() => ({ action: {} }))
    const h = new Hcloud('t')
    await h.shutdown(5)
    await h.poweroff(5)
    assert.deepEqual(calls.map(c => `${c.init.method} ${c.url.pathname}`), ['POST /v1/servers/5/actions/shutdown', 'POST /v1/servers/5/actions/poweroff'])
  })
})

describe('Robot', () => {
  const bigbox = { server: { server_ip: '192.0.2.1', server_name: 'bigbox', traffic: 'unlimited', ip: ['192.0.2.1', '192.0.2.9'], subnet: [{ ip: '2001:db8::', mask: '64' }] } }
  const forms = (calls: Call[]) => calls.filter(c => c.url.pathname === '/traffic').map(c => new URLSearchParams(String(c.init.body)))

  it('queries the 24 completed hours across midnight, for every IP and subnet, and sums them', async () => {
    const calls = fakeFetch((url, init) => {
      if (url.pathname === '/server') return [bigbox]
      const f = new URLSearchParams(String(init.body))
      if (f.get('from')!.startsWith('2026-10-18')) return { traffic: { data: { '192.0.2.1': { 23: { out: 5 } } } } }
      return { traffic: { data: { '192.0.2.1': { '00': { out: 10 }, '04': { out: 30.5 } }, '2001:db8::': { '04': { out: 1 } } } } }
    })
    const t = await new Robot('u', 'p').traffic(new Date('2026-10-19T05:30:00Z'))
    assert.deepEqual(t, [{ name: 'bigbox', addresses: ['192.0.2.1', '192.0.2.9', '2001:db8::'], lastHourOutGb: 31.5, last24hOutGb: 46.5 }])
    const [y, d] = forms(calls)
    assert.deepEqual([y!.get('from'), y!.get('to'), d!.get('from'), d!.get('to')], ['2026-10-18T05', '2026-10-18T23', '2026-10-19T00', '2026-10-19T04'])
    assert.deepEqual(d!.getAll('ip[]'), ['192.0.2.1', '192.0.2.9'])
    assert.deepEqual(d!.getAll('subnet[]'), ['2001:db8::'])
  })

  it('uses one request when the window fits in one day (just after midnight it is all of yesterday)', async () => {
    const calls = fakeFetch(url => url.pathname === '/server' ? [bigbox] : { traffic: { data: {} } })
    await new Robot('u', 'p').traffic(new Date('2026-10-19T00:10:00Z'))
    assert.deepEqual(forms(calls).map(f => [f.get('from'), f.get('to')]), [['2026-10-18T00', '2026-10-18T23']])
  })

  it('tracks month-to-date traffic for a server with a quota', async () => {
    const metered = { server: { ...bigbox.server, traffic: '20 TB', subnet: [] } }
    const calls = fakeFetch((url, init) => {
      if (url.pathname === '/server') return [metered]
      const f = new URLSearchParams(String(init.body))
      if (f.get('type') === 'month') return { traffic: { data: { '192.0.2.1': { '01': { out: 1000 }, 18: { out: 500 } } } } }
      return { traffic: { data: { '192.0.2.1': { '03': { out: 7 } } } } }
    })
    const [t] = await new Robot('u', 'p').traffic(new Date('2026-10-19T05:30:00Z'))
    assert.equal(t!.quotaGb, 20_000)
    assert.equal(t!.monthOutGb, 1507)
    const month = forms(calls).find(f => f.get('type') === 'month')!
    assert.deepEqual([month.get('from'), month.get('to')], ['2026-10-01', '2026-10-18'])
  })

  it('treats a 404 from /traffic as an error (unknown addresses), not as zero traffic', async () => {
    fakeFetch(url => url.pathname === '/server' ? [bigbox] : new Response('', { status: 404 }))
    await assert.rejects(new Robot('u', 'p').traffic(new Date('2026-10-19T05:30:00Z')), /HTTP 404/)
  })

  it('reports a server with no addresses instead of dropping it', async () => {
    fakeFetch(() => [{ server: { server_ip: null, server_name: 'v6only', ip: [], subnet: [] } }])
    assert.deepEqual(await new Robot('u', 'p').traffic(new Date()), [{ name: 'v6only', addresses: [], lastHourOutGb: 0, last24hOutGb: 0 }])
  })

  it('parses traffic quotas', () => {
    assert.equal(quotaGb('20 TB'), 20_000)
    assert.equal(quotaGb('500 GB'), 500)
    assert.equal(quotaGb('unlimited'), null)
    assert.equal(quotaGb(undefined), null)
  })
})
