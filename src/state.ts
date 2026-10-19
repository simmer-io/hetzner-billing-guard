// The guard's memory between runs, as one small JSON file. Written to a temp file, synced and
// renamed, so a crash or power cut never leaves a half-written state.

import { open, readFile, rename } from 'node:fs/promises'
import { emptyState, type State } from './evaluate.ts'

export interface Loaded {
  state: State
  /** Set when the file was unreadable and was moved aside: the guard starts over, and says so. */
  reset?: string
}

export async function loadState(path: string, now: Date): Promise<Loaded> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: emptyState() }
    throw e
  }
  try {
    const s = JSON.parse(raw) as State
    if (s?.version !== 1) throw new Error(`unknown version ${String(s?.version)}`)
    return { state: { ...emptyState(), ...s } }
  } catch (e) {
    // A broken state must never stop the guard: keep the file for inspection and start over.
    const aside = `${path}.broken-${now.toISOString().replace(/[:.]/g, '-')}`
    await rename(path, aside)
    return { state: emptyState(), reset: `state file was unreadable (${(e as Error).message}); moved to ${aside}` }
  }
}

export async function saveState(path: string, state: State) {
  const tmp = `${path}.tmp`
  const f = await open(tmp, 'w', 0o600)
  try {
    await f.writeFile(`${JSON.stringify(state, null, 2)}\n`)
    await f.sync()
  } finally {
    await f.close()
  }
  await rename(tmp, path)
}
