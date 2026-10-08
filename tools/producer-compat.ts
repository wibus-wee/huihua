import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

import { sessions } from '../src/index.ts'
import type { DriftSummary } from './producer-compat-assertions.ts'
import { assertNoProducerDrift } from './producer-compat-assertions.ts'
import { assertDiscovery, assertNativeRead, inventoryNativeStores, nativeFieldPaths } from './producer-compat-audit.ts'

// Test infrastructure only: the production library never executes a producer.
const simulatorDir = resolve(required('SIMULATOR_DIR'))
const claude = resolve(required('CLAUDE_BIN'))
const root = await mkdtemp(join(tmpdir(), 'huihua-producer-'))
const home = join(root, 'home')
const workspace = join(root, 'workspace')
const config = join(home, '.claude')
await Promise.all([home, workspace, config].map(async path => mkdir(path, { recursive: true })))
const port = Number(process.env.SIMULATOR_PORT ?? 18887)
assert(Number.isSafeInteger(port) && port > 1024 && port < 65535)
const base = `http://127.0.0.1:${port}`
const control = `http://127.0.0.1:${port + 1}/_simulator`
const server = spawn(process.execPath, ['--import', join(simulatorDir, 'node_modules/tsx/dist/loader.mjs'), join(simulatorDir, 'run.ts'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout.on('data', (chunk) => {
  serverLog += String(chunk)
})
server.stderr.on('data', (chunk) => {
  serverLog += String(chunk)
})
const env = {
  PATH: process.env.PATH ?? '',
  HOME: home,
  CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_API_KEY: 'synthetic-test-key',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
}
const firstPrompt = 'HUIHUA_PRODUCER_FIRST'
const finalText = 'HUIHUA_ASSISTANT_COMPLETE'
const resumedText = 'HUIHUA_ASSISTANT_RESUMED'
const toolText = 'HUIHUA_NATIVE_TOOL_RESULT'
const file = join(workspace, 'synthetic.txt')
await writeFile(file, `${toolText}\n`)
const sessionId = randomUUID()
const secondSessionId = randomUUID()
const secondPrompt = 'HUIHUA_SECOND_SESSION'
const secondText = 'HUIHUA_SECOND_RESPONSE'
const output = resolve(process.env.COMPAT_REPORT ?? 'producer-compat-report.json')
let stage = 'simulator-startup'
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
  stage = 'scenario-setup'
  const template = await json(`${base}/v1/messages`, { model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'synthetic template' }] })
  await json(`${control}/reset`, {})
  const tool = { type: 'tool_use', id: 'huihua_tool_1', name: 'Read', input: { file_path: file } }
  await json(`${control}/enqueue`, { provider: 'anthropic', exchanges: [
    exchange('read synthetic file', firstPrompt, tool, 'tool_use', template),
    exchange('complete after tool', toolText, { type: 'text', text: finalText, citations: null }, 'end_turn', template),
  ] })
  stage = 'producer-first-turn'
  await runClaude(['--session-id', sessionId], firstPrompt)
  stage = 'producer-resume'
  await json(`${control}/enqueue`, { provider: 'anthropic', exchanges: [
    exchange('resume native session', 'HUIHUA_PRODUCER_RESUME', { type: 'text', text: resumedText, citations: null }, 'end_turn', template),
  ] })
  await runClaude(['--resume', sessionId], 'HUIHUA_PRODUCER_RESUME')
  stage = 'producer-second-session'
  await json(`${control}/enqueue`, { provider: 'anthropic', exchanges: [
    exchange('second independent session', secondPrompt, { type: 'text', text: secondText, citations: null }, 'end_turn', template),
  ] })
  await runClaude(['--session-id', secondSessionId], secondPrompt)
  stage = 'native-inventory'
  const stores = await inventoryNativeStores(home)
  await writeFile(join(root, 'native-inventory.json'), JSON.stringify(stores, null, 2))
  stage = 'huihua-discovery-audit'
  const scan = await sessions.scan({ providers: ['claude'], homeDir: home })
  assertDiscovery(stores, scan, [sessionId, secondSessionId])
  stage = 'huihua-read-audit'
  for (const store of stores) {
    const discovered = scan.refs.find(ref => ref.source.path === store.path)!
    const read = await sessions.read(discovered)
    assertNativeRead(store, read)
    const handle = await sessions.open(discovered)
    assertNativeRead(store, await handle.snapshot())
    const records = []
    for await (const record of handle.records()) records.push(record)
    assertNativeRead(store, { ...read, records })
    const events = []
    for await (const event of handle.events()) events.push(event)
    assertNativeRead(store, { ...read, events })
  }
  stage = 'scenario-coverage'
  const secondNative = stores.find(store => store.id === secondSessionId)!
  assert(secondNative.rows.some(row => JSON.stringify(row.native).includes(secondPrompt)), 'second prompt was not persisted')
  assert(secondNative.rows.some(row => JSON.stringify(row.native).includes(secondText)), 'second response was not persisted')
  const ref = scan.refs.find(item => item.id === sessionId)
  assert(ref, 'real producer did not persist a discoverable session')
  const session = await sessions.read(ref)
  const opened = await sessions.open(ref)
  const snapshot = await opened.snapshot()
  assert.deepEqual(snapshot, session)
  const streamed = []
  for await (const event of opened.events()) streamed.push(event)
  assert.deepEqual(streamed, session.events)
  const text = (kind: 'user_message' | 'assistant_message') => session.events.flatMap(event => (event.type === 'user_message' || event.type === 'assistant_message') && event.type === kind ? event.data.content : []).filter(block => block.type === 'text').map(block => block.data).join('\n')
  assert(text('user_message').includes(firstPrompt))
  assert(text('user_message').includes('HUIHUA_PRODUCER_RESUME'))
  assert(text('assistant_message').includes(finalText))
  assert(text('assistant_message').includes(resumedText))
  const call = session.events.find(event => event.type === 'tool_call' && event.data.callId === 'huihua_tool_1')
  assert(call?.type === 'tool_call' && call.data.toolName === 'Read')
  assert.deepEqual(call.data.arguments, { file_path: file })
  const result = session.events.find(event => event.type === 'tool_result' && event.data.callId === 'huihua_tool_1')
  assert(result?.type === 'tool_result' && !result.data.isError)
  assert(JSON.stringify(result.data.result).includes(toolText))
  assert(call.sequence < result.sequence, 'tool result must follow its call')
  const unknown: Record<string, number> = {}
  for (const event of session.events) {
    if (event.type === 'unknown')
      unknown[event.data.sourceType] = (unknown[event.data.sourceType] ?? 0) + 1
  }
  const structured = session.events.filter(event => event.type === 'user_message' || event.type === 'assistant_message').flatMap(event => event.data.content).filter(block => block.type === 'structured').length
  const fieldPaths = nativeFieldPaths(stores, false)
  const groupedFieldPaths = nativeFieldPaths(stores)
  const report = { provider: 'claude', auditedSessions: stores.length, auditedRecords: stores.reduce((sum, store) => sum + store.rows.length, 0), sessionId, records: session.records.length, events: session.events.length, unknown, structured, diagnostics: session.diagnostics, fieldPaths, groupedFieldPaths, inventory: stores.map(store => ({ path: store.path, id: store.id, records: store.rows.length })) }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(join(root, 'ledger.json'), JSON.stringify(await json(`${control}/requests`), null, 2))
  stage = 'compatibility-baseline'
  const baseline = JSON.parse(await readFile(new URL('./producer-compat-baseline.json', import.meta.url), 'utf8')) as DriftSummary
  assertNoProducerDrift(report, baseline)
  assert.equal(session.diagnostics.length, Object.values(unknown).reduce((sum, count) => sum + count, 0), 'unexpected diagnostics beyond known unknown records')
  assert(session.diagnostics.every(diagnostic => diagnostic.code === 'PartialParse' && diagnostic.message.startsWith('unrecognized native record ')))
  console.log(JSON.stringify({ stage: 'passed', report: output, artifacts: root, unknown, structured }))
}
catch (error) {
  await writeFile(join(root, 'simulator.log'), serverLog)
  await writeFile(`${output}.failure.json`, JSON.stringify({ stage, artifacts: root, error: String(error) }, null, 2))
  console.error(JSON.stringify({ stage, artifacts: root, error: String(error) }))
  process.exitCode = 1
}
finally {
  server.kill('SIGINT')
}

function required(name: string): string {
  const value = process.env[name]
  assert(value !== undefined && value !== '', `${name} is required`)
  return value
}
async function json(url: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { 'content-type': 'application/json', 'x-api-key': 'synthetic-test-key', 'anthropic-version': '2023-06-01' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
  assert(response.ok, `${url}: ${response.status} ${await response.clone().text()}`)
  return await response.json() as Record<string, unknown>
}
function exchange(label: string, marker: string, block: Record<string, unknown>, stop: string, template: Record<string, unknown>) {
  const delta = block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text }
  return { label, request: { method: 'POST', path: '/v1/messages', bodyTextIncludes: [marker] }, response: { kind: 'stream', steps: [
    { kind: 'event', event: { type: 'message_start', message: { ...template, id: `msg_${label.replaceAll(' ', '_')}`, content: [], stop_reason: null } } },
    { kind: 'event', event: { type: 'content_block_start', index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' } } },
    { kind: 'event', event: { type: 'content_block_delta', index: 0, delta } },
    { kind: 'event', event: { type: 'content_block_stop', index: 0 } },
    { kind: 'event', event: { type: 'message_delta', context_management: null, delta: { stop_reason: stop, stop_sequence: null, stop_details: null, container: null }, usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, fallback_credit: null, input_tokens: 1, iterations: null, output_tokens: 12, output_tokens_details: null, server_tool_use: null } } },
    { kind: 'event', event: { type: 'message_stop' } },
    { kind: 'close' },
  ] } }
}
async function runClaude(args: string[], prompt: string): Promise<void> {
  const child = spawn(claude, ['--bare', '-p', '--model', 'claude-sonnet-4-5', '--output-format', 'json', '--tools', 'Read', '--allowedTools', 'Read', ...args], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end(prompt)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 45000)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  clearTimeout(timeout)
  await writeFile(join(root, `${stage}.json`), stdout)
  await writeFile(join(root, `${stage}.stderr`), stderr)
  assert.equal(code, 0, stderr)
  const result = JSON.parse(stdout) as { is_error?: boolean }
  assert.equal(result.is_error, false)
}
