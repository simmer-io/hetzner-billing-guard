// One guard run: read Hetzner, decide, act, alert, remember. A systemd timer runs it every 5 minutes
// (see deploy/). `node src/main.ts --test-alert` only sends a test notification.
//
// Any run that couldn't fully do its job (an API it couldn't read, an action or alert that failed)
// exits 1 and pings the healthcheck's /fail, so a guard that's quietly not watching is never "green".

import { ConfigError, healthcheckUrlOf, loadConfig, type Config } from './config.ts'
import { complete, due, estimateMonthly, evaluate, includedTraffic, type Alert, type Inputs } from './evaluate.ts'
import { Hcloud } from './hcloud.ts'
import { ping, sendNtfy } from './notify.ts'
import { Robot } from './robot.ts'
import { loadState, saveState } from './state.ts'

/** Below the unit's TimeoutStartSec, so a hung run still reports its failure. */
const DEADLINE_MS = 100_000

let cfg: Config
try {
  cfg = loadConfig(process.env)
} catch (e) {
  if (!(e instanceof ConfigError)) throw e
  console.error(`config: ${e.message}`)
  await ping(healthcheckUrlOf(process.env), 'fail', `config: ${e.message}`)
  process.exit(2)
}

if (process.argv.includes('--test-alert')) {
  await sendNtfy(cfg.ntfyUrl, cfg.ntfyToken, { key: 'test', priority: 'default', title: 'Hetzner billing guard test', message: 'If you can read this, alerts work.' })
  console.log('test alert sent')
  process.exit(0)
}

setTimeout(() => {
  console.error(`run took longer than ${DEADLINE_MS / 1000}s; giving up`)
  void ping(cfg.healthcheckUrl, 'fail', 'run deadline exceeded').finally(() => process.exit(1))
}, DEADLINE_MS).unref()

try {
  const problems = await run(cfg)
  if (problems.length) {
    console.error(problems.join('\n'))
    await ping(cfg.healthcheckUrl, 'fail', problems.join('\n'))
    process.exit(1)
  }
  await ping(cfg.healthcheckUrl, 'success')
} catch (e) {
  const msg = `crashed: ${(e as Error).message}`
  console.error(msg)
  await ping(cfg.healthcheckUrl, 'fail', msg)
  process.exit(1)
}

async function run(cfg: Config): Promise<string[]> {
  const now = new Date()
  await ping(cfg.healthcheckUrl, 'start')
  const problems: string[] = []
  const extra: Alert[] = []

  const loaded = await loadState(cfg.stateFile, now)
  const prev = loaded.state
  if (loaded.reset) {
    problems.push(loaded.reset)
    extra.push({ key: 'state-reset', priority: 'high', title: 'Hetzner billing guard: state reset', message: `${loaded.reset}. The guard started over with a new baseline, so resources created recently won't be reported as new.`, force: true })
  }

  const inputs: Inputs = {}
  const hcloud = cfg.hcloudToken ? new Hcloud(cfg.hcloudToken) : undefined
  const robot = cfg.robotUser ? new Robot(cfg.robotUser, cfg.robotPassword!) : undefined
  await Promise.all([
    hcloud?.servers().then((s) => {
      inputs.servers = s
    }, (e: Error) => {
      problems.push(e.message)
      extra.push({ key: 'error:hcloud', priority: 'urgent', title: 'Hetzner billing guard: Cloud API failing', message: `Can't list Cloud servers, so the traffic cap isn't working: ${e.message}. A revoked or expired token looks like this.` })
    }),
    hcloud?.inventory().then(({ inventory, errors }) => {
      inputs.inventory = inventory
      if (errors.length) {
        problems.push(...errors)
        extra.push({ key: 'error:hcloud-inventory', priority: 'high', title: 'Hetzner billing guard: part of the Cloud API failing', message: `New-resource and budget checks are partly off: ${errors.join('; ')}.` })
      }
    }),
    robot?.traffic(now).then((d) => {
      inputs.dedicated = d
    }, (e: Error) => {
      problems.push(e.message)
      extra.push({ key: 'error:robot', priority: 'high', title: 'Hetzner billing guard: Robot API failing', message: `Can't read dedicated-server traffic: ${e.message}.` })
    })
  ])

  const { alerts, actions, state, problems: ruleProblems } = evaluate(inputs, cfg, prev, now)
  problems.push(...ruleProblems)

  for (const a of actions) {
    if (cfg.mode === 'dry-run') {
      console.log(`dry-run: would ${a.kind} ${a.serverName} (${a.serverId})`)
      continue
    }
    try {
      await (a.kind === 'shutdown' ? hcloud!.shutdown(a.serverId) : hcloud!.poweroff(a.serverId))
      console.log(`${a.kind}: ${a.serverName} (${a.serverId})`)
      // The next escalation (or a repeated power-off) waits POWEROFF_AFTER_MS from now.
      state.shutdownAt[a.serverId] = now.toISOString()
    } catch (e) {
      problems.push((e as Error).message)
      extra.push({ key: `action-failed:${a.serverId}`, priority: 'urgent', title: `Hetzner billing guard: could not stop ${a.serverName}`, message: `${a.kind} of ${a.serverName} failed: ${(e as Error).message}. Stop it in the console now.`, remindMinutes: 30 })
    }
  }
  // Save what was done before notifying, so a hung notification can't make the next run repeat it.
  await saveState(cfg.stateFile, state)

  const { send, lastSent } = due([...alerts, ...extra], state, now, cfg.remindHours)
  state.lastSent = lastSent
  let delivered = 0
  for (const a of send) {
    try {
      await sendNtfy(cfg.ntfyUrl, cfg.ntfyToken, a)
      console.log(`alert sent: ${a.title}`)
      delivered++
      if (a.key === 'new-resources') state.pendingNew = {}
    } catch (e) {
      problems.push(`alert "${a.title}" not delivered: ${(e as Error).message}`)
      // Not delivered, so it's due again next run.
      if (prev.lastSent[a.key]) state.lastSent[a.key] = prev.lastSent[a.key]!
      else delete state.lastSent[a.key]
    }
  }
  await saveState(cfg.stateFile, state)

  // The journal gets a short report every run.
  for (const s of inputs.servers ?? []) {
    const included = includedTraffic(s)
    const pct = included ? ((s.outgoing_traffic ?? 0) / included) * 100 : 0
    console.log(`server ${s.name}: ${s.status}, traffic ${pct.toFixed(2)}% of included`)
  }
  if (inputs.servers && inputs.inventory && complete(inputs.inventory)) {
    const est = estimateMonthly(inputs.servers, inputs.inventory)
    console.log(`estimated monthly run-rate: ${est.total.toFixed(2)} ${est.currency} (budget ${cfg.monthlyBudget})`)
  }
  for (const d of inputs.dedicated ?? []) console.log(`dedicated ${d.name}: ${d.lastHourOutGb.toFixed(1)} GB out last hour, ${d.last24hOutGb.toFixed(1)} GB in 24h${d.quotaGb ? `, ${d.monthOutGb!.toFixed(0)} of ${d.quotaGb} GB this month` : ''}`)
  console.log(`${cfg.mode}: ${alerts.length + extra.length} alert(s) active, ${delivered} of ${send.length} sent, ${actions.length} action(s)`)
  return problems
}
