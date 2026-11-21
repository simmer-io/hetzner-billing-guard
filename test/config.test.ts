import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfigError, healthcheckUrlOf, loadConfig } from '../src/config.ts'

const base = { HCLOUD_TOKEN: 't', NTFY_URL: 'https://ntfy.sh/x', MONTHLY_BUDGET_EUR: '60' }

describe('loadConfig', () => {
  it('defaults to dry-run with the documented thresholds', () => {
    const c = loadConfig(base)
    assert.equal(c.mode, 'dry-run')
    assert.equal(c.trafficWarnPercent, 50)
    assert.equal(c.trafficKillPercent, 90)
    assert.deepEqual(c.killOverrides, {})
    assert.equal(c.stateFile, './state.json')
  })

  it('uses the systemd state directory', () => {
    assert.equal(loadConfig({ ...base, STATE_DIRECTORY: '/var/lib/billing-guard' }).stateFile, '/var/lib/billing-guard/state.json')
  })

  it('parses per-server kill overrides', () => {
    assert.deepEqual(loadConfig({ ...base, KILL_OVERRIDES: '12=120, 34=95.5' }).killOverrides, { 12: 120, 34: 95.5 })
  })

  it('accepts enforce mode with a healthcheck', () => {
    assert.equal(loadConfig({ ...base, GUARD_MODE: 'enforce', HEALTHCHECK_URL: 'https://hc-ping.com/abc' }).mode, 'enforce')
  })

  it('accepts alert-only with a healthcheck, and Slack alone or with ntfy', () => {
    const hc = { HEALTHCHECK_URL: 'https://hc-ping.com/abc' }
    assert.equal(loadConfig({ ...base, ...hc, GUARD_MODE: 'alert-only' }).mode, 'alert-only')
    const slack = 'https://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnop'
    const only = loadConfig({ HCLOUD_TOKEN: 't', MONTHLY_BUDGET_EUR: '60', SLACK_WEBHOOK_URL: slack })
    assert.equal(only.slackWebhookUrl, slack)
    assert.equal(only.ntfyUrl, undefined)
    assert.equal(loadConfig({ ...base, SLACK_WEBHOOK_URL: slack }).ntfyUrl, 'https://ntfy.sh/x')
  })

  it('never puts the Slack webhook in its error', () => {
    const bad = 'https://hooks.slack.com/services/secret-part-that-is-short'
    assert.throws(() => loadConfig({ ...base, SLACK_WEBHOOK_URL: `${bad}?x=<` }), (e: Error) => e instanceof ConfigError && !e.message.includes('secret-part'))
  })

  for (const [name, env] of Object.entries({
    'alert-only without a healthcheck': { ...base, GUARD_MODE: 'alert-only' },
    'a Slack URL that is not a Slack webhook': { ...base, SLACK_WEBHOOK_URL: 'https://example.com/services/T0000000/B0000000/abcdefghijklmnop' },
    'a plain-http Slack webhook': { ...base, SLACK_WEBHOOK_URL: 'http://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnop' },
    'an unknown mode': { ...base, GUARD_MODE: 'on' },
    'enforce without a healthcheck': { ...base, GUARD_MODE: 'enforce' },
    'nothing to watch': { NTFY_URL: 'https://ntfy.sh/x' },
    'no ntfy URL and no Slack webhook': { HCLOUD_TOKEN: 't', MONTHLY_BUDGET_EUR: '60' },
    'an ntfy URL with no topic': { ...base, NTFY_URL: 'https://ntfy.sh/' },
    'a plain-http ntfy URL': { ...base, NTFY_URL: 'http://ntfy.sh/x' },
    'credentials in a URL': { ...base, NTFY_URL: 'https://u:p@ntfy.sh/x' },
    'no budget for Cloud': { HCLOUD_TOKEN: 't', NTFY_URL: 'https://ntfy.sh/x' },
    'half the Robot credentials': { ...base, ROBOT_USER: 'u' },
    'warn above kill': { ...base, TRAFFIC_WARN_PERCENT: '95' },
    'a kill threshold over 100%': { ...base, TRAFFIC_KILL_PERCENT: '150' },
    'a non-number': { ...base, TRAFFIC_KILL_PERCENT: 'ninety' },
    'a malformed override': { ...base, KILL_OVERRIDES: 'app=120' },
    'an override over 200%': { ...base, KILL_OVERRIDES: '12=500' }
  })) {
    it(`rejects ${name}`, () => assert.throws(() => loadConfig(env), ConfigError))
  }

  it('can still find the healthcheck URL when the rest of the config is broken', () => {
    assert.equal(healthcheckUrlOf({ HEALTHCHECK_URL: 'https://hc-ping.com/abc' }), 'https://hc-ping.com/abc')
    assert.equal(healthcheckUrlOf({ HEALTHCHECK_URL: 'nope' }), undefined)
  })
})
