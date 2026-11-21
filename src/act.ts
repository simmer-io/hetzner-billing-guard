// Carries out the actions evaluate() decided on. Only enforce mode ever calls the API: dry-run and
// alert-only log what enforce would do, whatever evaluate returned, so the mode itself guarantees no
// server is stopped (not just a read-only token's 403).

import type { Config } from './config.ts'
import type { Action, Alert, State } from './evaluate.ts'

export interface Stopper {
  shutdown(id: number): Promise<void>
  poweroff(id: number): Promise<void>
}

export async function act(mode: Config['mode'], actions: Action[], stopper: Stopper | undefined, state: State, now: Date): Promise<{ problems: string[]; alerts: Alert[] }> {
  const problems: string[] = []
  const alerts: Alert[] = []
  for (const a of actions) {
    if (mode !== 'enforce' || !stopper) {
      console.log(`${mode}: would ${a.kind} ${a.serverName} (${a.serverId}), not acting`)
      continue
    }
    try {
      await (a.kind === 'shutdown' ? stopper.shutdown(a.serverId) : stopper.poweroff(a.serverId))
      console.log(`${a.kind}: ${a.serverName} (${a.serverId})`)
      // The next escalation (or a repeated power-off) waits POWEROFF_AFTER_MS from now.
      state.shutdownAt[a.serverId] = now.toISOString()
      if (a.kind === 'poweroff') state.poweroffs[a.serverId] = (state.poweroffs[a.serverId] ?? 0) + 1
    } catch (e) {
      problems.push((e as Error).message)
      alerts.push({ key: `action-failed:${a.serverId}`, priority: 'urgent', title: `Hetzner billing guard: could not stop ${a.serverName}`, message: `${a.kind} of ${a.serverName} failed: ${(e as Error).message}. Stop it in the console now.`, remindMinutes: 30 })
    }
  }
  return { problems, alerts }
}
