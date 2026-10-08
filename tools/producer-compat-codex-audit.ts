import assert from 'node:assert/strict'

import type { Session } from '../src/index.ts'
import type { NativeStore } from './producer-compat-audit.ts'

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
