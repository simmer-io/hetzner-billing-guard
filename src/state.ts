// The guard's memory between runs, as one small JSON file. Written to a temp file and renamed, so a
// crash mid-write never leaves a half-written state.

import { readFile, rename, writeFile } from 'node:fs/promises'
import { emptyState, type State } from './evaluate.ts'

export async function loadState(path: string): Promise<State> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw e
  }
  const s = JSON.parse(raw) as State
  if (s.version !== 1) throw new Error(`${path}: unknown state version ${String(s.version)}`)
  return { ...emptyState(), ...s }
}

export async function saveState(path: string, state: State) {
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, path)
}
