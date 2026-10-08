import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'

import type { Session } from '../../src/index.ts'
import { sessions } from '../../src/index.ts'
import type { CompatibilityProgress } from './report.ts'
import type { DriftSummary, NativeStore } from './runtime.ts'
import { assertNoProducerDrift, json, NativeDriftError, nativeFieldPaths, required, startSimulator } from './runtime.ts'

export function assertCodexRead(store: NativeStore, session: Session): void {
  assert.equal(session.id, store.id)
  assert.equal(session.records.length, store.rows.length, 'Codex raw record count')
  for (const [index, row] of store.rows.entries()) {
    const at = `${store.path}:${row.position}`
    const record = session.records[index]!
    assert.equal(record.sequence, index, at)
    assert.equal(record.source.position, row.position, at)
    assert.equal(record.source.path, store.path, at)
    assert.equal(record.text, row.text, at)
    assert.deepEqual(record.native, row.native, at)
    const events = session.events.filter(event => event.record === index)
    assert(events.length > 0, `${at}: native row has no event`)
    const p = row.native.payload as Record<string, unknown>
    if (row.native.type === 'response_item' && p.type === 'message' && (p.role === 'assistant' || p.role === 'user')) {
      assert(Array.isArray(p.content), `${at}: unreviewed content shape`)
      const expected = (p.content as { text: string }[]).map(part => part.text)
      const actual = events.flatMap(event => event.type === `${String(p.role)}_message` && (event.type === 'assistant_message' || event.type === 'user_message') ? event.data.content.map(block => block.data) : [])
      assert.deepEqual(actual, expected, `${at}: text lost or duplicated`)
    }
    if (row.native.type === 'response_item' && p.type === 'function_call') {
      assert.equal(events.length, 1, at)
      const event = events[0]!
      assert(event.type === 'tool_call', `${at}: missing tool call`)
      assert.equal(event.data.callId, p.call_id, at)
      assert.equal(event.data.toolName, p.name, at)
      assert.deepEqual(event.data.arguments, JSON.parse(String(p.arguments)), at)
    }
    if (row.native.type === 'response_item' && p.type === 'function_call_output') {
      assert.equal(events.length, 1, at)
      const event = events[0]!
      assert(event.type === 'tool_result', `${at}: missing tool result`)
      assert.equal(event.data.callId, p.call_id, at)
      assert.deepEqual(event.data.result, p.output, at)
    }
    if (row.native.type === 'token_usage_record' || (row.native.type === 'event_msg' && p.type === 'token_count')) {
      assert.equal(events.length, 1, at)
      const event = events[0]!
      assert(event.type === 'usage', `${at}: missing usage`)
      assert.deepEqual(event.data.usage, p, `${at}: native usage changed`)
    }
    for (const event of events) {
      if (event.type === 'unknown') {
        assert.deepEqual(event.data.payload, row.native.type === 'event_msg' ? p : row.native, `${at}: unknown evidence changed`)
      }
    }
  }
  for (const [index, event] of session.events.entries()) {
    assert.equal(event.sequence, index)
    assert(event.record >= 0 && event.record < store.rows.length)
    assert.deepEqual(event.timestamp, { format: 'rfc3339', value: store.rows[event.record]!.native.timestamp })
  }
}

export function assertCodexScenario(store: NativeStore, session: Session): void {
  const payloads = store.rows.filter(row => row.native.type === 'response_item').map(row => row.native.payload as Record<string, unknown>)
  const replies = payloads.filter(p => p.type === 'message' && p.role === 'assistant').flatMap(p => (p.content as { text: string }[]).map(part => part.text))
  assert.deepEqual(replies, ['HUIHUA_CODEX_REPLY', 'HUIHUA_CODEX_RESUMED'], 'Codex first/resumed native replies')
  const call = payloads.find(p => p.type === 'function_call' && p.call_id === 'huihua_codex_read')
  const result = payloads.find(p => p.type === 'function_call_output' && p.call_id === 'huihua_codex_read')
  assert(call && result, 'Codex must persist the tool roundtrip')
  assert(JSON.stringify(result.output).includes('HUIHUA_CODEX_TOOL_RESULT'), 'Codex tool must read the synthetic file successfully')
  assert(payloads.indexOf(call) < payloads.indexOf(result), 'tool result precedes call')
  assert(session.events.some(event => event.type === 'usage'), 'Codex usage not exposed')
}
async function main(): Promise<void> {
  const simulatorDir = resolve(required('SIMULATOR_DIR'))
  const codex = resolve(required('PRODUCER_BIN'))
  const root = await mkdtemp(join(process.env.RUNNER_TEMP ?? process.cwd(), 'huihua-codex-'))
  const home = join(root, 'home')
  const config = join(home, '.codex')
  const workspace = join(root, 'workspace')
  await mkdir(config, { recursive: true })
  await mkdir(workspace)
  const port = Number(process.env.SIMULATOR_PORT ?? 18891)
  assert(Number.isSafeInteger(port) && port > 1024 && port < 65535)
  const unsandboxed = process.env.GITHUB_ACTIONS === 'true' && process.env.CODEX_COMPAT_UNSANDBOXED === '1'
  const base = `http://127.0.0.1:${port}`
  const control = `http://127.0.0.1:${port + 1}/_simulator`
  await writeFile(join(config, 'config.toml'), `model = "gpt-5.4"
  model_provider = "simulator"
  approval_policy = "never"
  sandbox_mode = "${unsandboxed ? 'danger-full-access' : 'workspace-write'}"
  [model_providers.simulator]
  name = "Loopback simulator"
  base_url = "${base}/v1"
  wire_api = "responses"
  requires_openai_auth = false
  env_key = "OPENAI_API_KEY"
  request_max_retries = 0
  stream_max_retries = 0
  `)
  await writeFile(join(workspace, 'synthetic.txt'), 'HUIHUA_CODEX_TOOL_RESULT\n')
  const simulator = startSimulator(simulatorDir, port)
  const output = resolve(process.env.COMPAT_REPORT ?? 'codex-compat-report.json')
  const progress: CompatibilityProgress = { stage: 'simulator-startup', completed: [] }
  try {
    await simulator.ready()
    progress.stage = 'producer'
    const template = await openaiJson(`${base}/v1/responses`, { model: 'gpt-5.4', input: 'synthetic template' })
    await json(`${control}/reset`, {})
    const tool = { id: 'item_codex_read', type: 'function_call', call_id: 'huihua_codex_read', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat synthetic.txt', yield_time_ms: 1000, max_output_tokens: 1000 }), status: 'completed' }
    const message = (id: string, text: string) => ({ id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [], logprobs: [] }] })
    await json(`${control}/enqueue`, { provider: 'openai', exchanges: [
      responseExchange('first', 'HUIHUA_CODEX_FIRST', tool, template),
      responseExchange('tool-result', 'HUIHUA_CODEX_TOOL_RESULT', message('msg_codex_first', 'HUIHUA_CODEX_REPLY'), template),
    ] })
    await runCodex(['exec', '--skip-git-repo-check', '--json', 'HUIHUA_CODEX_FIRST'], 'first')
    await json(`${control}/enqueue`, { provider: 'openai', exchanges: [responseExchange('resume', 'HUIHUA_CODEX_RESUME', message('msg_codex_resume', 'HUIHUA_CODEX_RESUMED'), template)] })
    await runCodex(['exec', 'resume', '--last', '--skip-git-repo-check', '--json', 'HUIHUA_CODEX_RESUME'], 'resume')
    await writeFile(join(root, 'ledger.json'), JSON.stringify(await json(`${control}/requests`), null, 2))
    progress.stage = 'native-inventory'
    const wires = await findWires(join(config, 'sessions'))
    assert.equal(wires.length, 1, 'resume must retain one independently inventoried Codex rollout')
    const path = wires[0]!
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))
    const rows: NativeStore['rows'] = []
    let position = 0
    for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      position++
      if (!line.trim())
        continue
      rows.push({ position, text: line, native: JSON.parse(line) as Record<string, unknown> })
    }
    const meta = rows.find(row => row.native.type === 'session_meta')?.native.payload as { id?: string } | undefined
    assert.equal(typeof meta?.id, 'string')
    const store: NativeStore = { path, id: meta!.id!, rows }
    progress.auditedSessions = wires.length
    progress.auditedRecords = rows.length
    await writeFile(join(root, 'native-inventory.json'), JSON.stringify(store, null, 2))
    progress.stage = 'scan'
    const scan = await sessions.scan({ providers: ['codex'], homeDir: home })
    await writeFile(join(root, 'scan.json'), JSON.stringify(scan, null, 2))
    assert.deepEqual(scan.failures, [])
    assert.deepEqual(scan.refs.map(ref => [ref.id, ref.provider, ref.source.path, ref.source.format]), [[store.id, 'codex', path, 'jsonl']])
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
      assertCodexRead(store, session)
      progress.completed.push(kind)
    }
    progress.stage = 'scenario'
    const session = await sessions.read(ref)
    assertCodexScenario(store, session)
    progress.completed.push('scenario')
    progress.stage = 'baseline'
    const unknown: Record<string, number> = {}
    for (const event of session.events) {
      if (event.type === 'unknown')
        unknown[event.data.sourceType] = (unknown[event.data.sourceType] ?? 0) + 1
    }
    const structured = session.events.flatMap(event => event.type === 'assistant_message' || event.type === 'user_message' ? event.data.content : []).filter(block => block.type === 'structured').length
    const report = { unknown, structured, fieldPaths: nativeFieldPaths([store], false), groupedFieldPaths: nativeFieldPaths([store]), diagnostics: session.diagnostics }
    await writeFile(join(root, 'drift-report.json'), JSON.stringify(report, null, 2))
    const baseline = JSON.parse(await readFile(new URL('./baselines/codex.json', import.meta.url), 'utf8')) as DriftSummary & { diagnosticCodes: string[] }
    assertNoProducerDrift(report, baseline)
    assert.deepEqual(session.diagnostics.map(diagnostic => diagnostic.code).sort(), baseline.diagnosticCodes)
    progress.completed.push('baseline')
    progress.stage = 'passed'
  }
  catch (error) {
    progress.error = String(error)
    if (error instanceof NativeDriftError)
      progress.drift = error.drift
    await writeFile(`${output}.failure.json`, JSON.stringify({ ...progress, artifacts: root }, null, 2))
    console.error(progress.error)
    process.exitCode = 1
  }
  finally {
    await simulator.stop(join(root, 'simulator.log'))
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
      else if (entry.isFile() && path.endsWith('.jsonl'))
        result.push(path)
    }
    return result.sort()
  }

  async function runCodex(args: string[], label: string): Promise<void> {
    try {
      const stdout = execFileSync(codex, args, { cwd: workspace, env: { PATH: process.env.PATH ?? '', HOME: home, CODEX_HOME: config, OPENAI_API_KEY: 'synthetic-test-key' }, timeout: 60000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      await writeFile(join(root, `${label}.jsonl`), stdout)
    }
    catch (error) {
      if (error !== null && typeof error === 'object' && 'stderr' in error)
        await writeFile(join(root, `${label}.stderr`), String(error.stderr))
      throw error
    }
  }

  async function openaiJson(url: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': 'Bearer synthetic-test-key' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
    assert(response.ok, await response.clone().text())
    return await response.json() as Record<string, unknown>
  }
  function responseExchange(label: string, marker: string, item: Record<string, unknown>, template: Record<string, unknown>) {
    const response = { ...template, id: `resp_${label}`, output: [item] }
    return { label, request: { method: 'POST', path: '/v1/responses', bodyTextIncludes: [marker] }, response: { kind: 'stream', steps: [
      { kind: 'event', event: { type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } } },
      { kind: 'event', event: { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : { arguments: '' }) } } },
      { kind: 'event', event: { type: 'response.output_item.done', sequence_number: 2, output_index: 0, item } },
      { kind: 'event', event: { type: 'response.completed', sequence_number: 3, response } },
      { kind: 'close' },
    ] } }
  }
}

if (import.meta.main)
  await main()
