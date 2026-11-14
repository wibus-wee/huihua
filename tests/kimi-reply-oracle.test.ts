import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sessions } from '../src/index.ts'
import { assertKimiReplies } from '../tools/producer-compat/kimi.ts'

await test('Kimi reply oracle accepts native loop content without message projections', async () => {
  const rows = ['HUIHUA_KIMI_REPLY', 'HUIHUA_KIMI_RESUMED'].map(text => ({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text } } }))
  const session = await sessions.parse('kimi', { jsonl: rows.map(row => JSON.stringify(row)).join('\n') })
  assertKimiReplies(rows, session.events)
  assert.throws(() => assertKimiReplies(rows.slice(0, 1), session.events), /must persist/)
  assert.throws(() => assertKimiReplies(rows, session.events.slice(1)), /assistant replies/)
  assert.throws(() => assertKimiReplies(rows, [...session.events].reverse()), /assistant replies/)
  assert.throws(() => assertKimiReplies([...rows, rows[0]], session.events), /must persist/)
  const projections = rows.map(row => ({ type: 'agent.message.appended', message: { message: { role: 'assistant', content: [row.event.part] } } }))
  assertKimiReplies([...rows, ...projections], session.events)
  assert.throws(() => assertKimiReplies([...rows, { type: 'agent.message.appended', message: { message: { role: 'user', content: [] } } }], session.events), /must persist/)
  assert.throws(() => assertKimiReplies([{ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 7 } } }], session.events), /content shape/)
})
