import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

import { sessions } from '../src/index.ts'
import { assertKimiReplies } from './producer-compat-kimi-audit.ts'
import { exchange, json, required } from './producer-compat-runtime.ts'
import type { CompatibilityProgress } from './producer-compat-summary.ts'

const simulatorDir = resolve(required('SIMULATOR_DIR'))
const kimi = resolve(required('KIMI_BIN'))
const root = await mkdtemp(join(tmpdir(), 'huihua-kimi-'))
const home = join(root, 'home')
const config = join(home, '.kimi-code')
const workspace = join(root, 'workspace')
await mkdir(config, { recursive: true })
await mkdir(workspace)
const port = Number(process.env.SIMULATOR_PORT ?? 18889)
assert(Number.isSafeInteger(port) && port > 1024 && port < 65535)
const base = `http://127.0.0.1:${port}`
const control = `http://127.0.0.1:${port + 1}/_simulator`
await writeFile(join(config, 'config.toml'), `default_model = "probe"
telemetry = false
auto_session_title = false
builtin_product_skills = false
[providers.local]
type = "anthropic"
base_url = "${base}"
api_key = "synthetic-test-key"
[models.probe]
provider = "local"
model = "claude-sonnet-4-5"
max_context_size = 200000
max_output_size = 1024
[loop_control]
max_attempts_per_step = 1
`)
const server = spawn(process.execPath, ['--import', join(simulatorDir, 'node_modules/tsx/dist/loader.mjs'), join(simulatorDir, 'run.ts'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout.on('data', (chunk) => {
  serverLog += String(chunk)
})
server.stderr.on('data', (chunk) => {
  serverLog += String(chunk)
})
const output = resolve(process.env.COMPAT_REPORT ?? 'kimi-compat-report.json')
const progress: CompatibilityProgress = { stage: 'simulator-startup', completed: [] }
try {
  for (let attempt = 0; ; attempt++) {
    try {
      await json(`${control}/requests`)
      break
    }
    catch (error) {
      if (attempt >= 40 || server.exitCode !== null)
        throw error
      await delay(100)
    }
  }
  progress.stage = 'producer'
  const template = await json(`${base}/v1/messages`, { model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'synthetic template' }] })
  await json(`${control}/reset`, {})
  for (const turn of [
    { prompt: 'HUIHUA_KIMI_FIRST', reply: 'HUIHUA_KIMI_REPLY', args: [] },
    { prompt: 'HUIHUA_KIMI_RESUME', reply: 'HUIHUA_KIMI_RESUMED', args: ['--continue'] },
  ]) {
    await json(`${control}/enqueue`, { provider: 'anthropic', exchanges: [exchange(turn.prompt, turn.prompt, { type: 'text', text: turn.reply, citations: null }, 'end_turn', template)] })
    const stdout = execFileSync(kimi, [...turn.args, '-p', turn.prompt, '--output-format', 'stream-json'], { cwd: workspace, env: { PATH: process.env.PATH ?? '', HOME: home, KIMI_CODE_HOME: config }, timeout: 45000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    await writeFile(join(root, `${turn.prompt}.jsonl`), stdout)
    assert(stdout.includes(turn.reply), 'producer did not return the scenario reply')
  }
  await writeFile(join(root, 'ledger.json'), JSON.stringify(await json(`${control}/requests`), null, 2))
  progress.stage = 'native-inventory'
  const wires = await findWires(config)
  assert.equal(wires.length, 1, 'resume must use one independently inventoried native agent wire')
  const path = wires[0]!
  const text = await readFile(path, 'utf8')
  const rows = text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as unknown)
  const state = JSON.parse(await readFile(join(dirname(dirname(dirname(path))), 'state.json'), 'utf8')) as { id: string }
  assert.equal(typeof state.id, 'string')
  progress.auditedSessions = wires.length
  progress.auditedRecords = rows.length
  await writeFile(join(root, 'native-inventory.json'), JSON.stringify({ path, state, rows }, null, 2))
  progress.stage = 'scan'
  const scan = await sessions.scan({ providers: ['kimi'], homeDir: home })
  await writeFile(join(root, 'scan.json'), JSON.stringify(scan, null, 2))
  assert.deepEqual(scan.failures, [])
  assert.deepEqual(scan.refs.map(ref => [ref.id, ref.provider, ref.source.path, ref.source.format]), [[state.id, 'kimi', path, 'jsonl']])
  progress.completed.push('scan')
  const ref = scan.refs[0]!
  const handle = await sessions.open(ref)
  for (const kind of ['read', 'snapshot', 'records', 'events']) {
    progress.stage = kind
    let session = kind === 'snapshot' ? await handle.snapshot() : await sessions.read(ref)
    if (kind === 'records') {
      const records = []
      for await (const record of handle.records()) records.push(record)
      session = { ...session, records }
    }
    if (kind === 'events') {
      const events = []
      for await (const event of handle.events()) events.push(event)
      session = { ...session, events }
    }
    await writeFile(join(root, `${kind}.json`), JSON.stringify(session, null, 2))
    assert.deepEqual(session.records.map(record => record.native), [state, ...rows], 'Kimi raw native records changed or missing')
    assertKimiReplies(rows, session.events)
    progress.completed.push(kind)
  }
  progress.stage = 'passed'
}
catch (error) {
  progress.error = String(error)
  await writeFile(`${output}.failure.json`, JSON.stringify({ ...progress, artifacts: root }, null, 2))
  console.error(progress.error)
  process.exitCode = 1
}
finally {
  server.kill('SIGINT')
  await writeFile(join(root, 'simulator.log'), serverLog)
  await writeFile(output, JSON.stringify({ ...progress, artifacts: root }, null, 2))
  await writeFile(`${output}.progress.json`, JSON.stringify(progress, null, 2))
  console.log(JSON.stringify({ ...progress, artifacts: root }))
}

async function findWires(directory: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      result.push(...await findWires(path))
    else if (entry.isFile() && basename(path) === 'wire.jsonl')
      result.push(path)
  }
  return result.sort()
}
