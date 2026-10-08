import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ScanResult, Session, SessionEvent } from '../src/index.ts'

export interface NativeStore {
  path: string
  id: string
  rows: { position: number, text: string, native: Record<string, unknown> }[]
}

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

export function nativeFieldPaths(stores: NativeStore[], grouped = true): string[] {
  const paths = new Set<string>()
  function visit(value: unknown, path: string): void {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    paths.add(`${path}:${type}`)
    if (Array.isArray(value)) {
      for (const item of value) visit(item, `${path}[]`)
    }
    else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`)
    }
  }
  for (const store of stores) {
    for (const row of store.rows) visit(row.native, grouped ? `${JSON.stringify(row.native.type ?? null)}:$` : '$')
  }
  return [...paths].sort()
}
