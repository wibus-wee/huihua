import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'

import type { ScanResult, Session, SessionEvent } from '../../src/index.ts'
import { sessions } from '../../src/index.ts'
import type { CompatibilityProgress } from './report.ts'
import { writeReviewPacket } from './review.ts'
import type { DriftSummary, NativeStore } from './runtime.ts'
import { assertNoProducerDrift, assertSimulatorRequests, exchange, json, NativeDriftError, nativeFieldPaths, required, startSimulator } from './runtime.ts'

interface ClaudeStore extends NativeStore {
  parentSessionId?: string
  companion?: { path: string, text: string, native: Record<string, unknown> }
}

const subagentJourney = [
  { callId: 'huihua_spawn_1', description: 'First synthetic compatibility child', prompt: 'HUIHUA_CHILD_FIRST', reply: 'HUIHUA_CHILD_FIRST_REPLY' },
  { callId: 'huihua_spawn_2', description: 'Second synthetic compatibility child', prompt: 'HUIHUA_CHILD_SECOND', reply: 'HUIHUA_CHILD_SECOND_REPLY' },
]
const subagentFinal = 'HUIHUA_SUBAGENTS_COMPLETE'

// Independent test oracle, deliberately not Huihua's walker, framer or mapper.
// Only the isolated producer's JSONL is inspected. No user stores are read or repaired.
export async function inventoryNativeStores(root: string): Promise<ClaudeStore[]> {
  const stores: ClaudeStore[] = []
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
        const nativeSessionId = [...ids][0] as string
        const agents = new Set(rows.filter(row => row.native.isSidechain === true && row.native.parentSessionId === undefined).map(row => row.native.agentId).filter(id => typeof id === 'string'))
        assert(agents.size <= 1, `${path}: mixed-agent transcript`)
        const agentId = [...agents][0]
        const store: ClaudeStore = { path, id: agentId ?? nativeSessionId, rows }
        if (agentId !== undefined) {
          assert(rows.every(row => row.native.agentId === agentId && row.native.isSidechain === true && row.native.sessionId === nativeSessionId), `${path}: inconsistent native subagent identity`)
          assert.equal(basename(dirname(path)), 'subagents', `${path}: unexpected subagent location`)
          assert.equal(basename(path), `agent-${agentId}.jsonl`, `${path}: filename disagrees with native agent identity`)
          store.parentSessionId = nativeSessionId
          const companionPath = path.replace(/\.jsonl$/, '.meta.json')
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(companionPath))
            const native = JSON.parse(text) as unknown
            assert(native !== null && typeof native === 'object' && !Array.isArray(native), `${companionPath}: companion requires a JSON object`)
            store.companion = { path: companionPath, text, native: native as Record<string, unknown> }
          }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
              throw error
          }
        }
        stores.push(store)
      }
    }
  }
  await visit(root)
  return stores.sort((a, b) => a.path.localeCompare(b.path))
}

export function assertDiscovery(stores: ClaudeStore[], scan: ScanResult, expectedIds: string[]): void {
  assert.equal(new Set(stores.map(store => store.id)).size, stores.length, 'producer inventory: colliding session identities')
  assert.deepEqual(stores.map(store => store.id).sort(), [...expectedIds].sort(), 'producer inventory: missing/duplicate/unexpected native sessions')
  assert.deepEqual(scan.failures, [], 'Huihua scan failures')
  const expected = stores.map(store => ['claude', store.path, 'jsonl', store.id]).sort()
  const actual = scan.refs.map(ref => [ref.provider, ref.source.path, ref.source.format, ref.id]).sort()
  assert.deepEqual(actual, expected, 'Huihua discovery: missing/duplicate/unexpected session or wrong identity/path')
}

export function assertNativeRead(store: ClaudeStore, session: Session): void {
  const label = `${store.id} ${store.path}`
  assert.equal(session.id, store.id, `${label}: session id`)
  assert.equal(session.provider, 'claude', `${label}: session provider`)
  assert.deepEqual(session.source, { path: store.path, format: 'jsonl' }, `${label}: session source`)
  const evidence: { path: string, position?: number, text: string, native: Record<string, unknown> }[] = [
    ...(store.companion === undefined ? [] : [store.companion]),
    ...store.rows.map(row => ({ ...row, path: store.path })),
  ]
  assert.equal(session.records.length, evidence.length, `${label}: native record count (loss or duplication)`)
  for (const [i, row] of evidence.entries()) {
    const record = session.records[i]!
    const at = `${label}:${row.position}`
    assert.equal(record.sequence, i, `${at}: record sequence`)
    assert.equal(record.provider, 'claude', `${at}: provider`)
    assert.deepEqual(record.source, { path: row.path, ...(row.position === undefined ? {} : { position: row.position }) }, `${at}: evidence source/line`)
    assert.equal(record.text, row.text, `${at}: raw text differs`)
    assert.deepEqual(record.native, row.native, `${at}: native field/value differs`)
  }
  for (const [i, event] of session.events.entries()) {
    assert.equal(event.sequence, i, `${label}: event sequence`)
    assert(Number.isInteger(event.record) && event.record >= 0 && event.record < evidence.length, `${label}: dangling event.record ${event.record}`)
  }
  for (const [i, row] of evidence.entries()) {
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
    ...(evidence[event.record]!.position === undefined ? {} : { position: evidence[event.record]!.position }),
  }))
  assert.deepEqual(session.diagnostics, expectedDiagnostics, `${label}: missing/extra/misattributed diagnostics`)
  const parents = store.rows.map(row => row.native.parentSessionId).filter(value => typeof value === 'string')
  assert.equal(session.parentSessionId, store.parentSessionId ?? parents.at(-1), `${label}: parentSessionId`)
  if (store.parentSessionId !== undefined) {
    assert.equal(session.metadata.agentId, store.id, `${label}: native agent metadata`)
    assert.equal(session.metadata.sessionId, store.parentSessionId, `${label}: native parent metadata`)
  }
  if (store.companion !== undefined)
    assert.deepEqual(session.metadata.subagent, store.companion.native, `${label}: companion metadata`)
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

export function assertSubagentScenario(stores: ClaudeStore[], parentId: string): string[] {
  const parent = stores.find(store => store.id === parentId && store.parentSessionId === undefined)
  assert(parent, 'subagent scenario: missing parent transcript')
  const children = stores.filter(store => store.parentSessionId === parentId)
  assert.equal(children.length, subagentJourney.length, 'subagent scenario: missing/extra child transcripts')
  assert.equal(new Set([parent.id, ...children.map(child => child.id)]).size, children.length + 1, 'subagent scenario: colliding parent/child identities')
  assert(parent.rows.some(row => row.native.type === 'assistant' && JSON.stringify(row.native.message).includes(subagentFinal)), 'subagent scenario: missing parent completion')
  const blocks = parent.rows.flatMap((row) => {
    const message = row.native.message as { content?: unknown } | undefined
    return Array.isArray(message?.content) ? message.content as Record<string, unknown>[] : []
  })
  for (const expected of subagentJourney) {
    const matching = children.filter(child => child.rows.some(row => row.native.type === 'user' && JSON.stringify(row.native.message).includes(expected.prompt)))
    assert.equal(matching.length, 1, `subagent scenario: missing/duplicate child for ${expected.prompt}`)
    const child = matching[0]!
    assert(child.rows.some(row => row.native.type === 'assistant' && JSON.stringify(row.native.message).includes(expected.reply)), `subagent scenario: missing native reply for ${expected.prompt}`)
    assert(child.companion, `subagent scenario: missing companion for ${child.id}`)
    const meta = child.companion.native
    assert.equal(meta.toolUseId, expected.callId, `subagent scenario: wrong spawn tool reference for ${child.id}`)
    assert.equal(meta.agentType, 'general-purpose', `subagent scenario: agent type for ${child.id}`)
    assert.equal(meta.description, expected.description, `subagent scenario: description for ${child.id}`)
    assert.equal(meta.spawnDepth, 1, `subagent scenario: spawn depth for ${child.id}`)
    assert.equal(meta.requestShape, 'foreground', `subagent scenario: request shape for ${child.id}`)
    assert.equal(meta.requestNonInteractive, true, `subagent scenario: noninteractive request for ${child.id}`)
    const call = blocks.find(block => block.type === 'tool_use' && block.id === meta.toolUseId)
    assert(call, `subagent scenario: missing parent spawn call for ${child.id}`)
    assert.equal(call.name, 'Agent', `subagent scenario: spawn tool for ${child.id}`)
    assert.deepEqual(call.input, { description: expected.description, prompt: expected.prompt, subagent_type: 'general-purpose', run_in_background: false }, `subagent scenario: spawn arguments for ${child.id}`)
    const result = blocks.find(block => block.type === 'tool_result' && block.tool_use_id === meta.toolUseId)
    assert(result && result.is_error !== true, `subagent scenario: missing/failed parent tool result for ${child.id}`)
    assert(JSON.stringify(result.content).includes(expected.reply), `subagent scenario: child result did not reach parent for ${child.id}`)
    const resultRows: NativeStore['rows'] = parent.rows.filter((row) => {
      const message = row.native.message as { content?: unknown } | undefined
      return Array.isArray(message?.content) && message.content.includes(result)
    })
    assert.equal(resultRows.length, 1, `subagent scenario: missing/duplicate result record for ${child.id}`)
    const nativeResult = resultRows[0]!.native.toolUseResult as Record<string, unknown> | undefined
    assert(nativeResult, `subagent scenario: missing native child result for ${child.id}`)
    assert.equal(nativeResult.agentId, child.id, `subagent scenario: native result agent for ${child.id}`)
    assert.equal(nativeResult.status, 'completed', `subagent scenario: native child status for ${child.id}`)
  }
  return children.map(child => child.id)
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
  else if (native.type === undefined && typeof native.agentType === 'string' && typeof native.toolUseId === 'string') {
    assert.equal(events.length, 1, `${at}: companion event count`)
    const event = events[0]!
    assert(event.type === 'system', `${at}: companion classification`)
    assert.equal(event.data.sourceType, 'subagent_metadata', `${at}: companion source type`)
    assert.deepEqual(event.data.payload, native, `${at}: companion payload`)
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
  const subagentSessionId = randomUUID()
  const output = resolve(process.env.COMPAT_REPORT ?? 'producer-compat-report.json')
  let stage = 'simulator-startup'
  const progress: CompatibilityProgress = { stage, completed: [] }
  try {
    await simulator.ready()
    stage = 'scenario-setup'
    const template = await simulator.template()
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
    stage = 'producer-subagents'
    const spawnAgent = (index: number) => {
      const child = subagentJourney[index]!
      return { type: 'tool_use', id: child.callId, name: 'Agent', input: { description: child.description, prompt: child.prompt, subagent_type: 'general-purpose', run_in_background: false } }
    }
    await json(`${control}/enqueue`, { provider: 'anthropic', exchanges: [
      exchange('spawn first child', 'HUIHUA_SUBAGENT_PARENT', spawnAgent(0), 'tool_use', template),
      exchange('first child reply', subagentJourney[0]!.prompt, { type: 'text', text: subagentJourney[0]!.reply, citations: null }, 'end_turn', template),
      exchange('spawn second child', subagentJourney[0]!.reply, spawnAgent(1), 'tool_use', template),
      exchange('second child reply', subagentJourney[1]!.prompt, { type: 'text', text: subagentJourney[1]!.reply, citations: null }, 'end_turn', template),
      exchange('complete after children', subagentJourney[1]!.reply, { type: 'text', text: subagentFinal, citations: null }, 'end_turn', template),
    ] })
    await runClaude(['--session-id', subagentSessionId], 'HUIHUA_SUBAGENT_PARENT', false)
    const ledger = await json(`${control}/requests`)
    await writeFile(join(root, 'ledger.json'), JSON.stringify(ledger, null, 2))
    stage = 'native-inventory'
    const stores = await inventoryNativeStores(home)
    await writeFile(join(root, 'native-inventory.json'), JSON.stringify(stores, null, 2))
    progress.auditedSessions = stores.length
    progress.auditedRecords = stores.reduce((sum, store) => sum + store.rows.length + (store.companion === undefined ? 0 : 1), 0)
    const childIds = assertSubagentScenario(stores, subagentSessionId)
    stage = 'scan'
    const scan = await sessions.scan({ providers: ['claude'], homeDir: home })
    assertDiscovery(stores, scan, [sessionId, secondSessionId, subagentSessionId, ...childIds])
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
    await writeFile(join(root, 'read.json'), JSON.stringify(session, null, 2))
    await writeReviewPacket('claude', root, session)
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
    const originalStores = stores.filter(store => store.id === sessionId || store.id === secondSessionId)
    const fieldPaths = nativeFieldPaths(originalStores, false)
    const groupedFieldPaths = nativeFieldPaths(originalStores)
    const childStores = stores.filter(store => store.id === subagentSessionId || store.parentSessionId === subagentSessionId)
    const childSources = childStores.flatMap(store => [store, ...(store.companion === undefined ? [] : [{ path: store.companion.path, id: store.id, rows: [{ ...store.companion, position: 1 }] }])])
    const childSessions = await Promise.all(childStores.map(async store => sessions.read(scan.refs.find(ref => ref.source.path === store.path)!)))
    const childUnknown: Record<string, number> = {}
    for (const child of childSessions) {
      for (const event of child.events) {
        if (event.type === 'unknown')
          childUnknown[event.data.sourceType] = (childUnknown[event.data.sourceType] ?? 0) + 1
      }
    }
    const subagents = { parentSessionId: subagentSessionId, childIds, unknown: childUnknown, structured: childSessions.flatMap(child => child.events.filter(event => event.type === 'user_message' || event.type === 'assistant_message').flatMap(event => event.data.content)).filter(block => block.type === 'structured').length, fieldPaths: nativeFieldPaths(childSources, false), groupedFieldPaths: nativeFieldPaths(childSources) }
    for (const [index, child] of childSessions.entries())
      await writeFile(join(root, `subagent-read-${index}.json`), JSON.stringify(child, null, 2))
    const report = { provider: 'claude', auditedSessions: stores.length, auditedRecords: progress.auditedRecords, sessionId, records: session.records.length, events: session.events.length, unknown, structured, diagnostics: session.diagnostics, fieldPaths, groupedFieldPaths, subagents, inventory: stores.map(store => ({ path: store.path, id: store.id, parentSessionId: store.parentSessionId, companion: store.companion?.path, records: store.rows.length + (store.companion === undefined ? 0 : 1) })) }
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
    stage = 'baseline'
    const baseline = JSON.parse(await readFile(new URL('./baselines/claude.json', import.meta.url), 'utf8')) as DriftSummary
    assertNoProducerDrift(report, baseline)
    const childBaseline = JSON.parse(await readFile(new URL('./baselines/claude-subagents.json', import.meta.url), 'utf8')) as DriftSummary
    assertNoProducerDrift(subagents, childBaseline)
    assertSimulatorRequests(ledger, [firstPrompt, toolText, 'HUIHUA_PRODUCER_RESUME', secondPrompt, 'HUIHUA_SUBAGENT_PARENT', subagentJourney[0]!.prompt, subagentJourney[0]!.reply, subagentJourney[1]!.prompt, subagentJourney[1]!.reply].map(marker => ({ path: '/v1/messages', marker })))
    await simulator.assertExhausted()
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

  async function runClaude(args: string[], prompt: string, bare = true): Promise<void> {
    // Bare mode disables Agent; only the isolated child journey enables that tool.
    const mode = bare ? ['--bare', '--tools', 'Read', '--allowedTools', 'Read'] : ['--setting-sources', '', '--tools', 'Agent', '--allowedTools', 'Agent']
    const child = spawn(claude, [...mode, '-p', '--model', 'claude-sonnet-4-5', '--output-format', 'json', ...args], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
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
