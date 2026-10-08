import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { sessions } from '../src/index.ts'
import { assertCodexRead, assertCodexScenario } from '../tools/producer-compat-codex-audit.ts'
import { renderCompatibilitySummary } from '../tools/producer-compat-summary.ts'

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

await test('Codex summary requires scenario and baseline before passing', () => {
  const summary = renderCompatibilitySummary({ stage: 'passed', completed: ['scan', 'read', 'snapshot', 'records', 'events'] }, 'success', 'codex')
  assert.match(summary, /FAIL \/ INCOMPLETE/)
  assert.match(summary, /baseline.*NOT RUN/)
  assert.match(summary, /Scope: Codex/)
})
