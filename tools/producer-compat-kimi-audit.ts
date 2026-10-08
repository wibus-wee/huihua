import assert from 'node:assert/strict'

import type { Session } from '../src/contracts/session.ts'

// Scenario-local oracle over real writer records, not Huihua's parsing output.
export function assertKimiReplies(rows: unknown[], events: Session['events']): void {
  const expected: string[] = []
  for (const row of rows) {
    assert(row !== null && typeof row === 'object')
    if (!('type' in row) || row.type !== 'agent.message.appended')
      continue
    const envelope = 'message' in row ? row.message : undefined
    assert(envelope !== null && typeof envelope === 'object' && 'message' in envelope)
    const message = envelope.message
    assert(message !== null && typeof message === 'object' && 'role' in message)
    if (message.role !== 'assistant')
      continue
    assert('content' in message && Array.isArray(message.content))
    for (const part of message.content as unknown[]) {
      assert(part !== null && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string', 'unreviewed Kimi content shape')
      expected.push(part.text)
    }
  }
  assert.equal(expected.length, 2, 'real Kimi must persist both first-turn and resumed replies')
  assert.deepEqual(expected, ['HUIHUA_KIMI_REPLY', 'HUIHUA_KIMI_RESUMED'], 'native replies do not match the simulator scenario')
  const actual = events.flatMap(event => event.type === 'assistant_message' ? event.data.content.filter(block => block.type === 'text').map(block => block.data) : [])
  assert.deepEqual(actual, expected, 'Kimi assistant replies missing, duplicated, reordered or changed in Huihua output')
}
