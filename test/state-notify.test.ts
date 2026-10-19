import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { emptyState } from '../src/evaluate.ts'
import { ping } from '../src/notify.ts'
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
