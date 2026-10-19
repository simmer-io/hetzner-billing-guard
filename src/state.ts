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
    // A state that can't be read must never stop the guard (the kill switch runs after this).
    return { state: emptyState(), reset: `state file could not be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` }
  }
  try {
    return { state: check(JSON.parse(raw)) }
  } catch (e) {
    // Keep a broken file for inspection and start over.
    const aside = `${path}.broken-${now.toISOString().replace(/[:.]/g, '-')}`
    const moved = await rename(path, aside).then(() => true, () => false)
    return { state: emptyState(), reset: `state file was unreadable (${(e as Error).message})${moved ? `; moved to ${aside}` : ''}` }
  }
}

const isMap = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The parsed file, with every field of the right shape, or an error (which resets the state). */
function check(raw: unknown): State {
  const s = { ...emptyState(), ...(isMap(raw) ? raw as object : {}) } as State
  if (!isMap(raw) || s.version !== 1) throw new Error(`unknown version ${String((raw as State | null)?.version)}`)
  if (s.known !== undefined && !(Array.isArray(s.known) && s.known.every(k => typeof k === 'string'))) throw new Error('"known" is not a list of strings')
  for (const k of ['pendingNew', 'lastSent', 'shutdownAt', 'poweroffs'] as const) {
    if (!isMap(s[k])) throw new Error(`"${k}" is not an object`)
  }
  return s
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
