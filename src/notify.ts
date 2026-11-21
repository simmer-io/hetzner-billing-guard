// Alerts go to ntfy (https://ntfy.sh or a self-hosted server) and/or a Slack incoming webhook. The healthcheck (healthchecks.io or
// compatible) is the dead man's switch: if runs stop arriving, it alerts on its own.

import type { Config } from './config.ts'
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

const SLACK_ICON: Record<Alert['priority'], string> = { urgent: ':rotating_light:', high: ':warning:', default: ':money_with_wings:' }

/** Slack's mrkdwn treats &, < and > as markup; escaped, a server name can't make a link or a mention. */
const slackText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export async function sendSlack(webhook: string, alert: Alert) {
  const text = `${SLACK_ICON[alert.priority] ?? ''} *${slackText(alert.title.slice(0, 200))}*\n${slackText(alert.message.slice(0, MAX_MESSAGE))}`
  let res: Response
  try {
    res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    // why() gives the error's name and code only: never the webhook URL.
    throw new Error(`slack: ${why(e)}`)
  }
  if (!res.ok) throw new Error(`slack: HTTP ${res.status}`)
}

/** Sends to every configured channel, trying them all; throws if any of them failed. */
export async function deliver(cfg: Pick<Config, 'ntfyUrl' | 'ntfyToken' | 'slackWebhookUrl'>, alert: Alert) {
  const failed: string[] = []
  if (cfg.ntfyUrl) await sendNtfy(cfg.ntfyUrl, cfg.ntfyToken, alert).catch((e: Error) => failed.push(e.message))
  if (cfg.slackWebhookUrl) await sendSlack(cfg.slackWebhookUrl, alert).catch((e: Error) => failed.push(e.message))
  if (failed.length) throw new Error(failed.join('; '))
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
