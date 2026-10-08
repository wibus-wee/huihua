import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sessions } from '../src/index.ts'
import { assertKimiReplies } from '../tools/producer-compat-kimi-audit.ts'
import { renderCompatibilitySummary } from '../tools/producer-compat-summary.ts'

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

await test('Kimi summary does not claim Claude tools or baseline coverage', () => {
  const summary = renderCompatibilitySummary({ stage: 'passed', completed: ['scan', 'read', 'snapshot', 'records', 'events'], auditedSessions: 1, auditedRecords: 40 }, 'success', 'kimi')
  assert.match(summary, /Result: PASS/)
  assert.match(summary, /Scope: Kimi text and resume/)
  assert.doesNotMatch(summary, /tool roundtrip|baseline \| PASS/)
  const failure = renderCompatibilitySummary({ stage: 'read', completed: ['scan'], error: 'missing replies' }, 'failure', 'kimi')
  assert.match(failure, /Read.*FAIL/)
  assert.match(failure, /Snapshot.*NOT RUN/)
})
