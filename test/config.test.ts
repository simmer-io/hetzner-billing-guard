import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfigError, loadConfig } from '../src/config.ts'

const base = { HCLOUD_TOKEN: 't', NTFY_URL: 'https://ntfy.sh/x', MONTHLY_BUDGET_EUR: '60' }

describe('loadConfig', () => {
  it('defaults to dry-run with the documented thresholds', () => {
    const c = loadConfig(base)
    assert.equal(c.mode, 'dry-run')
    assert.equal(c.trafficWarnPercent, 50)
    assert.equal(c.trafficKillPercent, 90)
    assert.equal(c.stateFile, './state.json')
  })

  it('uses the systemd state directory', () => {
    assert.equal(loadConfig({ ...base, STATE_DIRECTORY: '/var/lib/billing-guard' }).stateFile, '/var/lib/billing-guard/state.json')
  })

  for (const [name, env] of Object.entries({
    'an unknown mode': { ...base, GUARD_MODE: 'on' },
    'nothing to watch': { NTFY_URL: 'https://ntfy.sh/x' },
    'no ntfy URL': { HCLOUD_TOKEN: 't', MONTHLY_BUDGET_EUR: '60' },
    'a plain-http ntfy URL': { ...base, NTFY_URL: 'http://ntfy.sh/x' },
    'no budget for Cloud': { HCLOUD_TOKEN: 't', NTFY_URL: 'https://ntfy.sh/x' },
    'half the Robot credentials': { ...base, ROBOT_USER: 'u' },
    'warn above kill': { ...base, TRAFFIC_WARN_PERCENT: '95' },
    'a non-number': { ...base, TRAFFIC_KILL_PERCENT: 'ninety' }
  })) {
    it(`rejects ${name}`, () => assert.throws(() => loadConfig(env), ConfigError))
  }
})
