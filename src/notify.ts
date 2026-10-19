// Alerts go to ntfy (https://ntfy.sh or a self-hosted server). The healthcheck (healthchecks.io or
// compatible) is the dead man's switch: if runs stop arriving, it alerts on its own.

import type { Alert } from './evaluate.ts'
import { why } from './hcloud.ts'

const TIMEOUT_MS = 10_000
/** ntfy turns longer messages into attachments. */
const MAX_MESSAGE = 3_500

export async function sendNtfy(url: string, token: string | undefined, alert: Alert) {
  // Title and priority go in the query string: headers can't carry non-Latin-1 characters like €.
  const u = new URL(url)
  u.searchParams.set('title', alert.title.slice(0, 200))
  u.searchParams.set('priority', alert.priority)
  u.searchParams.set('tags', alert.priority === 'urgent' ? 'rotating_light' : 'money_with_wings')
  let res: Response
  try {
    res = await fetch(u, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: alert.message.slice(0, MAX_MESSAGE),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    throw new Error(`ntfy: ${why(e)}`)
  }
  if (!res.ok) throw new Error(`ntfy: HTTP ${res.status}`)
}

/** Ping the healthcheck. Never throws: a failed ping must not hide the run's real outcome. */
export async function ping(url: string | undefined, kind: 'start' | 'success' | 'fail', body?: string) {
  if (!url) return
  const u = new URL(url)
  if (kind !== 'success') u.pathname = `${u.pathname.replace(/\/+$/, '')}/${kind}`
  try {
    await fetch(u, { method: 'POST', body: body?.slice(0, 10_000), signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    console.error(`healthcheck ${kind} ping failed: ${why(e)}`)
  }
}
