import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

import type { ScanResult, Session, SessionEvent } from '../../src/index.ts'
import { sessions } from '../../src/index.ts'
import type { CompatibilityProgress } from './report.ts'
import type { DriftSummary, NativeStore } from './runtime.ts'
import { assertNoProducerDrift, exchange, json, NativeDriftError, nativeFieldPaths, required, startSimulator } from './runtime.ts'

// Independent test oracle, deliberately not Huihua's walker, framer or mapper.
// Only the isolated producer's JSONL is inspected. No user stores are read or repaired.
export async function inventoryNativeStores(root: string): Promise<NativeStore[]> {
  const stores: NativeStore[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      }
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const bytes = await readFile(path)
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        const rows: NativeStore['rows'] = []
        let position = 0
        for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
          position++
          if (!line.trim())
            continue
          const native = JSON.parse(line) as unknown
          assert(native !== null && typeof native === 'object' && !Array.isArray(native), `${path}:${position}: native inventory requires a JSON object; inspect producer format`)
          rows.push({ position, text: line, native: native as Record<string, unknown> })
        }
        // Do not silently ignore new files based on Huihua's filename/root filters.
        const ids = new Set(rows.map(row => row.native.sessionId).filter(id => typeof id === 'string'))
        assert.equal(ids.size, 1, `${path}: unclassified or mixed-session JSONL; inspect native inventory`)
        stores.push({ path, id: [...ids][0] as string, rows })
      }
    }
  }
  await visit(root)
  return stores.sort((a, b) => a.path.localeCompare(b.path))
}

export function assertDiscovery(stores: NativeStore[], scan: ScanResult, expectedIds: string[]): void {
  assert.deepEqual(stores.map(store => store.id).sort(), [...expectedIds].sort(), 'producer inventory: missing/duplicate/unexpected native sessions')
  assert.deepEqual(scan.failures, [], 'Huihua scan failures')
  const expected = stores.map(store => ['claude', store.path, 'jsonl', store.id]).sort()
  const actual = scan.refs.map(ref => [ref.provider, ref.source.path, ref.source.format, ref.id]).sort()
  assert.deepEqual(actual, expected, 'Huihua discovery: missing/duplicate/unexpected session or wrong identity/path')
}

export function assertNativeRead(store: NativeStore, session: Session): void {
  const label = `${store.id} ${store.path}`
  assert.equal(session.id, store.id, `${label}: session id`)
  assert.equal(session.provider, 'claude', `${label}: session provider`)
  assert.deepEqual(session.source, { path: store.path, format: 'jsonl' }, `${label}: session source`)
  assert.equal(session.records.length, store.rows.length, `${label}: native record count (loss or duplication)`)
  for (const [i, row] of store.rows.entries()) {
    const record = session.records[i]!
    const at = `${label}:${row.position}`
    assert.equal(record.sequence, i, `${at}: record sequence`)
    assert.equal(record.provider, 'claude', `${at}: provider`)
    assert.deepEqual(record.source, { path: store.path, position: row.position }, `${at}: evidence source/line`)
    assert.equal(record.text, row.text, `${at}: raw text differs`)
    assert.deepEqual(record.native, row.native, `${at}: native field/value differs`)
  }
  for (const [i, event] of session.events.entries()) {
    assert.equal(event.sequence, i, `${label}: event sequence`)
    assert(Number.isInteger(event.record) && event.record >= 0 && event.record < store.rows.length, `${label}: dangling event.record ${event.record}`)
  }
  for (const [i, row] of store.rows.entries()) {
    const events = session.events.filter(event => event.record === i)
    const at = `${label}:${row.position}`
    assert(events.length > 0, `${at}: native record has no event or unknown report`)
    for (const event of events) {
      assert.equal(event.id, row.native.id ?? row.native.uuid, `${at}: event id`)
      const time = row.native.timestamp
      assert.deepEqual(event.timestamp, time === undefined ? undefined : { format: typeof time === 'number' ? 'unix_millis' : 'rfc3339', value: time }, `${at}: timestamp`)
      assert.equal(event.providerMetadata.native_position, row.position, `${at}: native_position`)
      for (const key of ['type', 'parentId', 'parentUuid', 'sessionId', 'ordinal', 'isSidechain', 'agentId'])
        assert.deepEqual(event.providerMetadata[key], row.native[key], `${at}: envelope ${key}`)
    }
    assertClaudeFacts(row.native, events, at)
  }
  const expectedDiagnostics = session.events.filter(event => event.type === 'unknown').map(event => ({
    code: 'PartialParse',
    message: `unrecognized native record ${event.data.sourceType}`,
    position: store.rows[event.record]!.position,
  }))
  assert.deepEqual(session.diagnostics, expectedDiagnostics, `${label}: missing/extra/misattributed diagnostics`)
  const parents = store.rows.map(row => row.native.parentSessionId).filter(value => typeof value === 'string')
  assert.equal(session.parentSessionId, parents.at(-1), `${label}: parentSessionId`)
  const titles = store.rows.filter(row => row.native.type === 'custom-title').map(row => row.native.customTitle).filter(value => typeof value === 'string')
  assert.equal(session.title, titles.at(-1), `${label}: title`)
  const times = store.rows.map(row => row.native.timestamp).filter(time => typeof time === 'string')
  assert.deepEqual(session.createdAt, times.length ? { format: 'rfc3339', value: times[0] } : undefined, `${label}: createdAt`)
  assert.deepEqual(session.updatedAt, times.length ? { format: 'rfc3339', value: times.at(-1) } : undefined, `${label}: updatedAt`)
  for (const [nativeKey, key] of [['cwd', 'path'], ['gitBranch', 'branch']] as const) {
    const values = store.rows.map(row => row.native[nativeKey]).filter(value => typeof value === 'string')
    assert.equal(session.workspace?.[key], values.at(-1), `${label}: workspace.${key}`)
  }
}

// Assertions for the exercised Claude surface, not a reusable normalization implementation.
// New private shapes require review; they are never accepted by copying the production mapper.
function assertClaudeFacts(native: Record<string, unknown>, events: readonly SessionEvent[], at: string): void {
  const message = native.message as Record<string, unknown> | undefined
  if ((native.type === 'user' || native.type === 'assistant') && message) {
    let cursor = 0
    const blocks: unknown[] = 'content' in message ? Array.isArray(message.content) ? message.content : [message.content] : []
    for (const value of blocks) {
      assert(typeof value === 'string' || (value !== null && typeof value === 'object' && !Array.isArray(value)), `${at}: unreviewed content value`)
      const block = typeof value === 'string' ? value : value as Record<string, unknown>
      const event = events[cursor++]
      assert(event, `${at}: missing content event`)
      if (typeof block === 'string' || block.type === 'text') {
        assert.equal(event.type, `${native.type}_message`, `${at}: message classification`)
        assert(event.type === 'user_message' || event.type === 'assistant_message')
        assert.deepEqual(event.data.content, [{ type: 'text', data: typeof block === 'string' ? block : block.text }], `${at}: message text`)
        if (event.type === 'assistant_message')
          assert.equal(event.data.model, message.model, `${at}: model`)
      }
      else if (block.type === 'tool_use') {
        assert(event.type === 'tool_call', `${at}: tool_call classification`)
        assert.equal(event.data.callId, block.id, `${at}: tool call id`)
        assert.equal(event.data.toolName, block.name, `${at}: tool name`)
        assert.deepEqual(event.data.arguments, block.input, `${at}: tool arguments`)
      }
      else if (block.type === 'tool_result') {
        assert(event.type === 'tool_result', `${at}: tool_result classification`)
        assert.equal(event.data.callId, block.tool_use_id, `${at}: tool result association`)
        assert.deepEqual(event.data.result, block.content, `${at}: tool result content`)
        assert.equal(event.data.isError, block.is_error === true, `${at}: tool error flag`)
      }
      else {
        assert.fail(`${at}: unreviewed content shape ${String(block.type)}; expand semantic assertions`)
      }
    }
    if (native.type === 'assistant' && 'usage' in message) {
      const event = events[cursor++]
      assert(event?.type === 'usage', `${at}: missing/misclassified usage`)
      assert.deepEqual(event.data.usage, message.usage, `${at}: usage fields`)
    }
    assert.equal(events.length, cursor, `${at}: unexpected/duplicate semantic events`)
  }
  else if (['system', 'summary', 'custom-title'].includes(String(native.type))) {
    assert.equal(events.length, 1, `${at}: system event count`)
    const event = events[0]!
    assert(event.type === 'system', `${at}: system classification`)
    assert.deepEqual(event.data.payload, native, `${at}: system payload`)
  }
  else {
    assert.equal(events.length, 1, `${at}: unknown event count`)
    const event = events[0]!
    assert(event.type === 'unknown', `${at}: unreviewed native type ${String(native.type)}`)
    assert.equal(event.data.sourceType, native.type, `${at}: unknown sourceType`)
    assert.deepEqual(event.data.payload, native, `${at}: unknown evidence`)
  }
}

async function main(): Promise<void> {
  // Test infrastructure only: the production library never executes a producer.
  const simulatorDir = resolve(required('SIMULATOR_DIR'))
  const claude = resolve(required('PRODUCER_BIN'))
  const root = await mkdtemp(join(tmpdir(), 'huihua-producer-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const config = join(home, '.claude')
  await Promise.all([home, workspace, config].map(async path => mkdir(path, { recursive: true })))
  const port = Number(process.env.SIMULATOR_PORT ?? 18887)
  assert(Number.isSafeInteger(port) && port > 1024 && port < 65535)
  const base = `http://127.0.0.1:${port}`
  const control = `http://127.0.0.1:${port + 1}/_simulator`
  const simulator = startSimulator(simulatorDir, port)
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
  const progress: CompatibilityProgress = { stage, completed: [] }
  try {
    await simulator.ready()
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
    progress.auditedSessions = stores.length
    progress.auditedRecords = stores.reduce((sum, store) => sum + store.rows.length, 0)
    stage = 'scan'
    const scan = await sessions.scan({ providers: ['claude'], homeDir: home })
    assertDiscovery(stores, scan, [sessionId, secondSessionId])
    progress.completed.push('scan')
    stage = 'read'
    for (const kind of ['read', 'snapshot', 'records', 'events']) {
      stage = kind
      for (const store of stores) {
        const discovered = scan.refs.find(ref => ref.source.path === store.path)!
        const read = await sessions.read(discovered)
        const handle = await sessions.open(discovered)
        if (kind === 'read')
          assertNativeRead(store, read)
        if (kind === 'snapshot')
          assertNativeRead(store, await handle.snapshot())
        if (kind === 'records') {
          const records = []
          for await (const record of handle.records()) records.push(record)
          assertNativeRead(store, { ...read, records })
        }
        if (kind === 'events') {
          const events = []
          for await (const event of handle.events()) events.push(event)
          assertNativeRead(store, { ...read, events })
        }
      }
      progress.completed.push(kind)
    }
    stage = 'scenario'
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
    progress.completed.push('scenario')
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
    stage = 'baseline'
    const baseline = JSON.parse(await readFile(new URL('./baselines/claude.json', import.meta.url), 'utf8')) as DriftSummary
    assertNoProducerDrift(report, baseline)
    assert.equal(session.diagnostics.length, Object.values(unknown).reduce((sum, count) => sum + count, 0), 'unexpected diagnostics beyond known unknown records')
    assert(session.diagnostics.every(diagnostic => diagnostic.code === 'PartialParse' && diagnostic.message.startsWith('unrecognized native record ')))
    progress.completed.push('baseline')
    stage = 'passed'
    console.log(JSON.stringify({ stage: 'passed', report: output, artifacts: root, unknown, structured }))
  }
  catch (error) {
    progress.error = String(error)
    if (error instanceof NativeDriftError)
      progress.drift = error.drift
    await writeFile(`${output}.failure.json`, JSON.stringify({ stage, artifacts: root, error: String(error) }, null, 2))
    console.error(JSON.stringify({ stage, artifacts: root, error: String(error) }))
    process.exitCode = 1
  }
  finally {
    await simulator.stop(join(root, 'simulator.log'))
    progress.stage = stage
    await writeFile(`${output}.progress.json`, JSON.stringify(progress, null, 2))
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
}

if (import.meta.main)
  await main()
