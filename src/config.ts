// Configuration comes only from environment variables, checked once at startup. A bad value stops the
// run with a clear message, and the healthcheck then reports the failure.

export interface Config {
  mode: 'dry-run' | 'enforce'
  hcloudToken?: string
  robotUser?: string
  robotPassword?: string
  ntfyUrl: string
  ntfyToken?: string
  healthcheckUrl?: string
  /** Alert when a Cloud server has used this share of its included traffic. */
  trafficWarnPercent: number
  /** Shut the server down at this share (enforce mode only). */
  trafficKillPercent: number
  /** Alert when the estimated monthly Cloud bill goes above this (EUR, excluding VAT). */
  monthlyBudgetEur?: number
  /** Alert when a dedicated server sends more than this in one hour / one day (GB). */
  robotHourlyOutGb: number
  robotDailyOutGb: number
  /** Repeat an unresolved alert this often. */
  remindHours: number
  stateFile: string
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>

function number(env: Env, name: string, fallback?: number): number | undefined {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number, got ${JSON.stringify(raw)}`)
  return n
}

function url(env: Env, name: string): string | undefined {
  const raw = env[name]
  if (!raw) return undefined
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new ConfigError(`${name} is not a valid URL`)
  }
  if (u.protocol !== 'https:') throw new ConfigError(`${name} must use https`)
  return raw.replace(/\/+$/, '')
}

export function loadConfig(env: Env): Config {
  const mode = env.GUARD_MODE ?? 'dry-run'
  if (mode !== 'dry-run' && mode !== 'enforce') throw new ConfigError(`GUARD_MODE must be dry-run or enforce, got ${JSON.stringify(mode)}`)

  const hcloudToken = env.HCLOUD_TOKEN || undefined
  const robotUser = env.ROBOT_USER || undefined
  const robotPassword = env.ROBOT_PASSWORD || undefined
  if (!!robotUser !== !!robotPassword) throw new ConfigError('set both ROBOT_USER and ROBOT_PASSWORD, or neither')
  if (!hcloudToken && !robotUser) throw new ConfigError('nothing to watch: set HCLOUD_TOKEN and/or ROBOT_USER + ROBOT_PASSWORD')

  const ntfyUrl = url(env, 'NTFY_URL')
  if (!ntfyUrl) throw new ConfigError('NTFY_URL is required (for example https://ntfy.sh/<your-topic>)')

  const trafficWarnPercent = number(env, 'TRAFFIC_WARN_PERCENT', 50)!
  const trafficKillPercent = number(env, 'TRAFFIC_KILL_PERCENT', 90)!
  if (trafficWarnPercent >= trafficKillPercent) throw new ConfigError('TRAFFIC_WARN_PERCENT must be below TRAFFIC_KILL_PERCENT')

  const monthlyBudgetEur = number(env, 'MONTHLY_BUDGET_EUR')
  if (hcloudToken && monthlyBudgetEur === undefined) throw new ConfigError('MONTHLY_BUDGET_EUR is required with HCLOUD_TOKEN')

  return {
    mode,
    hcloudToken,
    robotUser,
    robotPassword,
    ntfyUrl,
    ntfyToken: env.NTFY_TOKEN || undefined,
    healthcheckUrl: url(env, 'HEALTHCHECK_URL'),
    trafficWarnPercent,
    trafficKillPercent,
    monthlyBudgetEur,
    // A 1 Gbit/s port tops out near 450 GB/hour.
    robotHourlyOutGb: number(env, 'ROBOT_HOURLY_OUT_GB', 200)!,
    robotDailyOutGb: number(env, 'ROBOT_DAILY_OUT_GB', 2000)!,
    remindHours: number(env, 'REMIND_HOURS', 6)!,
    stateFile: env.STATE_FILE || (env.STATE_DIRECTORY ? `${env.STATE_DIRECTORY}/state.json` : './state.json')
  }
}
