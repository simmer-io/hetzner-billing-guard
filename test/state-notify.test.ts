import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { emptyState } from '../src/evaluate.ts'
import { deliver, ping } from '../src/notify.ts'
import { loadState, saveState } from '../src/state.ts'

const now = new Date('2026-10-19T12:00:00Z')

describe('state file', () => {
  it('starts empty, then round-trips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guard-'))
    const path = join(dir, 'state.json')
    assert.deepEqual((await loadState(path, now)).state, emptyState())
    await saveState(path, { ...emptyState(), known: ['server:1'] })
    assert.deepEqual((await loadState(path, now)).state.known, ['server:1'])
  })

  for (const [name, content] of [['empty', ''], ['truncated', '{"version":1,"kno'], ['from another version', '{"version":2}'], ['null-field', '{"version":1,"pendingNew":null}'], ['wrong-type', '{"version":1,"known":"server:1"}'], ['non-object', '[1]']]) {
    it(`moves a ${name} state file aside and starts over instead of crashing`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'guard-'))
      const path = join(dir, 'state.json')
      await writeFile(path, content!)
      const r = await loadState(path, now)
      assert.deepEqual(r.state, emptyState())
      assert.match(r.reset!, /unreadable/)
      const files = await readdir(dir)
      assert.equal(files.length, 1)
      assert.match(files[0]!, /^state\.json\.broken-/)
      assert.equal(await readFile(join(dir, files[0]!), 'utf8'), content)
    })
  }
})

describe('healthcheck ping', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('puts /start and /fail in the path, before any query string, and never throws', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (u: string | URL) => {
      urls.push(String(u))
      throw new TypeError('down')
    }) as typeof fetch
    await ping('https://hc.example/ping/abc?rid=1', 'start')
    await ping('https://hc.example/ping/abc?rid=1', 'success')
    await ping('https://hc.example/ping/abc/', 'fail')
    assert.deepEqual(urls, ['https://hc.example/ping/abc/start?rid=1', 'https://hc.example/ping/abc?rid=1', 'https://hc.example/ping/abc/fail'])
  })
})

describe('alert delivery', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })
  const hook = 'https://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnop'
  const alert = { key: 'k', priority: 'urgent' as const, title: 'web-<1> & co', message: 'over <@here> 90%' }

  it('sends to every channel, escapes Slack markup, and refuses redirects', async () => {
    const sent: { url: string; body: string; redirect?: string }[] = []
    globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
      sent.push({ url: String(u), body: String(init?.body), redirect: init?.redirect })
      return new Response('ok')
    }) as typeof fetch
    await deliver({ ntfyUrl: 'https://ntfy.example/topic', slackWebhookUrl: hook }, alert)
    assert.equal(sent.length, 2)
    assert.match(sent[0]!.url, /^https:\/\/ntfy\.example\/topic\?/)
    assert.equal(sent[1]!.url, hook)
    assert.equal(sent[1]!.redirect, 'error')
    const body = JSON.parse(sent[1]!.body) as { text: string; unfurl_links: boolean }
    assert.equal(body.text, ':rotating_light: *web-&lt;1&gt; &amp; co*\nover &lt;@here&gt; 90%')
    assert.equal(body.unfurl_links, false)
  })

  it('counts an alert sent when one channel took it, and returns the other failure', async () => {
    globalThis.fetch = (async (u: string | URL) => (String(u).startsWith('https://ntfy') ? new Response('ok') : new Response('no', { status: 500 }))) as typeof fetch
    assert.deepEqual(await deliver({ ntfyUrl: 'https://ntfy.example/topic', slackWebhookUrl: hook }, alert), ['slack: HTTP 500'])
  })

  it('tries every channel, then fails without the webhook in the message', async () => {
    let calls = 0
    globalThis.fetch = (async (u: string | URL) => {
      calls++
      if (String(u).startsWith('https://ntfy')) throw new TypeError('down')
      return new Response('no', { status: 404 })
    }) as typeof fetch
    await assert.rejects(deliver({ ntfyUrl: 'https://ntfy.example/topic', slackWebhookUrl: hook }, alert), (e: Error) => {
      assert.equal(calls, 2)
      assert.match(e.message, /ntfy: TypeError; slack: HTTP 404/)
      assert.ok(!e.message.includes('abcdefghijklmnop'))
      return true
    })
  })
})
