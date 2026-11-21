import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { act, type Stopper } from '../src/act.ts'
import { emptyState, type Action } from '../src/evaluate.ts'

const now = new Date('2026-11-20T12:00:00Z')
const actions: Action[] = [{ kind: 'shutdown', serverId: 1, serverName: 'web-1' }, { kind: 'poweroff', serverId: 2, serverName: 'web-2' }]
const recorder = () => {
  const calls: string[] = []
  const stopper: Stopper = {
    shutdown: async (id) => void calls.push(`shutdown ${id}`),
    poweroff: async (id) => void calls.push(`poweroff ${id}`)
  }
  return { calls, stopper }
}

describe('act', () => {
  for (const mode of ['alert-only', 'dry-run'] as const) {
    it(`in ${mode}, never calls the API, even when handed actions`, async () => {
      const { calls, stopper } = recorder()
      const state = emptyState()
      const r = await act(mode, actions, stopper, state, now)
      assert.deepEqual(calls, [])
      assert.deepEqual(r, { problems: [], alerts: [] })
      assert.deepEqual(state.shutdownAt, {})
    })
  }

  it('in enforce, stops the servers and records it', async () => {
    const { calls, stopper } = recorder()
    const state = emptyState()
    await act('enforce', actions, stopper, state, now)
    assert.deepEqual(calls, ['shutdown 1', 'poweroff 2'])
    assert.equal(state.shutdownAt[1], now.toISOString())
    assert.equal(state.poweroffs[2], 1)
  })

  it('in enforce, a failed stop is an urgent alert and a problem', async () => {
    const stopper: Stopper = { shutdown: async () => { throw new Error('hcloud: HTTP 403') }, poweroff: async () => {} }
    const r = await act('enforce', actions.slice(0, 1), stopper, emptyState(), now)
    assert.deepEqual(r.problems, ['hcloud: HTTP 403'])
    assert.equal(r.alerts[0]!.key, 'action-failed:1')
  })
})
