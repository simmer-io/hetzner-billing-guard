import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Hcloud, HcloudError } from '../src/hcloud.ts'
import { Robot } from '../src/robot.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

type Handler = (url: URL, init: RequestInit) => unknown
function fakeFetch(handler: Handler, calls: { url: URL, init: RequestInit }[] = []) {
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    const body = handler(url, init)
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return calls
}

describe('Hcloud', () => {
  it('follows pagination and sends the token as a bearer header', async () => {
    const calls = fakeFetch((url) => {
      const key = url.pathname.split('/').pop()!
      if (key === 'pricing') return { pricing: { currency: 'EUR' } }
      const page = Number(url.searchParams.get('page'))
      if (key !== 'servers') return { [key]: [], meta: { pagination: { next_page: null } } }
      return { servers: [{ id: page }], meta: { pagination: { next_page: page < 3 ? page + 1 : null } } }
    })
    const snap = await new Hcloud('secret').snapshot()
    assert.deepEqual(snap.servers.map(s => s.id), [1, 2, 3])
    assert.ok(calls.every(c => (c.init.headers as Record<string, string>).Authorization === 'Bearer secret'))
    assert.ok(calls.some(c => c.url.pathname === '/v1/images' && c.url.searchParams.get('type') === 'snapshot'))
  })

  it('stops after a bounded number of pages', async () => {
    fakeFetch((url) => {
      const key = url.pathname.split('/').pop()!
      if (key === 'pricing') return { pricing: {} }
      return { [key]: [], meta: { pagination: { next_page: 999 } } }
    })
    await assert.rejects(new Hcloud('t').snapshot(), /more than 20 pages/)
  })

  it('reports the HTTP status and error code, never the token', async () => {
    fakeFetch(() => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'invalid token secret' } }), { status: 401 }))
    await assert.rejects(new Hcloud('secret').snapshot(), (e: Error) => e instanceof HcloudError && /HTTP 401 unauthorized/.test(e.message) && !e.message.includes('secret'))
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
  it('sums today\'s hourly outgoing traffic per server and finds the peak hour', async () => {
    const calls = fakeFetch((url) => {
      if (url.pathname === '/server') return [{ server: { server_ip: '192.0.2.1', server_name: 'bigbox' } }, { server: { server_ip: null, server_name: 'no-ip' } }]
      return { traffic: { data: { '192.0.2.1': { '00': { in: 1, out: 10, sum: 11 }, '01': { in: 1, out: 30.5, sum: 31.5 } } } } }
    })
    const t = await new Robot('u', 'p').traffic(new Date('2026-10-19T05:30:00Z'))
    assert.deepEqual(t, [{ name: 'bigbox', ip: '192.0.2.1', todayOutGb: 40.5, peakHourOutGb: 30.5 }])
    const form = new URLSearchParams(String(calls[1]!.init.body))
    assert.equal(form.get('from'), '2026-10-19T00')
    assert.equal(form.get('to'), '2026-10-19T05')
    assert.deepEqual(form.getAll('ip[]'), ['192.0.2.1'])
  })

  it('treats "no data yet" (404) as no traffic', async () => {
    fakeFetch((url) => url.pathname === '/server' ? [{ server: { server_ip: '192.0.2.1', server_name: 'bigbox' } }] : new Response('', { status: 404 }))
    const t = await new Robot('u', 'p').traffic(new Date('2026-10-19T00:10:00Z'))
    assert.deepEqual(t, [{ name: 'bigbox', ip: '192.0.2.1', todayOutGb: 0, peakHourOutGb: 0 }])
  })
})
