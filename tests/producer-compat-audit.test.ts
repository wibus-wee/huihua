import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Session } from '../src/index.ts'
import { sessions } from '../src/index.ts'
import { assertNoProducerDrift } from '../tools/producer-compat-assertions.ts'
import { assertDiscovery, assertNativeRead, inventoryNativeStores, nativeFieldPaths } from '../tools/producer-compat-audit.ts'

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
