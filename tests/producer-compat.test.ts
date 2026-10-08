import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Session } from '../src/index.ts'
import { sessions } from '../src/index.ts'
import { assertDiscovery, assertNativeRead, inventoryNativeStores } from '../tools/producer-compat/claude.ts'
import { assertCodexRead, assertCodexScenario } from '../tools/producer-compat/codex.ts'
import { assertKimiReplies } from '../tools/producer-compat/kimi.ts'
import { assertNoProducerDrift, nativeFieldPaths } from '../tools/producer-compat/runtime.ts'

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
