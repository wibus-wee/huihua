import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { Session } from '../src/index.ts'
import { sessions } from '../src/index.ts'
import { activeProviders, manifest, selectProviders } from '../tools/producer-compat/catalog.ts'
import { assertDiscovery, assertNativeRead, assertSubagentScenario, inventoryNativeStores } from '../tools/producer-compat/claude.ts'
import { assertCodexBaseline, assertCodexRead, assertCodexScenario } from '../tools/producer-compat/codex.ts'
import { assertKimiFacts, assertKimiReplies } from '../tools/producer-compat/kimi.ts'
import { inventoryStore, nativeDriftSummary } from '../tools/producer-compat/native.ts'
import { laneResult, renderCompatibilitySummary, renderDailyReport } from '../tools/producer-compat/report.ts'
import type { DriftSummary } from '../tools/producer-compat/runtime.ts'
import { assertNoProducerDrift, assertSimulatorRequests, json, NativeDriftError, nativeFieldPaths, startSimulator } from '../tools/producer-compat/runtime.ts'

await test('test launcher disables automatic model replies and checks unconsumed exchanges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'huihua-simulator-launch-'))
  await mkdir(join(directory, 'src'))
  await mkdir(join(directory, 'node_modules/tsx/dist'), { recursive: true })
  await writeFile(join(directory, 'node_modules/tsx/dist/loader.mjs'), '')
  // Stub only the external package's public lifecycle API; no model/schema/parser fake.
  await writeFile(join(directory, 'src/index.ts'), `
    import assert from 'node:assert/strict'
    export async function startModelApiSimulator(options) {
      assert.equal(options.autoRespond, false)
      let pending = 0
      return {
        controller: {
          enqueue() { pending++ }, reset() { pending = 0 }, requests() { return [] },
          assertExhausted() { assert.equal(pending, 0, 'unconsumed exchange') }
        }, close: async () => {}
      }
    }
  `)
  const port = 19731
  const simulator = startSimulator(directory, port)
  try {
    await simulator.ready()
    await simulator.assertExhausted()
    await json(`http://127.0.0.1:${port + 1}/_simulator/enqueue`, {})
    await assert.rejects(simulator.assertExhausted(), /unconsumed exchange/)
    await json(`http://127.0.0.1:${port + 1}/_simulator/reset`, {})
    await simulator.assertExhausted()
  }
  finally {
    await simulator.stop(join(directory, 'simulator.log'))
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'ledger.json'), 'utf8')), { requests: [] })
    await rm(directory, { recursive: true, force: true })
  }
})

await test('model request ledger rejects extra, missing, reordered and wrong-protocol turns', () => {
  const plan = [{ path: '/v1/messages', marker: 'first' }, { path: '/v1/messages', marker: 'resumed' }]
  const requests = plan.map(({ path, marker }) => ({ method: 'POST', path, body: { stream: true, messages: [{ role: 'user', content: marker }] } }))
  assertSimulatorRequests({ requests }, plan)
  assert.throws(() => assertSimulatorRequests({ requests: requests.slice(1) }, plan), /model requests/)
  assert.throws(() => assertSimulatorRequests({ requests: [...requests, requests[0]!] }, plan), /model requests/)
  assert.throws(() => assertSimulatorRequests({ requests: [...requests].reverse() }, plan), /marker/)
  assert.throws(() => assertSimulatorRequests({ requests: requests.map(request => ({ ...request, path: '/v1/responses' })) }, plan), /protocol/)
  assert.throws(() => assertSimulatorRequests({ requests: requests.map(request => ({ ...request, body: { ...request.body, stream: false } })) }, plan), /streaming/)
  assert.throws(() => assertSimulatorRequests({ requests: [...requests, { method: 'GET', path: '/unreviewed-endpoint' }] }, plan), /auxiliary/)
  const metadata = { method: 'POST', path: '/v1/chat/completions', body: { messages: [{ role: 'system', content: 'You name chat sessions' }, { role: 'user', content: 'first' }] } }
  const metadataPlan = [...plan, { path: metadata.path, marker: 'first', stream: false, bodyIncludes: 'You name chat sessions' }]
  assertSimulatorRequests({ requests: [...requests, metadata] }, metadataPlan)
  assert.throws(() => assertSimulatorRequests({ requests: [...requests, { ...metadata, body: { ...metadata.body, stream: true } }] }, metadataPlan), /streaming/)
  assert.throws(() => assertSimulatorRequests({ requests: [...requests, { ...metadata, body: { messages: [{ role: 'user', content: 'first' }] } }] }, metadataPlan), /purpose/)
})

await test('shared live audit rejects user, usage and envelope loss with native records intact', async () => {
  const home = await mkdtemp(join(tmpdir(), 'huihua-live-facts-'))
  try {
    const directory = join(home, '.pi/agent/sessions/synthetic')
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'session.jsonl')
    const rows = [
      { type: 'session', version: 3, id: 'native', timestamp: '2026-01-01T00:00:00Z', cwd: '/synthetic' },
      { type: 'message', id: 'user', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'HUIHUA_PI_FIRST' }] } },
      { type: 'message', id: 'assistant', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', model: 'native-model', content: [{ type: 'text', text: 'HUIHUA_PI_REPLY' }], usage: { input: 3, output: 2, nested: { future: 7 } } } },
    ]
    await writeFile(path, rows.map(row => `${JSON.stringify(row)}\n`).join(''))
    const inventory = await inventoryStore('pi', home)
    const scan = await sessions.scan({ providers: ['pi'], homeDir: home })
    const session = await sessions.read(scan.refs[0]!)
    inventory.assertRecords(session)
    const baseline = nativeDriftSummary('pi', rows, session)
    for (const mutate of [
      (native: Record<string, unknown>) => {
        native.speaker = native.role
        delete native.role
      },
      (native: Record<string, unknown>) => { native.content = { text: 'HUIHUA_PI_FIRST' } },
      (native: Record<string, unknown>) => { native.content = [{ type: 'text', text: 123 }] },
    ]) {
      const changed = structuredClone(rows)
      mutate(changed[1]!.message!)
      assert.throws(() => assertNoProducerDrift(nativeDriftSummary('pi', changed, session), baseline), NativeDriftError, 'native field rename/nesting/type changes must not silently pass')
    }
    for (const type of ['user_message', 'usage'])
      assert.throws(() => inventory.assertRecords({ ...session, events: session.events.filter(event => event.type !== type) }), /./, type)
    assert.throws(() => inventory.assertRecords({ ...session, events: session.events.map(({ timestamp: _time, ...event }) => event) }), /./, 'timestamp')
    assert.throws(() => inventory.assertRecords({ ...session, id: 'foreign' }), /./, 'identity')
    const mutations: [string, (input: Session) => Session][] = [
      ['usage payload', input => ({ ...input, events: input.events.map(event => event.type === 'usage' ? { ...event, data: { usage: {} } } : event) })],
      ['usage association', input => ({ ...input, events: input.events.map(event => event.type === 'usage' ? { ...event, record: 1 } : event) })],
      ['assistant model', input => ({ ...input, events: input.events.map(event => event.type === 'assistant_message' ? { ...event, data: { ...event.data, model: 'foreign' } } : event) })],
      ['raw bytes', input => ({ ...input, records: input.records.map(record => ({ ...record, text: '{}' })) })],
      ['physical line', input => ({ ...input, records: input.records.map(record => ({ ...record, source: { ...record.source, position: 0 } })) })],
      ['workspace', input => ({ ...input, workspace: { path: 'foreign' } })],
      ['parent', input => ({ ...input, parentSessionId: 'foreign' })],
      ['diagnostics', input => ({ ...input, diagnostics: [{ code: 'PartialParse', message: 'unreviewed' }] })],
    ]
    for (const [name, mutate] of mutations)
      assert.throws(() => inventory.assertRecords(mutate(session)), /./, name)
    // A changed input field can fool an oracle that derives expected roles from that same field.
    const renamed = structuredClone(rows) as Record<string, unknown>[]
    const user = renamed[1]!.message as Record<string, unknown>
    user.speaker = user.role
    delete user.role
    await writeFile(path, renamed.map(row => `${JSON.stringify(row)}\n`).join(''))
    const changedInventory = await inventoryStore('pi', home)
    const changedSession = await sessions.read(scan.refs[0]!)
    changedInventory.assertRecords(changedSession)
    assert.equal(changedSession.events.filter(event => event.type === 'user_message').length, 0)
    assert.throws(() => assertNoProducerDrift(nativeDriftSummary('pi', renamed, changedSession), baseline), NativeDriftError)
  }
  finally { await rm(home, { recursive: true, force: true }) }
})

await test('independent native inventory detects omissions hidden by the old summary', async () => {
  const home = await mkdtemp(join(tmpdir(), 'huihua-audit-test-'))
  try {
    const directory = join(home, '.claude', 'projects', 'test')
    await mkdir(directory, { recursive: true })
    const row = { type: 'user', sessionId: 'one', uuid: 'repeated', timestamp: '2026-01-01T00:00:00Z', cwd: '/synthetic', message: { content: 'same' }, newField: { retained: 1 } }
    const path = join(directory, 'one.jsonl')
    // Repeated IDs and a blank physical line must not erase evidence or change line numbers.
    await writeFile(path, `${JSON.stringify(row)}\n\n${JSON.stringify(row)}\n`)
    const stores = await inventoryNativeStores(home)
    const scan = await sessions.scan({ providers: ['claude'], homeDir: home })
    assertDiscovery(stores, scan, ['one'])
    const session = await sessions.read(scan.refs[0]!)
    assertNativeRead(stores[0]!, session)
    const summary = { unknown: {}, structured: 0, fieldPaths: nativeFieldPaths(stores, false) }
    // Reproduction: deleting a same-shape row leaves the old verdict unchanged.
    const dropped = [{ ...stores[0]!, rows: stores[0]!.rows.slice(1) }]
    assertNoProducerDrift({ ...summary, fieldPaths: nativeFieldPaths(dropped, false) }, summary)
    const mutations: [string, (input: Session) => Session][] = [
      ['drop record', input => ({ ...input, records: input.records.slice(1) })],
      ['duplicate record', input => ({ ...input, records: [...input.records, input.records[0]!] })],
      ['drop field', input => ({ ...input, records: input.records.map((record, i) => i ? record : { ...record, native: { ...row, newField: undefined } }) })],
      ['raw text', input => ({ ...input, records: input.records.map(record => ({ ...record, text: '{}' })) })],
      ['wrong line', input => ({ ...input, records: input.records.map(record => ({ ...record, source: { ...record.source, position: 1 } })) })],
      ['drop event', input => ({ ...input, events: input.events.slice(1) })],
      ['wrong association', input => ({ ...input, events: input.events.map(event => ({ ...event, record: 0 })) })],
      ['wrong time', input => ({ ...input, events: input.events.map(event => ({ ...event, timestamp: { format: 'rfc3339' as const, value: 'wrong' } })) })],
      ['wrong identity', input => ({ ...input, id: 'other' })],
    ]
    for (const [name, mutate] of mutations)
      assert.throws(() => assertNativeRead(stores[0]!, mutate(session)), /./, name)
    assert.throws(() => assertDiscovery(stores, { ...scan, refs: [] }, ['one']), /discovery/)
    assert.throws(() => assertDiscovery(stores, { ...scan, refs: [...scan.refs, ...scan.refs] }, ['one']), /discovery/)
    assert.throws(() => assertDiscovery(stores, { ...scan, refs: scan.refs.map(ref => ({ ...ref, id: 'wrong' })) }, ['one']), /discovery/)
    assert.throws(() => assertDiscovery(stores, scan, ['one', 'missing']), /producer inventory/)
    await writeFile(join(directory, 'new.jsonl'), '{"new_private_store":true}\n')
    await assert.rejects(inventoryNativeStores(home), /unclassified/)
  }
  finally { await rm(home, { recursive: true, force: true }) }
})

await test('same-record semantic checks reject loss even when raw evidence is intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-audit-facts-'))
  try {
    const path = join(root, 'facts.jsonl')
    const native = [
      { type: 'assistant', sessionId: 'facts', uuid: 'call', message: { model: 'synthetic', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: '/synthetic' } }], usage: { input_tokens: 3, nested: { future: 7 } } } },
      { type: 'user', sessionId: 'facts', uuid: 'result', parentUuid: 'call', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'exact result', is_error: false }] } },
      { type: 'assistant', sessionId: 'facts', message: { content: [{ type: 'text', text: 'exact text' }], model: 'synthetic' } },
      { type: 'future_private', sessionId: 'facts', payload: { value: 1 } },
    ]
    await writeFile(path, native.map(row => JSON.stringify(row)).join('\n'))
    const stores = await inventoryNativeStores(root)
    const scan = await sessions.scan({ providers: ['claude'], roots: { claude: [root] } })
    const session = await sessions.read(scan.refs[0]!)
    assertNativeRead(stores[0]!, session)
    for (const type of ['tool_call', 'tool_result', 'assistant_message', 'usage', 'unknown']) {
      const modified = { ...session, events: session.events.map(event => event.type === type ? { ...event, data: {} } : event) } as Session
      assert.throws(() => assertNativeRead(stores[0]!, modified), /./, type)
    }
    const swapped = { ...session, records: [session.records[1]!, session.records[0]!, ...session.records.slice(2)] }
    assert.throws(() => assertNativeRead(stores[0]!, swapped))
    const altered = structuredClone(stores)
    altered[0]!.rows[0]!.native.extra = 1
    altered[0]!.rows[1]!.native.extra = 'one'
    const changed = structuredClone(altered)
    changed[0]!.rows[0]!.native.extra = 'one'
    changed[0]!.rows[1]!.native.extra = 1
    assert.deepEqual(nativeFieldPaths(altered, false), nativeFieldPaths(changed, false))
    assert.notDeepEqual(nativeFieldPaths(altered), nativeFieldPaths(changed))
    assert.throws(() => assertNoProducerDrift(
      { unknown: {}, structured: 0, fieldPaths: [], groupedFieldPaths: nativeFieldPaths(changed) },
      { unknown: {}, structured: 0, fieldPaths: [], groupedFieldPaths: nativeFieldPaths(altered) },
    ), /per-record-type/)
    assert.throws(() => assertNativeRead(stores[0]!, { ...session, diagnostics: [] }), /diagnostics/)
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

await test('Claude native audit distinguishes parent and child identity and checks companion evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-audit-subagents-'))
  try {
    const path = join(root, 'parent', 'subagents', 'agent-child.jsonl')
    const companion = path.replace('.jsonl', '.meta.json')
    await mkdir(join(root, 'parent', 'subagents'), { recursive: true })
    const metadata = { agentType: 'general-purpose', description: 'Synthetic child', toolUseId: 'spawn', spawnDepth: 1, requestShape: 'foreground', requestNonInteractive: true }
    await writeFile(companion, JSON.stringify(metadata))
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'child-user', sessionId: 'parent', agentId: 'child', isSidechain: true, message: { content: 'task' } })}\n`)
    const stores = await inventoryNativeStores(root)
    assert.equal(stores[0]!.id, 'child')
    const scan = await sessions.scan({ providers: ['claude'], roots: { claude: [root] } })
    assertDiscovery(stores, scan, ['child'])
    const session = await sessions.read(scan.refs[0]!)
    assertNativeRead(stores[0]!, session)
    assert.throws(() => assertNativeRead(stores[0]!, { ...session, id: 'parent' }), /session id/)
    assert.throws(() => assertNativeRead(stores[0]!, { ...session, parentSessionId: 'foreign' }), /parentSessionId/)
    assert.throws(() => assertNativeRead(stores[0]!, { ...session, metadata: { ...session.metadata, subagent: {} } }), /companion/)
    assert.throws(() => assertNativeRead(stores[0]!, { ...session, records: session.records.slice(1) }), /record count/)
    const wrongSource = { ...session, records: session.records.map((record, index) => index ? record : { ...record, source: { path: 'wrong' } }) }
    assert.throws(() => assertNativeRead(stores[0]!, wrongSource), /source/)
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

await test('Claude subagent journey rejects absent children and broken native spawn references', () => {
  type Stores = Awaited<ReturnType<typeof inventoryNativeStores>>
  const rows = (native: Record<string, unknown>[]) => native.map((value, index) => ({ native: value, text: JSON.stringify(value), position: index + 1 }))
  const stores: Stores = [{ path: '/synthetic/parent.jsonl', id: 'parent', rows: [] }]
  for (const [index, ordinal] of ['FIRST', 'SECOND'].entries()) {
    const id = `child-${index}`
    const callId = `huihua_spawn_${index + 1}`
    const description = `${index === 0 ? 'First' : 'Second'} synthetic compatibility child`
    const prompt = `HUIHUA_CHILD_${ordinal}`
    const reply = `${prompt}_REPLY`
    stores[0]!.rows.push(...rows([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: callId, name: 'Agent', input: { description, prompt, subagent_type: 'general-purpose', run_in_background: false } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: callId, content: reply }] }, toolUseResult: { agentId: id, status: 'completed' } },
    ]))
    stores.push({ path: `/synthetic/parent/subagents/agent-${id}.jsonl`, id, parentSessionId: 'parent', rows: rows([
      { type: 'user', message: { content: prompt } },
      { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } },
    ]), companion: { path: `/synthetic/parent/subagents/agent-${id}.meta.json`, text: '', native: { agentType: 'general-purpose', description, toolUseId: callId, spawnDepth: 1, requestShape: 'foreground', requestNonInteractive: true } } })
  }
  stores[0]!.rows.push(...rows([{ type: 'assistant', message: { content: 'HUIHUA_SUBAGENTS_COMPLETE' } }]))
  assert.deepEqual(assertSubagentScenario(stores, 'parent'), ['child-0', 'child-1'])
  const mutations: [string, (input: Stores) => void][] = [
    ['missing child', input => input.pop()],
    ['colliding identity', (input) => { input[1]!.id = 'parent' }],
    ['wrong parent', (input) => { input[1]!.parentSessionId = 'foreign' }],
    ['missing companion', (input) => { delete input[1]!.companion }],
    ['wrong spawn reference', (input) => { input[1]!.companion!.native.toolUseId = 'foreign' }],
    ['missing child reply', (input) => { input[1]!.rows.pop() }],
    ['missing parent call', (input) => { input[0]!.rows.shift() }],
    ['failed tool result', (input) => { input[0]!.rows[1]!.native.message = { content: [{ type: 'tool_result', tool_use_id: 'huihua_spawn_1', content: 'HUIHUA_CHILD_FIRST_REPLY', is_error: true }] } }],
    ['wrong result agent', (input) => { input[0]!.rows[1]!.native.toolUseResult = { agentId: 'foreign', status: 'completed' } }],
    ['swapped sibling results', (input) => {
      input[0]!.rows[1]!.native.toolUseResult = { agentId: 'child-1', status: 'completed' }
      input[0]!.rows[3]!.native.toolUseResult = { agentId: 'child-0', status: 'completed' }
    }],
    ['unfinished agent', (input) => { input[0]!.rows[1]!.native.toolUseResult = { agentId: 'child-0', status: 'running' } }],
  ]
  for (const [name, mutate] of mutations) {
    const copy = structuredClone(stores)
    mutate(copy)
    assert.throws(() => assertSubagentScenario(copy, 'parent'), /subagent scenario/, name)
  }
})

await test('Kimi native facts reject missing user messages, usage mirrors and broken associations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'huihua-kimi-facts-'))
  try {
    const path = join(directory, 'agents/main/wire.jsonl')
    await mkdir(join(directory, 'agents/main'), { recursive: true })
    const state = { id: 'native', createdAt: 1000, updatedAt: 2000, agents: {} }
    const rows = [
      { type: 'metadata', protocol_version: '1.5', time: 1000 },
      { type: 'context.append_message', time: 1100, message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] } },
      { type: 'usage.record', time: 1200, usage: { inputOther: 3, output: 2 } },
      { type: 'context.append_loop_event', time: 1300, event: { type: 'content.part', part: { type: 'text', text: 'reply' } } },
      { type: 'context.append_loop_event', time: 1400, event: { type: 'step.end', usage: { inputOther: 3, output: 2 } } },
    ]
    await writeFile(join(directory, 'state.json'), JSON.stringify(state))
    await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n'))
    const scan = await sessions.scan({ providers: ['kimi'], roots: { kimi: [directory] } })
    const session = await sessions.read(scan.refs[0]!)
    assertKimiFacts(rows, state, session)
    for (const type of ['user_message', 'usage'])
      assert.throws(() => assertKimiFacts(rows, state, { ...session, events: session.events.filter(event => event.type !== type) }), /./, type)
    const usage = session.events.find(event => event.type === 'usage')!
    assert.throws(() => assertKimiFacts(rows, state, { ...session, events: [...session.events, { ...usage, sequence: session.events.length, record: 5, timestamp: { format: 'unix_millis', value: 1400 } }] }), /usage/)
    assert.throws(() => assertKimiFacts(rows, state, { ...session, events: session.events.map(event => ({ ...event, timestamp: { format: 'unix_millis' as const, value: 0 } })) }), /time/)
  }
  finally { await rm(directory, { recursive: true, force: true }) }
})

await test('Kimi native reply oracle rejects missing, duplicated and changed assistant content', async () => {
  const messages = ['HUIHUA_KIMI_REPLY', 'HUIHUA_KIMI_RESUMED'].map(text => ({ role: 'assistant', content: [{ type: 'text', text }] }))
  const rows = messages.map(message => ({ type: 'agent.message.appended', message: { message } }))
  // Obtain a valid output shape with the older supported record vocabulary.
  const session = await sessions.parse('kimi', { jsonl: messages.map(message => JSON.stringify({ type: 'context.append_message', message })).join('\n') })
  assertKimiReplies(rows, session.events)
  assert.throws(() => assertKimiReplies(rows, []), /assistant replies/)
  assert.throws(() => assertKimiReplies(rows, session.events.slice(1)), /assistant replies/)
  assert.throws(() => assertKimiReplies(rows, [...session.events, ...session.events]), /assistant replies/)
  assert.throws(() => assertKimiReplies(rows, [...session.events].reverse()), /assistant replies/)
  assert.throws(() => assertKimiReplies([], session.events), /must persist/)
})

await test('Codex audit catches raw loss, missing replies and tool association errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'huihua-codex-audit-'))
  try {
    const path = join(directory, 'rollout.jsonl')
    const timestamp = '2026-01-01T00:00:00Z'
    const native = [
      { type: 'session_meta', timestamp, payload: { id: 'codex-test', cwd: directory } },
      { type: 'response_item', timestamp, payload: { type: 'function_call', call_id: 'huihua_codex_read', name: 'exec_command', arguments: '{"cmd":"cat synthetic.txt"}' } },
      { type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: 'huihua_codex_read', output: 'HUIHUA_CODEX_TOOL_RESULT' } },
      ...['HUIHUA_CODEX_REPLY', 'HUIHUA_CODEX_RESUMED'].map(text => ({ type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })),
      { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1, output_tokens: 2 } } } },
    ]
    const rows = native.map((value, index) => ({ native: value, text: `${JSON.stringify(value)}\n`, position: index + 1 }))
    await writeFile(path, rows.map(row => row.text).join(''))
    const scan = await sessions.scan({ providers: ['codex'], roots: { codex: [directory] } })
    const session = await sessions.read(scan.refs[0]!)
    const store = { path, id: 'codex-test', rows }
    assertCodexRead(store, session)
    assertCodexScenario(store, session)
    assert.throws(() => assertCodexRead(store, { ...session, records: session.records.slice(1) }), /record count/)
    assert.throws(() => assertCodexRead(store, { ...session, events: session.events.filter(event => event.type !== 'assistant_message') }), /no event|text lost/)
    assert.throws(() => assertCodexRead(store, { ...session, events: session.events.map(event => event.type === 'tool_result' ? { ...event, data: { ...event.data, callId: 'wrong' } } : event) }))
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('reviewed optional paths accept new metadata without hiding type drift or required-field loss', () => {
  const baseline = { unknown: {}, structured: 0, fieldPaths: ['$.message:object'], optionalFieldPaths: ['$.permissionDecision:object', '$.permissionDecision.decision:string'] }
  assertNoProducerDrift(baseline, baseline)
  assertNoProducerDrift({ ...baseline, fieldPaths: [...baseline.fieldPaths, ...baseline.optionalFieldPaths] }, baseline)
  assert.throws(() => assertNoProducerDrift({ ...baseline, fieldPaths: ['$.message:object', '$.permissionDecision.decision:number'] }, baseline), (error: unknown) => {
    assert(error instanceof NativeDriftError)
    assert.deepEqual(error.drift, { added: ['$.permissionDecision.decision:number'], removed: [] })
    return true
  })
  assert.throws(() => assertNoProducerDrift({ ...baseline, fieldPaths: [] }, baseline), (error: unknown) => {
    assert(error instanceof NativeDriftError)
    assert.deepEqual(error.drift, { added: [], removed: ['$.message:object'] })
    return true
  })
})

await test('SQLite drift observations include decoded payloads and bounded binary types', () => {
  const session = { id: 'native', events: [], diagnostics: [] } as unknown as Session
  const rows = [{ id: 'native' }, { id: 'message', data: '{"role":"user","content":"first"}' }]
  const baseline = nativeDriftSummary('opencode', rows, session)
  const changed = [rows[0]!, { ...rows[1], data: '{"role":"user","text":"first"}' }]
  assert.throws(() => assertNoProducerDrift(nativeDriftSummary('opencode', changed, session), baseline), NativeDriftError)
  const bytes = nativeFieldPaths([{ id: 'native', path: '', rows: [{ native: { compressed: new Uint8Array([1, 2]) }, position: 1, text: '' }] }], false)
  assert.deepEqual(bytes, ['$.compressed:bytes', '$:object'])
})

await test('provider manifest covers the registry without turning blocked or partial journeys green', () => {
  assert.deepEqual(manifest.providers.map(provider => provider.id).sort(), sessions.providers().map(provider => provider.id).sort())
  assert.equal(new Set(manifest.providers.map(provider => provider.id)).size, manifest.providers.length)
  assert.match(manifest.simulator.commit, /^[a-f\d]{40}$/)
  for (const provider of manifest.providers) {
    if (provider.ci) {
      assert(provider.install !== undefined)
      assert(provider.checks.includes('read'))
      assert(provider.checks.includes('baseline'), `${provider.id} must detect upstream native field drift`)
      assert(provider.runner !== undefined)
    }
    else {
      assert(provider.reason !== undefined && provider.reason.length > 20)
      assert.deepEqual(provider.checks, [])
    }
  }
  const partial = { stage: 'passed', completed: ['scan', 'read', 'snapshot', 'records', 'events'], auditedSessions: 1, auditedRecords: 2 }
  assert.equal(laneResult('cline', 'pinned', '3.0.70', 'test', 'success', partial).verdict, 'incomplete')
  const complete = { ...partial, completed: [...partial.completed, 'scenario', 'baseline'] }
  const summary = renderCompatibilitySummary(complete, 'success', 'cline')
  assert.match(summary, /first-turn store only/)
  assert.doesNotMatch(summary, /Text \/ tool roundtrip \/ resume.*PASS/)
  assert.match(summary, /Native shape.*PASS/)
  const report = renderDailyReport([], '2026-10-08', 'https://github.com/wibus-wee/huihua/actions', 'test')
  assert.match(report, /cursor: NOT CERTIFIED|cursor\*\*: NOT CERTIFIED/)
  assert.match(report, new RegExp(`0/${activeProviders.length * 2} covered lanes passed`))
})

await test('path scopes and manual labels never shrink required provider coverage', () => {
  const all = activeProviders.map(provider => provider.id)
  assert.deepEqual(selectProviders(['docs/guide.md', 'README.md', 'src/providers/fx/RESEARCH.md']).providers, [])
  assert.deepEqual(selectProviders(['packages/usage/src/cli.ts']).providers, [])
  assert.deepEqual(selectProviders(['tests/provider-imports.test.ts', 'tools/policy.ts']).providers, [])
  assert.deepEqual(selectProviders(['src/providers/pi/index.ts']).providers, ['pi'])
  assert.deepEqual(selectProviders(['fixtures/compatibility/qwen/new.jsonl', 'tools/producer-compat/baselines/claude.json']).providers, ['claude', 'qwen'])
  assert.deepEqual(selectProviders(['src/providers/pi/index.ts', 'src/providers/qwen/index.ts']).providers, ['pi', 'qwen'])
  for (const path of ['src/shared/jsonl.ts', 'src/contracts/event.ts', 'src/registry.ts', 'tools/producer-compat/manifest.json', 'tools/producer-compat/live.ts', 'pnpm-lock.yaml', 'new-unknown-reader.ts']) {
    assert.deepEqual(selectProviders([path]).providers, all, path)
  }
  assert.deepEqual(selectProviders(['src/providers/pi/index.ts'], ['ci:provider:qwen', 'ci:none']).providers, ['pi', 'qwen'])
  assert.deepEqual(selectProviders(['docs/guide.md'], ['ci:all']).providers, all)
  assert.deepEqual(selectProviders(['docs/guide.md'], ['ci:provider:typo']).providers, all)
  assert.deepEqual(selectProviders([], [], true).providers, all)
  const blocked = selectProviders(['src/providers/cursor/index.ts'])
  assert.deepEqual(blocked.providers, [])
  assert.deepEqual(blocked.unavailable, ['cursor'])
  assert(blocked.scopeLabels.includes('scope:provider:cursor'))
})

await test('provider-local manifest differences select only affected native checks', () => {
  const path = 'tools/producer-compat/manifest.json'
  const changed = structuredClone(manifest)
  changed.providers.find(provider => provider.id === 'fx')!.gaps = ['resolved failure; tool coverage remains incomplete']
  const changes = { before: manifest, after: changed }
  const select = (delta: typeof changes) => selectProviders([path], [], false, delta)
  assert.deepEqual(select(changes).providers, ['fx'])
  assert.deepEqual(selectProviders([path], ['ci:provider:qwen'], false, changes).providers, ['fx', 'qwen'])
  assert.deepEqual(selectProviders(['src/providers/fx/index.ts', 'fixtures/fx/current/events.jsonl', 'tests/provider-imports.test.ts', 'tools/policy.ts', path], [], false, changes).providers, ['fx'])
  assert.deepEqual(select({ before: manifest, after: structuredClone(manifest) }).providers, [])
  const global = structuredClone(manifest)
  global.simulator.commit = '0'.repeat(40)
  assert.equal(select({ before: manifest, after: global }).full, true)
  const routing = structuredClone(manifest)
  routing.providers.find(provider => provider.id === 'fx')!.paths.prefixes.push('other/')
  assert.equal(select({ before: manifest, after: routing }).full, true)
  const inventory = structuredClone(manifest)
  inventory.providers.pop()
  assert.equal(select({ before: manifest, after: inventory }).full, true)
  assert.equal(selectProviders([path], [], false, { before: null, after: manifest }).full, true)
  const two = structuredClone(changed)
  two.providers.find(provider => provider.id === 'pi')!.install!.version = 'synthetic-version'
  assert.deepEqual(select({ before: manifest, after: two }).providers, ['fx', 'pi'])
  const blocked = structuredClone(manifest)
  blocked.providers.find(provider => provider.id === 'cursor')!.reason = 'synthetic changed blocker'
  assert.deepEqual(select({ before: manifest, after: blocked }).unavailable, ['cursor'])
})

await test('real git comparison handles doc-only changes, cross-provider renames and missing bases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'huihua-scope-test-'))
  const catalog = fileURLToPath(new URL('../tools/producer-compat/catalog.ts', import.meta.url))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = () => {
    git('add', '.')
    git('-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'synthetic change')
    return git('rev-parse', 'HEAD')
  }
  const selected = async (before: string, after: string, pr = false) => {
    const eventPath = join(directory, 'event.json')
    await writeFile(eventPath, JSON.stringify(pr ? { pull_request: { number: 1, base: { sha: before }, head: { sha: after }, labels: [] } } : { before, after }))
    const output = execFileSync(process.execPath, [catalog, 'matrix'], { cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GITHUB_EVENT_NAME: pr ? 'pull_request' : 'push', GITHUB_EVENT_PATH: eventPath } })
    return (JSON.parse(output) as { id: string }[]).map(provider => provider.id)
  }
  try {
    git('init', '-q')
    await mkdir(join(directory, 'tools/producer-compat'), { recursive: true })
    const manifestPath = join(directory, 'tools/producer-compat/manifest.json')
    await writeFile(manifestPath, JSON.stringify(manifest))
    await mkdir(join(directory, 'src/providers/pi'), { recursive: true })
    await writeFile(join(directory, 'src/providers/pi/index.ts'), '// synthetic\n')
    await writeFile(join(directory, 'README.md'), 'Before\n')
    const first = commit()
    await writeFile(join(directory, 'README.md'), 'After\n')
    const docs = commit()
    assert.deepEqual(await selected(first, docs), [])
    // event.json is test transport, not a repository change.
    await rm(join(directory, 'event.json'))
    await mkdir(join(directory, 'src/providers/qwen'), { recursive: true })
    await rename(join(directory, 'src/providers/pi/index.ts'), join(directory, 'src/providers/qwen/index.ts'))
    const renamed = commit()
    assert.deepEqual(await selected(docs, renamed), ['pi', 'qwen'])
    assert.deepEqual(await selected('0'.repeat(40), renamed), activeProviders.map(provider => provider.id))
    await rm(join(directory, 'event.json'))
    const fx = structuredClone(manifest)
    fx.providers.find(provider => provider.id === 'fx')!.gaps = ['remaining tool coverage gap']
    await writeFile(manifestPath, JSON.stringify(fx))
    await mkdir(join(directory, 'src/providers/fx'), { recursive: true })
    await mkdir(join(directory, 'tests'))
    await writeFile(join(directory, 'src/providers/fx/index.ts'), '// fx fix\n')
    await writeFile(join(directory, 'tests/provider-imports.test.ts'), '// fx regression\n')
    await writeFile(join(directory, 'tools/policy.ts'), '// fx policy\n')
    const fxCommit = commit()
    assert.deepEqual(await selected(renamed, fxCommit), ['fx'])
    await rm(join(directory, 'event.json'))
    fx.simulator.commit = '1'.repeat(40)
    await writeFile(manifestPath, JSON.stringify(fx))
    const global = commit()
    assert.deepEqual(await selected(fxCommit, global), activeProviders.map(provider => provider.id))
    await rm(join(directory, 'event.json'))
    await writeFile(manifestPath, '{broken')
    const malformed = commit()
    assert.deepEqual(await selected(global, malformed), activeProviders.map(provider => provider.id))
    await rm(join(directory, 'event.json'))
    git('checkout', '-qb', 'base-side', renamed)
    const advanced = structuredClone(manifest)
    advanced.providers.find(provider => provider.id === 'pi')!.install!.version = 'synthetic-new-base'
    await writeFile(manifestPath, JSON.stringify(advanced))
    const advancedBase = commit()
    // Main advanced independently; its Pi change is not part of the fx PR diff.
    assert.deepEqual(await selected(advancedBase, fxCommit, true), ['fx'])
  }
  finally { await rm(directory, { recursive: true, force: true }) }
})

await test('reviewed Codex shapes preserve pinned requirements and reject partial hybrids', async () => {
  const baseline = JSON.parse(await readFile(new URL('../tools/producer-compat/baselines/codex.json', import.meta.url), 'utf8')) as DriftSummary & { groupedFieldPaths: string[], reviewedPathVariants: { fieldPaths: string[], groupedFieldPaths: string[] }[] }
  const latest = { ...baseline, ...baseline.reviewedPathVariants[0]! }
  assertCodexBaseline(baseline, baseline)
  assertCodexBaseline(latest, baseline)
  for (const shape of [baseline, latest]) {
    const missing = { ...shape, groupedFieldPaths: shape.groupedFieldPaths.filter((path: string) => path !== '"response_item":$.payload.output:string') }
    assert.throws(() => assertCodexBaseline(missing, baseline), NativeDriftError)
    assert.throws(() => assertCodexBaseline({ ...shape, unknown: { ...shape.unknown, new_kind: 1 } }, baseline), /unknown native/)
    assert.throws(() => assertCodexBaseline({ ...shape, structured: 1 }, baseline), /structured fallback/)
    assert.throws(() => assertCodexBaseline({ ...shape, groupedFieldPaths: [...shape.groupedFieldPaths, '"event_msg":$.future:string'] }, baseline), NativeDriftError)
  }
  // Removing old stdout without the complete reviewed new shape is not accepted.
  assert.throws(() => assertCodexBaseline({ ...baseline, groupedFieldPaths: baseline.groupedFieldPaths.filter((path: string) => path !== '"event_msg":$.payload.item.stdout:string') }, baseline), NativeDriftError)
  const attribution = '"event_msg":$.payload.turn_attribution.turn_id:string'
  assert.throws(() => assertCodexBaseline({ ...latest, groupedFieldPaths: latest.groupedFieldPaths.filter((path: string) => path !== attribution) }, baseline), NativeDriftError)
  assert.throws(() => assertCodexBaseline({ ...latest, groupedFieldPaths: latest.groupedFieldPaths.map((path: string) => path === attribution ? attribution.replace(':string', ':number') : path) }, baseline), NativeDriftError)
})

await test('reviewed Claude requestedModel metadata stays raw and cannot replace response model', async () => {
  const native = { type: 'assistant', sessionId: 'reviewed', requestedModel: 'requested-alias', message: { model: 'actual-response-model', content: [{ type: 'text', text: 'exact reply' }], usage: { input_tokens: 1, output_tokens: 2 } } }
  const session = await sessions.parse('claude', { jsonl: JSON.stringify(native) })
  assert.deepEqual(session.records[0]!.native, native)
  const message = session.events.find(event => event.type === 'assistant_message')
  assert(message?.type === 'assistant_message')
  assert.equal(message.data.model, 'actual-response-model')
  const baseline = JSON.parse(await readFile(new URL('../tools/producer-compat/baselines/claude.json', import.meta.url), 'utf8')) as DriftSummary & { groupedFieldPaths: string[] }
  assertNoProducerDrift(baseline, baseline)
  assertNoProducerDrift({ ...baseline, fieldPaths: [...baseline.fieldPaths, '$.requestedModel:string'], groupedFieldPaths: [...baseline.groupedFieldPaths, '"assistant":$.requestedModel:string'] }, baseline)
  assert.throws(() => assertNoProducerDrift({ ...baseline, groupedFieldPaths: [...baseline.groupedFieldPaths, '"assistant":$.requestedModel:number'] }, baseline), NativeDriftError)
  assert.throws(() => assertNoProducerDrift({ ...baseline, groupedFieldPaths: [...baseline.groupedFieldPaths, '"user":$.requestedModel:string'] }, baseline), NativeDriftError)
})

await test('reviewed Claude child metadata is narrow and unknown repetition stays bounded', async () => {
  const baseline = JSON.parse(await readFile(new URL('../tools/producer-compat/baselines/claude-subagents.json', import.meta.url), 'utf8')) as DriftSummary & { groupedFieldPaths: string[] }
  const latest = { ...baseline, unknown: { ...baseline.unknown, 'atis-latch': 3, 'last-prompt': 3 }, fieldPaths: [...baseline.fieldPaths, '$.requestedModel:string', '$.toolUseResult.canContinueAgent:boolean'], groupedFieldPaths: [...baseline.groupedFieldPaths, '"assistant":$.requestedModel:string', '"user":$.toolUseResult.canContinueAgent:boolean'] }
  assertNoProducerDrift(latest, baseline)
  assertNoProducerDrift(baseline, baseline)
  assert.throws(() => assertNoProducerDrift({ ...latest, unknown: { ...latest.unknown, 'atis-latch': 4 } }, baseline), /unknown native/)
  assert.throws(() => assertNoProducerDrift({ ...latest, unknown: { ...latest.unknown, 'last-prompt': 4 } }, baseline), /unknown native/)
  assert.throws(() => assertNoProducerDrift({ ...latest, unknown: { ...latest.unknown, new_kind: 1 } }, baseline), /unknown native/)
  assert.throws(() => assertNoProducerDrift({ ...latest, groupedFieldPaths: [...latest.groupedFieldPaths, '"user":$.toolUseResult.canContinueAgent:string'] }, baseline), NativeDriftError)
  assert.throws(() => assertNoProducerDrift({ ...latest, groupedFieldPaths: latest.groupedFieldPaths.filter(path => path !== '"user":$.toolUseResult.agentId:string') }, baseline), NativeDriftError)
})
