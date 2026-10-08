import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

import { auditNativeStore } from './native.ts'
import type { CompatibilityProgress } from './report.ts'
import { exchange, json, required, startSimulator } from './runtime.ts'

async function main(): Promise<void> {
  const provider = required('COMPAT_PROVIDER')
  assert(['acp', 'oar'].includes(provider))
  const root = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), `huihua-live-${provider}-`))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const port = Number(process.env.SIMULATOR_PORT ?? 18889)
  assert(Number.isSafeInteger(port) && port > 1024 && port < 65535)
  const base = `http://127.0.0.1:${port}`
  const control = `http://127.0.0.1:${port + 1}/_simulator`
  const simulator = startSimulator(resolve(required('SIMULATOR_DIR')), port)
  const output = resolve(required('COMPAT_REPORT'))
  const progress: CompatibilityProgress = { stage: 'simulator-startup', completed: [] }
  const env = { PATH: process.env.PATH ?? '', HOME: home, ANTHROPIC_API_KEY: 'synthetic-test-key', ANTHROPIC_BASE_URL: base, PI_OFFLINE: '1' }
  try {
    await simulator.ready()
    const template = await json(`${base}/v1/messages`, { model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'synthetic template' }] })
    await json(`${control}/reset`, {})
    const marker = `HUIHUA_${provider.toUpperCase()}_FIRST`
    await json(`${control}/enqueue`, { provider: 'anthropic', exchanges: [exchange(provider, marker, { type: 'text', text: `HUIHUA_${provider.toUpperCase()}_REPLY`, citations: null }, 'end_turn', template)] })
    progress.stage = 'producer'
    if (provider === 'acp') {
      await mkdir(join(home, '.qwen'))
      await writeFile(join(home, '.qwen/settings.json'), JSON.stringify({ $version: 4, modelProviders: { anthropic: [{ id: 'claude-sonnet-4-5', envKey: 'ANTHROPIC_API_KEY', baseUrl: base }] }, telemetry: { enabled: false }, general: { enableAutoUpdate: false } }))
      await captureAcp(resolve(required('PRODUCER_BIN')), workspace, env, root, marker)
    }
    else {
      const config = join(home, '.pi/agent')
      await mkdir(config, { recursive: true })
      await writeFile(join(config, 'models.json'), JSON.stringify({ providers: { synthetic: { baseUrl: base, api: 'anthropic-messages', apiKey: 'synthetic-test-key', models: [{ id: 'claude-sonnet-4-5', contextWindow: 200000, maxTokens: 1024 }] } } }))
      await new Promise<void>((resolveChild, reject) => {
        const child = spawn(process.execPath, [import.meta.filename, 'oar-child', required('PRODUCER_BIN'), root], { cwd: workspace, env: { ...env, OAR_PI_AGENT_DIR: config }, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
        child.stdout.on('data', (data) => {
          stdout += String(data)
        })
        child.stderr.on('data', (data) => {
          stderr += String(data)
        })
        child.once('error', reject)
        child.once('close', (code) => {
          clearTimeout(timer)
          void Promise.all([writeFile(join(root, 'producer.stdout'), stdout), writeFile(join(root, 'producer.stderr'), stderr)]).then(() => code === 0 ? resolveChild() : reject(new Error(`OAR producer exited ${code}: ${stderr.slice(-2000)}`)), reject)
        })
      })
    }
    await writeFile(join(root, 'ledger.json'), JSON.stringify(await json(`${control}/requests`), null, 2))
    await auditNativeStore(provider, home, root, progress)
    progress.completed.push('scenario')
    progress.stage = 'passed'
  }
  catch (error) {
    progress.error = String(error)
    process.exitCode = 1
  }
  finally {
    await simulator.stop(join(root, 'simulator.log'))
    await writeFile(output, JSON.stringify({ ...progress, artifacts: root }, null, 2))
    await writeFile(`${output}.progress.json`, JSON.stringify(progress, null, 2))
    console.log(JSON.stringify({ ...progress, artifacts: root }))
  }
}
async function captureAcp(binary: string, cwd: string, env: NodeJS.ProcessEnv, root: string, marker: string): Promise<void> {
  const child = spawn(binary, ['--acp', '--bare', '--auth-type', 'anthropic', '--model', 'claude-sonnet-4-5', '--telemetry=false'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines: string[] = []
  let stderr = ''
  let id = 0
  const pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void
    reject: (error: Error) => void
  }>()
  const input = createInterface({ input: child.stdout })
  input.on('line', (line) => {
    lines.push(line)
    try {
      const message = JSON.parse(line) as {
        id?: number
        result?: Record<string, unknown>
        error?: unknown
      }
      const request = message.id === undefined ? undefined : pending.get(message.id)
      if (request) {
        pending.delete(message.id!)
        if (message.error !== undefined)
          request.reject(new Error(JSON.stringify(message.error)))
        else
          request.resolve(message.result ?? {})
      }
    }
    catch (error) {
      for (const request of pending.values())
        request.reject(new Error(String(error)))
    }
  })
  child.stderr.on('data', (data) => {
    stderr += String(data)
  })
  child.once('error', (error) => {
    for (const request of pending.values())
      request.reject(error)
  })
  const closed = new Promise<void>(resolveClosed => child.once('close', () => resolveClosed()))
  const call = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const requestId = ++id
    const line = JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })
    lines.push(line)
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`ACP timed out: ${method}`))
      }, 45000)
      pending.set(requestId, {
        resolve(value) {
          clearTimeout(timer)
          resolveCall(value)
        },
        reject(error) {
          clearTimeout(timer)
          reject(error)
        },
      })
      child.stdin.write(`${line}\n`)
    })
  }
  try {
    await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'huihua-compat', version: '1' } })
    const session = await call('session/new', { cwd, mcpServers: [] })
    assert.equal(typeof session.sessionId, 'string')
    const result = await call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: marker }] })
    assert.equal(result.stopReason, 'end_turn')
  }
  finally {
    child.kill('SIGTERM')
    await Promise.race([closed, new Promise(resolveWait => setTimeout(resolveWait, 1000))])
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
    await closed
    input.close()
    await writeFile(join(root, 'session.acp.jsonl'), `${lines.join('\n')}\n`)
    await writeFile(join(root, 'producer.stderr'), stderr)
  }
}
async function oarChild(): Promise<void> {
  // Actual installed OAR SDK + bundled Pi, isolated in a separate process before import.
  // It receives only deterministic loopback text; no coding task or remote model is delegated.
  const module = await import(pathToFileURL(requiredArg(3)).href) as {
    piSession: (installation: object, options: object) => Promise<{
      id: string
      rawEvents: (fn: (record: unknown) => void) => () => void
      prompt: (text: string) => Promise<{
        seq: number
      }>
      dispose: () => Promise<void>
    }>
    openVoyage: (path: string, header: object) => {
      record: (record: unknown) => void
      end: (reason: string) => void
    }
    awaitTurnEnd: (session: unknown, seq: number) => Promise<{
      kind: string
    }>
  }
  const root = requiredArg(4)
  const cwd = join(root, 'workspace')
  const session = await module.piSession({ kind: 'available', via: 'bundled' }, { cwd, model: 'synthetic/claude-sonnet-4-5' })
  const writer = module.openVoyage(join(root, 'session.voyage.jsonl'), { runtime: 'pi', model: 'synthetic/claude-sonnet-4-5', cwd, sessionId: session.id, startedAt: Date.now(), recorder: 'huihua-producer-compat' })
  const unsubscribe = session.rawEvents(record => writer.record(record))
  try {
    const request = await session.prompt('HUIHUA_OAR_FIRST')
    const outcome = await module.awaitTurnEnd(session, request.seq)
    assert.equal(outcome.kind, 'completed')
  }
  finally {
    unsubscribe()
    writer.end('synthetic completed')
    await session.dispose()
  }
}
function requiredArg(index: number): string {
  const value = process.argv[index]
  assert(value !== undefined)
  return value
}
if (import.meta.main) {
  if (process.argv[2] === 'oar-child')
    await oarChild()
  else
    await main()
}
