// One guard run: read Hetzner, decide, act, alert, remember. A systemd timer runs it every 5 minutes
// (see deploy/). `node src/main.ts --test-alert` only sends a test notification.

import { ConfigError, loadConfig, type Config } from './config.ts'
import { due, estimateMonthly, evaluate, type Alert, type Inputs } from './evaluate.ts'
import { Hcloud } from './hcloud.ts'
import { ping, sendNtfy } from './notify.ts'
import { Robot } from './robot.ts'
import { loadState, saveState } from './state.ts'

let cfg: Config
try {
  cfg = loadConfig(process.env)
} catch (e) {
  if (!(e instanceof ConfigError)) throw e
  console.error(`config: ${e.message}`)
  process.exit(2)
}

if (process.argv.includes('--test-alert')) {
  await sendNtfy(cfg.ntfyUrl, cfg.ntfyToken, { key: 'test', priority: 'default', title: 'Hetzner billing guard test', message: 'If you can read this, alerts work.' })
  console.log('test alert sent')
  process.exit(0)
}

const now = new Date()
await ping(cfg.healthcheckUrl, 'start')
const problems: string[] = []
const extra: Alert[] = []
const prev = await loadState(cfg.stateFile)

const inputs: Inputs = {}
const hcloud = cfg.hcloudToken ? new Hcloud(cfg.hcloudToken) : undefined
if (hcloud) {
  try {
    inputs.cloud = await hcloud.snapshot()
  } catch (e) {
    problems.push((e as Error).message)
    extra.push({ key: 'error:hcloud', priority: 'high', title: 'Hetzner billing guard: Cloud API failing', message: `Can't read the Hetzner Cloud API, so traffic isn't being watched: ${(e as Error).message}. A revoked or expired token looks like this.` })
  }
}
if (cfg.robotUser) {
  try {
    inputs.dedicated = await new Robot(cfg.robotUser, cfg.robotPassword!).traffic(now)
  } catch (e) {
    problems.push((e as Error).message)
    extra.push({ key: 'error:robot', priority: 'high', title: 'Hetzner billing guard: Robot API failing', message: `Can't read dedicated-server traffic: ${(e as Error).message}.` })
  }
}

const { alerts, actions, state } = evaluate(inputs, cfg, prev, now)

for (const a of actions) {
  if (cfg.mode === 'dry-run') {
    console.log(`dry-run: would ${a.kind} ${a.serverName} (${a.serverId})`)
    continue
  }
  try {
    await (a.kind === 'shutdown' ? hcloud!.shutdown(a.serverId) : hcloud!.poweroff(a.serverId))
    console.log(`${a.kind}: ${a.serverName} (${a.serverId})`)
    if (a.kind === 'shutdown') state.shutdownAt[a.serverId] = now.toISOString()
  } catch (e) {
    problems.push((e as Error).message)
    extra.push({ key: `action-failed:${a.serverId}`, priority: 'urgent', title: `Hetzner billing guard: could not stop ${a.serverName}`, message: `${a.kind} of ${a.serverName} failed: ${(e as Error).message}. Stop it in the console now.`, force: true })
  }
}

const { send, lastSent } = due([...alerts, ...extra], state, now, cfg.remindHours)
state.lastSent = lastSent
let delivered = 0
for (const a of send) {
  try {
    await sendNtfy(cfg.ntfyUrl, cfg.ntfyToken, a)
    console.log(`alert sent: ${a.title}`)
    delivered++
  } catch (e) {
    problems.push((e as Error).message)
    // Not delivered, so try again next run.
    if (prev.lastSent[a.key]) state.lastSent[a.key] = prev.lastSent[a.key]!
    else delete state.lastSent[a.key]
  }
}
await saveState(cfg.stateFile, state)

// The journal gets a short report every run.
if (inputs.cloud) {
  for (const s of inputs.cloud.servers) {
    const pct = s.included_traffic ? ((s.outgoing_traffic ?? 0) / s.included_traffic) * 100 : 0
    console.log(`server ${s.name}: ${s.status}, traffic ${pct.toFixed(2)}% of included`)
  }
  console.log(`estimated monthly: €${estimateMonthly(inputs.cloud).total.toFixed(2)} (budget €${cfg.monthlyBudgetEur})`)
}
for (const d of inputs.dedicated ?? []) console.log(`dedicated ${d.name}: ${d.todayOutGb.toFixed(1)} GB out today, peak hour ${d.peakHourOutGb.toFixed(1)} GB`)
console.log(`${cfg.mode}: ${alerts.length + extra.length} alert(s) active, ${delivered} of ${send.length} sent, ${actions.length} action(s)`)

if (problems.length) {
  await ping(cfg.healthcheckUrl, 'fail', problems.join('\n'))
  console.error(problems.join('\n'))
  process.exit(1)
}
await ping(cfg.healthcheckUrl, 'success')
