import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderCompatibilitySummary } from '../tools/producer-compat-summary.ts'

await test('compatibility summary exposes completed checks and native counts', () => {
  const summary = renderCompatibilitySummary({ stage: 'passed', completed: ['scan', 'read', 'snapshot', 'records', 'events', 'scenario', 'baseline'], auditedSessions: 2, auditedRecords: 27 }, 'success')
  assert.match(summary, /PASS/)
  assert.match(summary, /Native sessions: 2/)
  assert.match(summary, /Native records: 27/)
  assert.match(summary, /Streamed events.*PASS/)
})

await test('failure summary never marks unrun checks as passed and escapes errors', () => {
  const summary = renderCompatibilitySummary({ stage: 'read', completed: ['scan'], auditedSessions: 2, auditedRecords: 27, error: 'missing <record> | bad\nline' }, 'failure')
  assert.match(summary, /Read.*FAIL/)
  assert.match(summary, /Snapshot.*NOT RUN/)
  assert.match(summary, /&lt;record&gt;/)
  assert.match(summary, /Failed stage: read/)
  assert.doesNotMatch(summary, /Snapshot.*PASS/)
})

await test('missing evidence and interrupted runs cannot produce a success summary', () => {
  assert.match(renderCompatibilitySummary(undefined, 'skipped'), /NOT RUN/)
  assert.match(renderCompatibilitySummary(undefined, 'failure'), /No audit evidence/)
  assert.match(renderCompatibilitySummary({ stage: 'passed', completed: [] }, 'failure'), /FAIL/)
})
