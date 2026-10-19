// Configuration comes only from environment variables, checked once at startup. A bad value stops the
// run with a clear message (and a healthcheck failure ping, when the healthcheck URL itself is valid).

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
  /** Shut the server down at this share (enforce mode only). At most 100. */
  trafficKillPercent: number
  /** Per-server kill thresholds (server id → percent, at most 200), to bring one server back without uncapping the rest. */
  killOverrides: Record<string, number>
  /** Alert when the estimated monthly Cloud run-rate goes above this (in the API's currency, excl. VAT). */
  monthlyBudget?: number
  /** Alert when a dedicated server sends more than this in one hour / 24 hours (GB). */
  robotHourlyOutGb: number
  robotDailyOutGb: number
  /** Repeat an unresolved alert this often. */
  remindHours: number
  stateFile: string
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>

function number(env: Env, name: string, fallback?: number, max?: number): number | undefined {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number, got ${JSON.stringify(raw)}`)
  if (max !== undefined && n > max) throw new ConfigError(`${name} must be at most ${max}, got ${n}`)
  return n
}

function url(env: Env, name: string, { needsPath }: { needsPath: boolean }): string | undefined {
  const raw = env[name]
  if (!raw) return undefined
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new ConfigError(`${name} is not a valid URL`)
  }
  if (u.protocol !== 'https:') throw new ConfigError(`${name} must use https`)
  if (u.username || u.password) throw new ConfigError(`${name} must not contain a user or password; use the token variable`)
  if (needsPath && u.pathname.replace(/\/+$/, '') === '') throw new ConfigError(`${name} needs a path (for ntfy, the topic: https://ntfy.sh/<topic>)`)
  u.pathname = u.pathname.replace(/\/+$/, '')
  return u.toString()
}

/** "123=120,456=150": per-server kill thresholds. */
function overrides(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const m = /^(\d+)=(\d+(?:\.\d+)?)$/.exec(part)
    if (!m) throw new ConfigError(`KILL_OVERRIDES: expected <server id>=<percent>, got ${JSON.stringify(part)}`)
    const pct = Number(m[2])
    if (pct <= 0 || pct > 200) throw new ConfigError(`KILL_OVERRIDES: ${m[1]} must be between 0 and 200 percent`)
    out[m[1]!] = pct
  }
  return out
}

/** Only the healthcheck URL, for reporting a config error. Never throws. */
export function healthcheckUrlOf(env: Env): string | undefined {
  try {
    return url(env, 'HEALTHCHECK_URL', { needsPath: true })
  } catch {
    return undefined
  }
}

export function loadConfig(env: Env): Config {
  const mode = env.GUARD_MODE ?? 'dry-run'
  if (mode !== 'dry-run' && mode !== 'enforce') throw new ConfigError(`GUARD_MODE must be dry-run or enforce, got ${JSON.stringify(mode)}`)

  const hcloudToken = env.HCLOUD_TOKEN || undefined
  const robotUser = env.ROBOT_USER || undefined
  const robotPassword = env.ROBOT_PASSWORD || undefined
  if (!!robotUser !== !!robotPassword) throw new ConfigError('set both ROBOT_USER and ROBOT_PASSWORD, or neither')
  if (!hcloudToken && !robotUser) throw new ConfigError('nothing to watch: set HCLOUD_TOKEN and/or ROBOT_USER + ROBOT_PASSWORD')

  const ntfyUrl = url(env, 'NTFY_URL', { needsPath: true })
  if (!ntfyUrl) throw new ConfigError('NTFY_URL is required (for example https://ntfy.sh/<your-topic>)')

  const healthcheckUrl = url(env, 'HEALTHCHECK_URL', { needsPath: true })
  // The healthcheck is the only signal that the guard itself has stopped.
  if (mode === 'enforce' && !healthcheckUrl) throw new ConfigError('HEALTHCHECK_URL is required in enforce mode')

  const trafficWarnPercent = number(env, 'TRAFFIC_WARN_PERCENT', 50, 100)!
  const trafficKillPercent = number(env, 'TRAFFIC_KILL_PERCENT', 90, 100)!
  if (trafficWarnPercent >= trafficKillPercent) throw new ConfigError('TRAFFIC_WARN_PERCENT must be below TRAFFIC_KILL_PERCENT')

  const monthlyBudget = number(env, 'MONTHLY_BUDGET_EUR')
  if (hcloudToken && monthlyBudget === undefined) throw new ConfigError('MONTHLY_BUDGET_EUR is required with HCLOUD_TOKEN')

  return {
    mode,
    hcloudToken,
    robotUser,
    robotPassword,
    ntfyUrl,
    ntfyToken: env.NTFY_TOKEN || undefined,
    healthcheckUrl,
    trafficWarnPercent,
    trafficKillPercent,
    killOverrides: overrides(env.KILL_OVERRIDES),
    monthlyBudget,
    // A 1 Gbit/s port tops out near 450 GB/hour.
    robotHourlyOutGb: number(env, 'ROBOT_HOURLY_OUT_GB', 200)!,
    robotDailyOutGb: number(env, 'ROBOT_DAILY_OUT_GB', 2000)!,
    remindHours: number(env, 'REMIND_HOURS', 6)!,
    stateFile: env.STATE_FILE || (env.STATE_DIRECTORY ? `${env.STATE_DIRECTORY}/state.json` : './state.json')
  }
}
