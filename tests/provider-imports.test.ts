import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { it } from 'node:test'

import { conversationOf, createSessionRegistry, eventsOf, fileChangesOf, millisOf, sessions, toolCallsOf, toolResultsOf } from '../src/index.ts'
import * as ingest from '../src/ingest/index.ts'
import { assertSessionContract } from '../src/testing/index.ts'

const fixture = (path: string) => resolve('fixtures', path)
const compatibility = (path: string) => fixture(`compatibility/${path}`)

void it('Cursor normalizes role-less turn failures and preserves native evidence', async () => {
  const native = { type: 'turn_ended', status: 'error', error: 'upstream request failed' }
  const jsonl = `${JSON.stringify(native)}\n`
  for (const input of [
    { jsonl },
    { path: fixture('cursor/turn-error.jsonl') },
  ]) {
    const session = await sessions.parse('cursor', input)
    assertSessionContract(session)
    assert.deepEqual(session.events.map(e => ({ type: e.type, data: e.data, record: e.record })), [
      { type: 'error', data: { message: 'upstream request failed', details: native }, record: 0 },
    ])
    assert.deepEqual(session.records[0]?.native, native)
    assert.equal(session.records[0]?.text, jsonl)
    assert.deepEqual(session.diagnostics, [])
  }
})

void it('Cursor keeps unrecognized turn endings unknown and preserves role messages', async () => {
  const unknown = [
    { type: 'turn_ended', status: 'success', error: 'not a failure' },
    { type: 'turn_ended', status: 'error', error: '' },
    { type: 'turn_ended', status: 'error' },
    { type: 'turn_ended', status: 'error', error: { message: 'structured' } },
    { type: 'future', status: 'error', error: 'future record' },
    { role: 'system', type: 'turn_ended', status: 'error', error: 'unknown role' },
  ]
  const message = { role: 'assistant', type: 'turn_ended', status: 'error', error: 'role message', message: { content: 'answer' } }
  const emptyRole = { role: '', type: 'turn_ended', status: 'error', error: 'empty role' }
  const session = await sessions.parse('cursor', { jsonl: [...unknown, message, emptyRole].map(v => JSON.stringify(v)).join('\n') })
  assertSessionContract(session)
  assert.deepEqual(eventsOf(session, 'unknown').map(e => e.data.payload), unknown)
  assert.deepEqual(conversationOf(session).map(e => e.data.content), [[{ type: 'text', data: 'answer' }]])
  assert.deepEqual(eventsOf(session, 'error').map(e => e.data.message), ['empty role'])
})

void it('OAR keeps voyage wrappers, requests, echoes, repeated message IDs and unknown native frames', async () => {
  const input = await readFile(fixture('oar/voyage.jsonl'), 'utf8')
  const session = await sessions.parse('oar', { jsonl: input })
  assertSessionContract(session)
  assert.equal(session.id, 'root')
  assert.equal(session.workspace?.path, '/captured/workspace')
  assert.equal(session.records.length, 7)
  assert.deepEqual(conversationOf(session).map(e => e.data.content), [
    [{ type: 'text', data: 'hello' }],
    [{ type: 'text', data: 'hello' }],
    [{ type: 'text', data: 'Hello' }],
    [{ type: 'text', data: ' again' }],
  ])
  assert.deepEqual(eventsOf(session, 'assistant_message').map(e => e.id), ['m', 'm'])
  assert.equal(toolCallsOf(session).length, 1)
  assert.equal(toolResultsOf(session).length, 1)
  assert.equal(eventsOf(session, 'unknown').length, 1)
  assert.deepEqual(session.records.map(r => r.text).join(''), input)
  assert.deepEqual(toolCallsOf(session)[0]?.providerMetadata.agentPath, [])
})

void it('OAR scopes missing-result diagnostics to the native agent and session', async () => {
  const records = [
    { kind: 'frame', sessionId: 'root', agentPath: ['child'], seq: 1, receivedAt: 1, body: { type: 'tool', native: {}, events: [{ kind: 'tool_call_started', callId: 'shared', tool: 'read' }] } },
    { kind: 'frame', sessionId: 'root', agentPath: [], seq: 2, receivedAt: 2, body: { type: 'tool', native: {}, events: [{ kind: 'tool_call_started', callId: 'shared', tool: 'read' }, { kind: 'tool_call_ended', callId: 'shared', result: 'ok' }] } },
  ]
  const session = await sessions.parse('oar', { jsonl: records.map(r => JSON.stringify(r)).join('\n') })
  assert.equal(session.diagnostics.filter(d => d.message.includes('no recorded result')).length, 1)
})

void it('OAR checks capture completion independently on each replay', async () => {
  const opened = await sessions.open({ id: 'root', provider: 'oar', source: { path: fixture('oar/truncated.jsonl'), format: 'jsonl' }, metadata: {} })
  assert.equal(opened.readMode, 'incremental')
  const first = await opened.snapshot()
  assert.ok(first.diagnostics.some(d => d.message.includes('end marker')))
  assert.deepEqual(await opened.snapshot(), first)
})

void it('ACP preserves partial updates, attachments and explicit diffs without inventing completion', async () => {
  const session = await sessions.parse('acp', { path: fixture('acp/updates.jsonl') })
  assertSessionContract(session)
  assert.equal(session.id, 'acp-session')
  assert.equal(session.workspace?.path, '/native/cwd')
  assert.equal(toolCallsOf(session).length, 1)
  assert.equal(toolResultsOf(session).length, 1)
  assert.equal(toolResultsOf(session)[0]?.data.callId, 'call')
  assert.deepEqual(fileChangesOf(session).map(e => e.data), [{ path: '/a', operation: 'modify', before: 'old', after: 'new' }])
  assert.equal(eventsOf(session, 'unknown')[0]?.data.sourceType, '_vendor/custom')
  assert.equal(conversationOf(session)[1]?.data.content[0]?.type, 'image')
  const v2 = await sessions.parse('acp', { path: fixture('acp/v2.jsonl') })
  assert.deepEqual(eventsOf(v2, 'assistant_message').map(e => e.id), ['same', 'same'])
  assert.deepEqual(fileChangesOf(v2).map(e => e.data.operation), ['create', 'rename'])
  assert.equal(eventsOf(v2, 'unknown')[0]?.data.sourceType, 'acp_diff')
})

void it('native Kimi and Grok read metadata as evidence and retain recorded time units', async () => {
  const kimi = await sessions.parse('kimi', { path: fixture('kimi/session/agents/main/wire.jsonl') })
  assertSessionContract(kimi)
  assert.equal(kimi.id, 'kimi-session')
  assert.equal(kimi.records[0]?.source.path, fixture('kimi/session/state.json'))
  assert.equal(kimi.workspace?.path, '/captured/kimi')
  assert.equal(toolCallsOf(kimi)[0]?.data.arguments, '{"path":"a"}')
  assert.equal(toolResultsOf(kimi).length, 1)
  assert.equal(eventsOf(kimi, 'subagent').length, 2)
  assert.deepEqual(kimi.updatedAt, { format: 'unix_millis', value: 1700 })
  const grok = await sessions.parse('grok', { path: fixture('grok/session/updates.jsonl') })
  assertSessionContract(grok)
  assert.equal(grok.id, 'grok-session')
  assert.equal(grok.parentSessionId, 'parent')
  assert.deepEqual(conversationOf(grok)[0]?.timestamp, { format: 'unix_millis', value: 2000 })
  assert.deepEqual(grok.updatedAt, { format: 'unix_millis', value: 3000 })
  assert.equal(eventsOf(grok, 'unknown').length, 1)
})

void it('Antigravity orders native steps and preserves every protobuf byte and unconfirmed outcome', async () => {
  const session = await sessions.parse('antigravity', { path: fixture('antigravity/steps.db'), format: 'antigravity_sqlite' })
  assertSessionContract(session)
  assert.equal(session.records.length, 5)
  assert.equal(conversationOf(session).length, 2)
  assert.equal(toolCallsOf(session)[0]?.data.callId, 'call')
  assert.equal(toolResultsOf(session).length, 0)
  assert.equal(eventsOf(session, 'unknown').length, 2)
  assert.deepEqual((session.records[2]?.native as Record<string, unknown>).permissions, { native_bytes: [0, 1] })
  assert.equal((await sessions.open({ ...session })).readMode, 'buffered')
})

void it('Morph selects a topic across ordered journal segments and retains repeated snapshots', async () => {
  const { refs } = await sessions.scan({ providers: ['morph'], roots: { morph: [fixture('morph/store')] } })
  assert.equal(refs.length, 1)
  const session = await sessions.read(refs[0]!)
  assertSessionContract(session)
  assert.equal(session.id, 'topic')
  assert.equal(session.records.length, 4)
  assert.equal(conversationOf(session).length, 3)
  assert.equal(eventsOf(session, 'user_message').length, 2)
  assert.equal(eventsOf(session, 'unknown').length, 1)
  assert.equal(conversationOf(session)[0]?.providerMetadata.topic_id, 'topic')
})

void it('ACP keeps foreign sessions as evidence without mixing conversations or matching their call IDs', async () => {
  const lines = [
    { sessionId: 'root', update: { sessionUpdate: 'tool_call', toolCallId: 'same', title: 'Read', status: 'in_progress' } },
    { sessionId: 'foreign', update: { sessionUpdate: 'tool_call_update', toolCallId: 'same', status: 'completed' } },
    { sessionId: 'foreign', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'foreign' } } },
    { sessionId: 'root', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'root' } } },
  ]
  const session = await sessions.parse('acp', { jsonl: lines.map(r => JSON.stringify(r)).join('\n') })
  assert.equal(session.id, 'root')
  assert.equal(session.records.length, 4)
  assert.equal(eventsOf(session, 'unknown').length, 2)
  assert.equal(toolResultsOf(session).length, 0)
  assert.deepEqual(conversationOf(session).map(e => e.data.content), [[{ type: 'text', data: 'root' }]])
  assert.ok(session.diagnostics.some(d => d.message.includes('no recorded result')))
})

void it('recorded JSONL providers share byte framing, malformed-record recovery and limits', async () => {
  for (const [provider, file] of [['oar', 'oar/voyage.jsonl'], ['acp', 'acp/updates.jsonl'], ['kimi', 'kimi/session/agents/main/wire.jsonl'], ['grok', 'grok/session/updates.jsonl'], ['morph', 'morph/store/journal/events.000000000000000001.jsonl']] as const) {
    const bytes = await readFile(fixture(file))
    async function* chunks() {
      for (let i = 0; i < bytes.length; i += 7)
        yield bytes.subarray(i, i + 7)
    }
    const expected = await sessions.parse(provider, { jsonl: bytes })
    const actual = await sessions.parse(provider, { jsonl: chunks() })
    assert.deepEqual(actual, expected)
    const corrupted = await sessions.parse(provider, { jsonl: Buffer.concat([Buffer.from('{broken\n'), bytes]) })
    assert.equal(corrupted.records.length, expected.records.length + 1)
    assert.ok(corrupted.events.some(e => e.type === 'unknown' && e.data.sourceType === 'malformed_jsonl'))
    await assert.rejects(sessions.parse(provider, { jsonl: bytes }, { maxRecordBytes: 10 }), { code: 'CorruptedSession' })
    const signal = AbortSignal.abort(new Error('cancelled'))
    await assert.rejects(sessions.parse(provider, { jsonl: chunks() }, { signal }), /cancelled/)
  }
})

void it('Kimi preserves malformed metadata and does not read companion files for supplied JSONL', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-import-'))
  t.after(async () => rm(root, { force: true, recursive: true }))
  const directory = join(root, 'agents/main')
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'wire.jsonl')
  const line = { type: 'context.append_message', agentId: 'main', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }
  await writeFile(path, JSON.stringify(line))
  await writeFile(join(root, 'state.json'), '{bad json')
  const disk = await sessions.parse('kimi', { path })
  assert.equal(disk.records.length, 2)
  assert.equal(eventsOf(disk, 'unknown')[0]?.data.sourceType, 'malformed_json')
  const supplied = await sessions.parse('kimi', { jsonl: JSON.stringify(line), source: path })
  assert.equal(supplied.records.length, 1)
  assert.equal(supplied.workspace, undefined)
  const approval = await sessions.parse('kimi', { jsonl: [
    { type: 'interaction.request', id: 'approval', kind: 'approval', request: {} },
    { type: 'interaction.request', id: 'question', kind: 'question', request: {} },
  ].map(r => JSON.stringify(r)).join('\n') })
  assert.equal(eventsOf(approval, 'permission_request').length, 1)
  assert.equal(eventsOf(approval, 'permission_request')[0]?.data.requestId, 'approval')
})

void it('Hermes decodes only the native sentinel and preserves inactive rows and session selectors', async () => {
  const session = await sessions.parse('hermes', { path: fixture('hermes/sessions.db'), format: 'hermes_sqlite', id: 'hermes-db' })
  assertSessionContract(session)
  assert.equal(session.records.length, 4)
  assert.deepEqual(conversationOf(session).map(e => e.data.content), [[{ type: 'text', data: '[this is plain text]' }], [{ type: 'text', data: 'Reading' }]])
  assert.equal(conversationOf(session)[0]?.providerMetadata.active, 0)
  assert.deepEqual(conversationOf(session)[1]?.timestamp, { format: 'unix_millis', value: 1700000001000 })
  assert.equal(toolCallsOf(session).length, 1)
  assert.equal(toolResultsOf(session).length, 1)
  await assert.rejects(sessions.parse('hermes', { path: fixture('hermes/sessions.db'), format: 'hermes_sqlite' }), { code: 'UnsupportedSchema' })
})

void it('fx preserves checkpoint failure and interruption without reading referenced artifacts', async () => {
  const session = await sessions.parse('fx', { path: fixture('fx/session/session.json'), format: 'fx_json' })
  assertSessionContract(session)
  assert.equal(session.records.length, 2)
  assert.equal(toolResultsOf(session)[0]?.data.isError, true)
  assert.equal(toolCallsOf(session).length, 2)
  assert.equal(eventsOf(session, 'unknown').length, 1)
  assert.ok(session.diagnostics.some(d => d.message.includes('through_seq')))
  assert.ok(session.diagnostics.some(d => d.message.includes('no recorded result')))
})

void it('Devin retains main-chain order, off-chain messages, repeated IDs and complete native nodes', async () => {
  const session = await sessions.parse('devin', { path: fixture('devin/sessions.db'), format: 'devin_sqlite', id: 'devin-session' })
  assertSessionContract(session)
  assert.equal(session.records.length, 6)
  assert.deepEqual(session.records.slice(1).map(r => (r.native as Record<string, unknown>).node_id), [1, 2, 3, 4, 5])
  assert.deepEqual(conversationOf(session).map(e => e.id), ['repeat', 'repeat', 'branch'])
  assert.deepEqual(conversationOf(session).map(e => e.providerMetadata.on_main_chain), [true, true, false])
  assert.equal(eventsOf(session, 'unknown').length, 1)
  assert.equal(toolResultsOf(session)[0]?.data.isError, true)
})

void it('Cline keeps CLI/Desktop native message metadata, embedded tool results and metrics', async () => {
  const session = await sessions.parse('cline', { path: fixture('cline/session/session.json'), format: 'cline_json' })
  assertSessionContract(session)
  assert.equal(session.id, 'cline-session')
  assert.equal(session.metadata.surface, 'desktop')
  assert.equal(session.records.length, 2)
  assert.deepEqual(conversationOf(session).map(e => e.id), ['repeat'])
  assert.deepEqual(toolCallsOf(session)[0]?.timestamp, { format: 'unix_millis', value: 1700000000001 })
  assert.equal(toolResultsOf(session)[0]?.data.isError, true)
  assert.equal(eventsOf(session, 'usage').length, 1)
})

void it('Copilot retains mirrored calls and repeated IDs; Qwen preserves Google parts and usage', async () => {
  const copilot = await sessions.parse('copilot', { path: fixture('copilot/session/events.jsonl') })
  assertSessionContract(copilot)
  assert.equal(copilot.id, 'copilot-session')
  assert.equal(copilot.workspace?.path, '/captured/copilot')
  assert.deepEqual(conversationOf(copilot).map(e => e.id), ['repeat', 'repeat'])
  assert.deepEqual(toolCallsOf(copilot).map(e => e.data.callId), ['call', 'call', 'interrupted'])
  assert.equal(toolResultsOf(copilot)[0]?.data.isError, true)
  const qwen = await sessions.parse('qwen', { path: fixture('qwen/session.jsonl') })
  assertSessionContract(qwen)
  assert.equal(qwen.id, 'qwen-session')
  assert.equal(qwen.title, 'Fixture title')
  assert.equal(toolResultsOf(qwen)[0]?.data.callId, 'call')
  assert.equal(toolResultsOf(qwen)[0]?.data.isError, true)
  assert.equal(conversationOf(qwen)[1]?.data.content[0]?.type, 'image')
  assert.equal(eventsOf(qwen, 'usage').length, 1)
  assert.equal(eventsOf(qwen, 'unknown').length, 1)
})

void it('new JSONL providers retain malformed records and share chunk framing, limits and cancellation', async () => {
  for (const [provider, path] of [['copilot', 'copilot/session/events.jsonl'], ['qwen', 'qwen/session.jsonl'], ['openclaw', 'openclaw/session.jsonl'], ['droid', 'droid/session.jsonl'], ['deepseek', 'deepseek/session/session.v4.jsonl']] as const) {
    const bytes = await readFile(fixture(path))
    async function* chunks() {
      for (let i = 0; i < bytes.length; i += 3)
        yield bytes.subarray(i, i + 3)
    }
    const expected = await sessions.parse(provider, { jsonl: bytes })
    assertSessionContract(expected)
    assert.deepEqual(await sessions.parse(provider, { jsonl: chunks() }), expected)
    const malformed = await sessions.parse(provider, { jsonl: Buffer.concat([Buffer.from('{bad\n'), bytes]) })
    assert.equal(malformed.records.length, expected.records.length + 1)
    assert.equal(eventsOf(malformed, 'unknown')[0]?.data.sourceType, 'malformed_jsonl')
    await assert.rejects(sessions.parse(provider, { jsonl: bytes }, { maxRecordBytes: 20 }), { code: 'CorruptedSession' })
    await assert.rejects(sessions.parse(provider, { jsonl: chunks() }, { signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/)
    const opened = await sessions.open({ ...expected, source: { path: fixture(path), format: 'jsonl' } })
    assert.equal(opened.readMode, 'incremental')
    assert.deepEqual(await opened.snapshot(), await opened.snapshot())
  }
})

void it('JSON snapshot acquisition enforces size, schema, cancellation and native companion identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-snapshot-'))
  t.after(async () => rm(root, { force: true, recursive: true }))
  const path = join(root, 'test.json')
  await writeFile(path, JSON.stringify({ version: 1, session_id: 'root' }))
  await writeFile(join(root, 'test.messages.json'), JSON.stringify({ version: 1, sessionId: 'foreign', messages: [] }))
  for (const id of [undefined, 'caller']) {
    await assert.rejects(sessions.parse('cline', { path, format: 'cline_json', ...(id === undefined ? {} : { id }) }), { code: 'CorruptedSession' })
  }
  await writeFile(join(root, 'test.messages.json'), JSON.stringify({ version: 2, sessionId: 'root', messages: [] }))
  await assert.rejects(sessions.parse('cline', { path, format: 'cline_json' }), { code: 'UnsupportedSchema' })
  for (const [provider, path, format] of [['cline', 'cline/session/session.json', 'cline_json'], ['fx', 'fx/session/session.json', 'fx_json'], ['hermes', 'hermes/session.json', 'hermes_json']] as const) {
    await assert.rejects(sessions.parse(provider, { path: fixture(path), format }, { maxRecordBytes: 20 }), { code: 'CorruptedSession' })
    await assert.rejects(sessions.parse(provider, { path: fixture(path), format }, { signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/)
    await assert.rejects(sessions.parse(provider, { path: fixture(path), format: 'unrecognized' }), { code: 'UnsupportedSchema' })
  }
})

void it('DeepSeek reads generations 0–4, preserves surface edits and packed observations, and retains future events', async () => {
  for (let version = 0; version <= 4; version++) {
    const lines = [
      { type: 'session', version, id: `v${version}`, createdAt: 1700000000000 },
      { type: 'text-chunks', seq0: 0, time0: 1700000000001, data: { texts: ['a', 'b'], dt: [1] } },
      { type: 'reasoning-chunks', seq0: 2, time0: 1700000000003, data: { texts: ['thinking'], dt: [] } },
      { type: 'assistant/message', seq: 3, time: 1700000000004, data: { message: { id: 'same', role: 'assistant', content: [{ type: 'text', text: 'final' }] } }, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 2 }, sourceEventSeqs: [0, 1, 2] },
    ]
    const session = await sessions.parse('deepseek', { jsonl: lines.map(line => JSON.stringify(line)).join('\n') })
    assertSessionContract(session)
    assert.equal(session.id, `v${version}`)
    assert.equal(session.records.length, 4)
    assert.deepEqual(conversationOf(session).map(e => e.data.content), [[{ type: 'text', data: 'a' }], [{ type: 'text', data: 'b' }], [{ type: 'text', data: 'final' }]])
    assert.deepEqual(conversationOf(session)[2]?.providerMetadata.surfaceOp, lines[3]!.surfaceOp)
  }
  const session = await sessions.parse('deepseek', { jsonl: [
    { type: 'session', version: 5, id: 'future' },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'future' }] } },
  ].map(line => JSON.stringify(line)).join('\n') })
  assert.equal(conversationOf(session).length, 0)
  assert.equal(eventsOf(session, 'unknown').length, 1)
  assert.ok(session.diagnostics.some(d => d.code === 'UnsupportedSchema'))
})

void it('new native roots isolate discovery and exclude telemetry and routing indexes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-discovery-'))
  const qwenId = '11111111-1111-1111-1111-111111111111'
  t.after(async () => rm(root, { force: true, recursive: true }))
  for (const [provider, source, target] of [
    ['copilot', 'copilot/session/events.jsonl', '.copilot/session-state/id/events.jsonl'],
    ['openclaw', 'openclaw/session.jsonl', '.openclaw/agents/main/sessions/id.jsonl'],
    ['qwen', 'qwen/session.jsonl', `.qwen/projects/project/chats/${qwenId}.jsonl`],
    ['droid', 'droid/session.jsonl', '.factory/sessions/project/id.jsonl'],
    ['deepseek', 'deepseek/session/session.v4.jsonl', '.dsh/sessions/project/id/session.v4.jsonl'],
    ['cline', 'cline/session/session.json', '.cline/data/sessions/session/session.json'],
    ['fx', 'fx/session/session.json', '.fx/sessions/id/session.json'],
    ['hermes', 'hermes/sessions.db', '.hermes/state.db'],
    ['devin', 'devin/sessions.db', '.local/share/devin/cli/sessions.db'],
  ] as const) {
    const path = join(root, target)
    await mkdir(join(path, '..'), { recursive: true })
    const native = await readFile(fixture(source))
    await writeFile(path, provider === 'qwen' ? native.toString().replaceAll('qwen-session', qwenId) : native)
    const detected = await sessions.require(provider).detect({ homeDir: root })
    assert.equal(detected.available, true)
    assert.ok(detected.roots.every(path => path.startsWith(root)))
    const { refs } = await sessions.scan({ providers: [provider], homeDir: root })
    assert.equal(refs.length, 1)
    assert.equal(refs[0]?.source.path, path)
    assert.deepEqual(await sessions.scan({ providers: [provider], homeDir: root, roots: { [provider]: [] } }), { refs: [], failures: [] })
  }
  await writeFile(join(root, '.qwen/projects/system.jsonl'), '{}')
  await writeFile(join(root, '.openclaw/agents/main/sessions/id.trajectory.jsonl'), '{}')
  await mkdir(join(root, '.hermes/sessions'), { recursive: true })
  await writeFile(join(root, '.hermes/sessions/sessions.json'), '{}')
  for (const provider of ['qwen', 'openclaw', 'hermes'])
    assert.equal((await sessions.scan({ providers: [provider], homeDir: root })).refs.length, 1)
})

void it('snapshot readers preserve malformed evidence and reject absent companions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-json-evidence-'))
  t.after(async () => rm(root, { force: true, recursive: true }))
  const path = join(root, 'malformed.json')
  await writeFile(path, '{broken')
  const session = await sessions.parse('hermes', { path, format: 'hermes_json' })
  assert.equal(session.records[0]?.text, '{broken')
  assert.equal(eventsOf(session, 'unknown')[0]?.data.sourceType, 'malformed_json')
  await assert.rejects(sessions.parse('cline', { path, format: 'cline_json' }), { code: 'SessionNotFound' })
})

void it('OpenClaw reads selected SQLite windows and compressed events through the shared decoder', async () => {
  const session = await sessions.parse('openclaw', { path: fixture('openclaw/openclaw-agent.sqlite'), format: 'openclaw_sqlite', id: 'openclaw-db' })
  assertSessionContract(session)
  assert.equal(session.records.length, 5)
  assert.equal(session.workspace?.path, '/captured/openclaw')
  assert.deepEqual(conversationOf(session).map(e => e.data.content), [[{ type: 'text', data: 'SQLite prompt' }], [{ type: 'text', data: 'SQLite reply' }]])
  assert.deepEqual(conversationOf(session).map(e => e.id), ['repeat', 'repeat'])
  assert.ok('native_bytes' in ((session.records[3]?.native as Record<string, unknown>).event_zstd as object))
  assert.equal(eventsOf(session, 'unknown')[0]?.data.sourceType, 'openclaw_event_json')
  assert.equal((await sessions.open({ ...session })).readMode, 'buffered')
})

void it('DeepSeek selects the newest generation and validates compressed logs without falling back', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-generations-'))
  t.after(async () => rm(root, { force: true, recursive: true }))
  const compressed = fixture('deepseek/compressed/session.v4.jsonl.zstd')
  const { refs } = await sessions.scan({ providers: ['deepseek'], roots: { deepseek: [compressed] } })
  assert.equal(refs[0]?.source.format, 'jsonl_zstd')
  const disk = await sessions.read(refs[0])
  const supplied = await sessions.parse('deepseek', { jsonl: await readFile(fixture('deepseek/session/session.v4.jsonl')) })
  assert.deepEqual(disk.events, supplied.events)
  const encoded = await readFile(compressed)
  await writeFile(join(root, 'session.v4.jsonl.zstd'), encoded)
  await writeFile(join(root, 'session.v3.jsonl'), '{broken\n')
  const { refs: selected } = await sessions.scan({ providers: ['deepseek'], roots: { deepseek: [root] } })
  assert.equal(selected.length, 1)
  assert.equal(selected[0]?.id, 'deepseek-session')
  encoded[encoded.length - 1] = encoded[encoded.length - 1]! ^ 1
  await writeFile(join(root, 'session.v4.jsonl.zstd'), encoded)
  await assert.rejects(sessions.read(selected[0]), { code: 'CorruptedSession' })
  await writeFile(join(root, 'session.v4.jsonl.zstd'), await readFile(compressed))
  await writeFile(join(root, 'session.v5.jsonl'), '{"type":"session","version":5,"id":"future"}\n')
  const { refs: future } = await sessions.scan({ providers: ['deepseek'], roots: { deepseek: [root] } })
  assert.equal(future[0]?.id, 'future')
  assert.ok((await sessions.read(future[0])).diagnostics.some(d => d.code === 'UnsupportedSchema'))
})
void it('DeepSeek reports ambiguous and mismatched generations while retaining independent sessions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-generation-failures-'))
  t.after(async () => rm(root, { force: true, recursive: true }))
  const ambiguous = join(root, 'ambiguous')
  const mismatch = join(root, 'mismatch')
  await mkdir(ambiguous)
  await mkdir(mismatch)
  const log = await readFile(fixture('deepseek/session/session.v4.jsonl'))
  await writeFile(join(ambiguous, 'session.v4.jsonl'), log)
  await writeFile(join(ambiguous, 'session.v4.jsonl.zstd'), await readFile(fixture('deepseek/compressed/session.v4.jsonl.zstd')))
  await writeFile(join(mismatch, 'session.v3.jsonl'), log)
  const result = await sessions.scan({ providers: ['deepseek'], roots: { deepseek: [root, fixture('deepseek/session')] } })
  assert.equal(result.refs.length, 1)
  assert.equal(result.refs[0]!.source.path, fixture('deepseek/session/session.v4.jsonl'))
  assert.deepEqual(result.failures.map(failure => failure.code), ['UnsupportedSchema', 'UnsupportedSchema'])
  assert.deepEqual(result.failures.map(failure => failure.source?.path), [ambiguous, join(mismatch, 'session.v3.jsonl')])
})

void it('Devin does not let a result on an abandoned branch satisfy a main-chain call', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-devin-branches-'))
  t.after(async () => rm(root, { force: true, recursive: true }))
  const path = join(root, 'sessions.db')
  const db = new DatabaseSync(path)
  try {
    db.exec(await readFile(fixture('devin/sessions.sql'), 'utf8'))
    db.prepare('UPDATE message_nodes SET chat_message = ? WHERE node_id = 3').run(JSON.stringify({ role: 'assistant', content: 'No main-chain result' }))
    db.prepare('UPDATE message_nodes SET chat_message = ? WHERE node_id = 4').run(JSON.stringify({ role: 'tool', tool_call_id: 'call', content: 'Abandoned branch result' }))
  }
  finally {
    db.close()
  }
  const session = await sessions.parse('devin', { path, format: 'devin_sqlite', id: 'devin-session' })
  assert.equal(toolResultsOf(session).length, 1)
  assert.ok(session.diagnostics.some(d => d.message.includes('tool call call has no recorded result')))
})

void it('Droid reads headerless stream identity from message records', async () => {
  const session = await sessions.parse('droid', { jsonl: JSON.stringify({ type: 'message', session_id: 'headerless', role: 'user', text: 'Hello' }) })
  assert.equal(session.id, 'headerless')
  assert.equal(session.createdAt, undefined)
  assert.equal(conversationOf(session).length, 1)
})

void it('Droid preserves observed camel/snake aliases, uppercase roles and completion usage', async () => {
  const lines = [
    { type: 'system', sessionId: 'aliases', working_directory: '/captured/droid' },
    { type: 'message', sessionId: 'aliases', role: 'USER', content: 'Do thing' },
    { type: 'toolCall', sessionId: 'aliases', tool_call_id: 'call', name: 'Shell', input: { command: 'echo hi' } },
    { type: 'tool_result', sessionId: 'aliases', tool_call_id: 'call', value: 'done', is_error: 'false' },
    { type: 'completion', sessionId: 'aliases', final: 'all done', usage: { input_tokens: 1 } },
  ]
  const session = await sessions.parse('droid', { jsonl: lines.map(line => JSON.stringify(line)).join('\n') })
  assertSessionContract(session)
  assert.equal(session.id, 'aliases')
  assert.equal(session.workspace?.path, '/captured/droid')
  assert.deepEqual(conversationOf(session).map(e => e.data.content), [[{ type: 'text', data: 'Do thing' }], [{ type: 'text', data: 'all done' }]])
  assert.equal(toolCallsOf(session)[0]?.data.callId, 'call')
  assert.deepEqual(toolCallsOf(session)[0]?.data.arguments, { command: 'echo hi' })
  assert.equal(toolResultsOf(session)[0]?.data.callId, 'call')
  assert.equal(toolResultsOf(session)[0]?.data.isError, false)
  assert.deepEqual(eventsOf(session, 'usage')[0]?.data.usage, lines[4]!.usage)
  assert.deepEqual(session.records.map(r => r.native), lines)
})

void it('Droid retains explicit event call IDs and determines failures from recorded exit codes', async () => {
  const lines = [
    { type: 'system', sessionId: 'numeric', timestamp: 1767812640310 },
    { type: 'tool_call', sessionId: 'numeric', id: 'call_1', toolName: 'Execute', parameters: { command: 'ls' } },
    { type: 'tool_result', sessionId: 'numeric', id: 'call_1', value: { exitCode: 1, stdout: 'missing' } },
  ]
  const session = await sessions.parse('droid', { jsonl: lines.map(line => JSON.stringify(line)).join('\n') })
  assert.equal(toolCallsOf(session)[0]?.data.callId, 'call_1')
  assert.equal(toolResultsOf(session)[0]?.data.callId, 'call_1')
  assert.equal(toolResultsOf(session)[0]?.data.isError, true)
  assert.deepEqual(session.createdAt, { format: 'unix_millis', value: 1767812640310 })
})

void it('Qwen tool-result identity and failure use recorded UI metadata when API parts omit them', async () => {
  const line = { type: 'tool_result', sessionId: 'qwen-error', message: { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'failed' } } }] }, toolCallResult: { callId: 'call', status: 'error' } }
  const session = await sessions.parse('qwen', { jsonl: JSON.stringify(line) })
  assert.equal(toolResultsOf(session)[0]?.data.callId, 'call')
  assert.equal(toolResultsOf(session)[0]?.data.isError, true)
  assert.deepEqual(session.records[0]?.native, line)
})

void it('Copilot maps standalone reasoning and does not invent reasoning from null fields', async () => {
  const lines = [
    { type: 'assistant.reasoning', id: 'r', data: { reasoningId: 'native-r', content: 'Think first' } },
    { type: 'assistant.message', data: { content: 'Done', reasoningText: null, reasoningOpaque: null, encryptedContent: null } },
  ]
  const session = await sessions.parse('copilot', { jsonl: lines.map(line => JSON.stringify(line)).join('\n') })
  assert.deepEqual(eventsOf(session, 'reasoning').map(e => e.data), [{ text: 'Think first' }])
  assert.equal(eventsOf(session, 'reasoning')[0]?.id, 'r')
  assert.equal(conversationOf(session).length, 1)
})

void it('independent compatibility artifacts retain their pinned provenance and hashes', async () => {
  const source = JSON.parse(await readFile(compatibility('sources.json'), 'utf8')) as { commit: string, files: { path: string, sha256: string }[] }
  assert.equal(source.commit, 'b7893c772b0014918211f1c45a5ab58add229703')
  assert.equal(source.files.length, 34)
  for (const entry of source.files)
    assert.equal(createHash('sha256').update(await readFile(compatibility(entry.path))).digest('hex'), entry.sha256, entry.path)
})

void it('captured Kimi loop journal exposes assistant, reasoning, tool pairs and ID-less state facts', async (t) => {
  const jsonl = await readFile(compatibility('kimi/assistant_tools.jsonl'), 'utf8')
  const session = await sessions.parse('kimi', { jsonl })
  assertSessionContract(session)
  assert.equal(session.records.length, 200)
  assert.equal(eventsOf(session, 'assistant_message').length, 6)
  assert.equal(eventsOf(session, 'reasoning').length, 22)
  assert.equal(toolCallsOf(session).length, 19)
  assert.equal(toolResultsOf(session).length, 19)
  assert.equal(toolResultsOf(session).filter(e => e.data.isError).length, 1)
  assert.deepEqual(toolCallsOf(session).map(e => e.data.callId), toolResultsOf(session).map(e => e.data.callId))
  assert.equal(eventsOf(session, 'unknown').length, 0)
  assert.equal(session.records.map(r => r.text).join(''), jsonl)
  const root = await mkdtemp(join(tmpdir(), 'huihua-kimi-native-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'native/agents/main/wire.jsonl')
  await mkdir(join(root, 'native/agents/main'), { recursive: true })
  await writeFile(path, jsonl)
  const state = JSON.parse(await readFile(compatibility('kimi/assistant_tools.state.json'), 'utf8')) as { title: string, workDir: string, createdAt: string }
  await writeFile(join(root, 'native/state.json'), JSON.stringify(state))
  const scanned = await sessions.scan({ providers: ['kimi'], roots: { kimi: [root] } })
  assert.deepEqual(scanned.failures, [])
  assert.equal(scanned.refs[0]?.title, state.title)
  const read = await sessions.read(scanned.refs[0])
  assert.equal(read.workspace?.path, state.workDir)
  assert.deepEqual(read.createdAt, { format: 'rfc3339', value: state.createdAt })
  assert.equal(read.metadata.id_origin, 'source_locator')
})
void it('Kimi loop image parts use the same native media mapping as context messages', async () => {
  const part = { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AA==' } }
  const records = [{ type: 'context.append_message', message: { role: 'assistant', content: [part] } }, { type: 'context.append_loop_event', event: { type: 'content.part', part } }]
  const session = await sessions.parse('kimi', { jsonl: records.map(r => JSON.stringify(r)).join('\n') })
  assert.deepEqual(conversationOf(session).map(e => e.data.content), [[{ type: 'image', data: { uri: part.imageUrl.url, metadata: part } }], [{ type: 'image', data: { uri: part.imageUrl.url, metadata: part } }]])
})

void it('Cursor observed CLI tool aliases retain native blocks and expose tool events', async () => {
  const session = await sessions.parse('cursor', { path: compatibility('cursor/schema_drift.jsonl') })
  assertSessionContract(session)
  assert.equal(toolCallsOf(session).length, 1)
  assert.deepEqual(toolCallsOf(session)[0]?.data, { toolName: 'read_file', arguments: { path: 'build.log' } })
  assert.equal(toolResultsOf(session).length, 1)
  assert.equal(toolResultsOf(session)[0]?.data.toolName, 'read_file')
  assert.deepEqual(toolResultsOf(session)[0]?.data.result, [{ type: 'text', text: 'Compile failed in Example.swift:42' }])
  assert.equal(session.records.length, 4)
})

void it('Hermes recorded finish_reason error is a failed tool result', async () => {
  const session = await sessions.parse('hermes', { path: compatibility('hermes/schema_drift.json'), format: 'hermes_json' })
  assertSessionContract(session)
  assert.equal(toolResultsOf(session).find(e => objectResult(e.data.result).finish_reason === 'error')?.data.isError, true)
})
function objectResult(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

void it('DeepSeek v2/v3 native result wrappers and explicit parent preserve identity and failures', async () => {
  for (const version of [2, 3]) {
    const records = [
      { type: 'session', version, id: 'child', parentSession: 'parent', origin: 'subagent', delegationDepth: 1 },
      { type: 'tool/call', time: 1, data: { callId: 'call', name: 'read', arguments: { path: 'a' } } },
      { type: 'tool/result', time: 2, data: { message: { id: 'result', role: 'user', source: { kind: 'tool', callId: 'call' }, content: [{ type: 'tool-result', toolCallId: 'call', content: [{ type: 'text', text: 'failed' }], isError: true }] } } },
    ]
    const session = await sessions.parse('deepseek', { jsonl: records.map(r => JSON.stringify(r)).join('\n') })
    assertSessionContract(session)
    assert.equal(session.parentSessionId, 'parent')
    assert.equal(toolResultsOf(session)[0]?.data.callId, 'call')
    assert.equal(toolResultsOf(session)[0]?.data.isError, true)
    assert.deepEqual(session.records.map(r => r.native), records)
    assert.ok(!session.diagnostics.some(d => d.message.includes('no recorded result')))
  }
})

void it('Droid camel tool-result role and event preserve pairs and workspace aliases', async () => {
  const rows = [
    { type: 'session_start', sessionId: 'native', workingDirectory: '/recorded' },
    { type: 'toolCall', toolCallId: 'a', toolName: 'read', input: {} },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'a', content: 'ok' } },
    { type: 'toolCall', toolCallId: 'b', toolName: 'read', input: {} },
    { type: 'toolResult', toolCallId: 'b', value: { exitCode: 1 } },
  ]
  const session = await sessions.parse('droid', { jsonl: rows.map(r => JSON.stringify(r)).join('\n') })
  assertSessionContract(session)
  assert.equal(session.workspace?.path, '/recorded')
  assert.deepEqual(toolResultsOf(session).map(e => [e.data.callId, e.data.isError]), [['a', false], ['b', true]])
  assert.deepEqual(session.records.map(r => r.native), rows)
  assert.deepEqual(session.diagnostics, [])
})

void it('Copilot tokenDetails-only shutdown retains summary usage without request invention', async () => {
  const native = { type: 'session.shutdown', data: { tokenDetails: { inputTokens: 11, outputTokens: 7 } } }
  const session = await sessions.parse('copilot', { jsonl: JSON.stringify(native) })
  assertSessionContract(session)
  assert.deepEqual(eventsOf(session, 'usage').map(e => e.data.usage), [native.data])
  assert.equal(eventsOf(session, 'system').length, 1)
  assert.deepEqual(session.records[0]?.native, native)
})

void it('Codex historical chat and function aliases retain normalized facts and raw records', async () => {
  const session = await sessions.parse('codex', { path: compatibility('codex/schema_drift.jsonl') })
  assertSessionContract(session)
  assert.equal(conversationOf(session).length, 2)
  assert.deepEqual(toolCallsOf(session)[0]?.data, { toolName: 'translate', arguments: { text: 'hello', to: 'es' } })
  assert.equal(toolResultsOf(session)[0]?.data.result, 'hola')
  assert.equal(eventsOf(session, 'unknown').length, 1)
  const large = await sessions.parse('codex', { path: compatibility('codex/large.jsonl') })
  assert.equal(toolCallsOf(large)[0]?.data.toolName, 'run_shell_command')
  assert.deepEqual(toolResultsOf(large)[0]?.data.result, { stdout: 'line1\nline2\nline3\n', stderr: '', exitCode: 0 })
})

void it('Codex nested native subagent lineage and turn summaries remain explicit observations', async () => {
  const rows = [
    { type: 'session_meta', payload: { id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } } },
    { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } },
  ]
  const session = await sessions.parse('codex', { jsonl: rows.map(r => JSON.stringify(r)).join('\n') })
  assert.equal(session.parentSessionId, 'parent')
  assert.deepEqual(eventsOf(session, 'usage')[0]?.data.usage, rows[1])
  assert.deepEqual(session.records.map(r => r.native), rows)
})

void it('Claude explicit historical top-level tools preserve supplied names and outputs', async () => {
  const rows = [{ type: 'tool_call', sessionId: 'native', name: 'read', input: { path: 'a' } }, { type: 'tool_result', sessionId: 'native', name: 'read', output: 'failed', is_error: true }]
  const session = await sessions.parse('claude', { jsonl: rows.map(r => JSON.stringify(r)).join('\n') })
  assertSessionContract(session)
  assert.deepEqual(toolCallsOf(session)[0]?.data, { toolName: 'read', arguments: { path: 'a' } })
  assert.deepEqual(toolResultsOf(session)[0]?.data, { toolName: 'read', result: 'failed', isError: true })
  assert.deepEqual(session.records.map(r => r.native), rows)
})

void it('Qwen display-only result and runtime user subtype keep their explicit provenance', async () => {
  const result = { type: 'tool_result', toolCallResult: { callId: 'call', name: 'read', status: 'error', resultDisplay: { text: 'failed' } } }
  const notifications = ['notification', 'cron', 'goal_runtime'].map(subtype => ({ type: 'user', subtype, message: { parts: [{ text: 'runtime notification' }] } }))
  const session = await sessions.parse('qwen', { jsonl: [result, ...notifications].map(r => JSON.stringify(r)).join('\n') })
  assertSessionContract(session)
  assert.deepEqual(toolResultsOf(session)[0]?.data, { callId: 'call', toolName: 'read', result: { text: 'failed' }, isError: true })
  assert.equal(toolResultsOf(session)[0]?.providerMetadata.result_origin, 'resultDisplay')
  assert.equal(eventsOf(session, 'system').length, 3)
  assert.equal(eventsOf(session, 'user_message').length, 0)
  const nativeResponse = { name: 'read', response: { text: 'model-facing result' } }
  const paired = await sessions.parse('qwen', { jsonl: JSON.stringify({ ...result, message: { parts: [{ functionResponse: nativeResponse }] } }) })
  assert.equal(toolResultsOf(paired).length, 1)
  assert.deepEqual(toolResultsOf(paired)[0]?.data.result, nativeResponse.response)
})

void it('Antigravity captured CLI steps preserve planner output, calls, outcomes and truncation', async () => {
  const session = await sessions.parse('antigravity', { path: compatibility('antigravity/cli_small.jsonl') })
  assertSessionContract(session)
  assert.equal(session.records.length, 19)
  assert.equal(eventsOf(session, 'user_message').length, 2)
  assert.equal(eventsOf(session, 'assistant_message').length, 1)
  assert.equal(eventsOf(session, 'reasoning').length, 3)
  assert.deepEqual(toolCallsOf(session).map(e => e.data.toolName), ['list_dir', 'write_file'])
  assert.equal(toolResultsOf(session).length, 8)
  assert.ok(toolResultsOf(session).every(e => e.data.callId === undefined))
  assert.equal(session.diagnostics.filter(d => d.message.includes('truncated')).length, 8)
  assert.equal((await sessions.open(session)).readMode, 'incremental')
  const supplied = await sessions.parse('antigravity', { jsonl: await readFile(compatibility('antigravity/cli_small.jsonl'), 'utf8') })
  assert.deepEqual(supplied.events, session.events)
})

void it('Grok captured chat history retains message models, reasoning and tools independently of journals', async () => {
  const session = await sessions.parse('grok', { path: compatibility('grok/chat_history.jsonl') })
  assertSessionContract(session)
  assert.equal(session.id, '019f6851-7ec4-7ef0-97d3-03f3eee38755')
  assert.equal(toolCallsOf(session).length, 2)
  assert.equal(toolResultsOf(session).length, 2)
  assert.equal(eventsOf(session, 'reasoning').length, 2)
  assert.ok(eventsOf(session, 'assistant_message').every(e => e.data.model === 'grok-4.5'))
  assert.equal(eventsOf(session, 'unknown').length, 3)
  assert.ok(session.records.some(r => r.source.path.endsWith('summary.json')))
})
void it('fx optional display title and preferences remain native sidecar facts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-fx-display-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  for (const name of ['session.json', 'checkpoint.json'])
    await writeFile(join(root, name), await readFile(compatibility(`fx/${name}`)))
  const display = { title: 'Recorded title', preview: 'Recorded preview' }
  await writeFile(join(root, 'display.json'), JSON.stringify(display))
  const session = await sessions.parse('fx', { path: join(root, 'session.json'), format: 'fx_json' })
  assertSessionContract(session)
  assert.equal(session.title, display.title)
  assert.deepEqual(session.records.find(r => r.source.path.endsWith('display.json'))?.native, display)
  assert.equal(session.records.length, 3)
  assert.deepEqual(session.metadata.preferences, { model: 'demo/model-1', effort: 'auto', fast_mode: false })
  assert.ok(eventsOf(session, 'system').some(e => e.data.sourceType === 'compacted_summary'))
  assert.ok(session.records.some(r => JSON.stringify(r.native).includes('background_command')))
  assert.ok(session.diagnostics.some(d => d.message.includes('through_seq')))
  const scan = await sessions.scan({ providers: ['fx'], roots: { fx: [root] } })
  assert.deepEqual(scan.failures, [])
  assert.equal(scan.refs[0]?.title, display.title)
})
void it('Devin sibling user images become canonical media without losing native dimensions and bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-devin-image-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'sessions.db')
  const producer = new DatabaseSync(path)
  producer.exec(await readFile(fixture('devin/sessions.sql'), 'utf8'))
  const message = { role: 'user', content: 'inspect image', images: [{ width: 2, height: 1, base64_data: 'AAEC' }] }
  producer.prepare('UPDATE message_nodes SET chat_message = ? WHERE node_id = 1').run(JSON.stringify(message))
  producer.close()
  const scan = await sessions.scan({ providers: ['devin'], roots: { devin: [path] } })
  const session = await sessions.read(scan.refs[0]!)
  assertSessionContract(session)
  const media = conversationOf(session).flatMap(e => e.data.content).filter(b => b.type === 'image')
  assert.deepEqual(media, [{ type: 'image', data: { data: 'AAEC', metadata: message.images[0] } }])
  assert.ok(session.records.some(r => (r.native as { chat_message?: string }).chat_message === JSON.stringify(message)))
})

void it('independent Copilot corpus preserves native evidence, mirrored arguments and standalone reasoning', async () => {
  const path = compatibility('copilot/small.jsonl')
  const session = await sessions.parse('copilot', { path })
  assertSessionContract(session)
  assert.equal(session.id, 'copilot_stage0_small')
  assert.equal(session.workspace?.path, '/tmp/repo')
  assert.deepEqual(toolCallsOf(session).slice(0, 2).map(e => e.data), [
    { callId: 'call-1', toolName: 'shell', arguments: '{"command":"ls"}' },
    { callId: 'call-1', toolName: 'shell', arguments: { command: 'ls' } },
  ])
  assert.equal(eventsOf(session, 'reasoning').filter(e => e.providerMetadata.type === 'assistant.reasoning').length, 1)
  assert.deepEqual(session.records.map(r => r.native), (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown))
})

void it('independent Hermes snapshot preserves messages, reasoning, arguments and unknown roles', async () => {
  const session = await sessions.parse('hermes', { path: compatibility('hermes/large.json'), format: 'hermes_json' })
  assertSessionContract(session)
  assert.equal(session.id, '20260429_hermes_large')
  assert.equal(session.workspace?.path, '~/Repository/Codex-History')
  assert.equal(conversationOf(session).length, 3)
  assert.deepEqual(eventsOf(session, 'reasoning')[0]?.data, { text: 'Need a shell lookup.' })
  assert.equal(toolCallsOf(session)[0]?.data.arguments, '{"command":"pwd"}')
  assert.equal(toolResultsOf(session)[0]?.data.callId, 'call_001')
  assert.equal(eventsOf(session, 'unknown')[0]?.data.sourceType, 'chat_message')
})

void it('independent OpenClaw JSONL preserves Pi message parts, IDs, usage and tool results', async () => {
  const session = await sessions.parse('openclaw', { path: compatibility('openclaw/small.jsonl') })
  assertSessionContract(session)
  assert.equal(session.id, 'openclaw-stage0-small')
  assert.deepEqual(conversationOf(session).map(e => e.id), ['m1', 'm2'])
  assert.deepEqual(toolCallsOf(session)[0]?.data, { callId: 'tc1', toolName: 'shell_exec', arguments: { command: 'ls' } })
  assert.equal(toolResultsOf(session)[0]?.data.callId, 'tc1')
  assert.equal(toolResultsOf(session)[0]?.data.isError, false)
  assert.equal(eventsOf(session, 'usage').length, 1)
})

void it('independent Qwen corpus keeps Google tools, reasoning and recorded hook context', async () => {
  const session = await sessions.parse('qwen', { path: compatibility('qwen/session.jsonl') })
  assertSessionContract(session)
  assert.equal(session.id, '019f0000-0000-7000-8000-000000000001')
  assert.equal(session.records.length, 6)
  assert.equal(toolCallsOf(session)[0]?.data.callId, 'synthetic-call-1')
  assert.equal(toolResultsOf(session)[0]?.data.callId, 'synthetic-call-1')
  assert.equal(eventsOf(session, 'reasoning')[0]?.data.text, 'I should read the synthetic file.')
  assert.deepEqual(conversationOf(session)[1]?.data.content, [{ type: 'text', data: '<qwen:user-prompt-submit-context>\nSynthetic hook context that is not the user\'s prompt.\n</qwen:user-prompt-submit-context>' }])
})

void it('independent Devin logical payloads retain flat tool arguments and native message identities', async (t) => {
  const native = JSON.parse(await readFile(compatibility('devin/small.json'), 'utf8')) as { session: { id: string, title: string, working_directory: string, created_at: number, last_activity_at: number }, nodes: { message_id: string }[] }
  const root = await mkdtemp(join(tmpdir(), 'huihua-devin-corpus-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'sessions.db')
  const db = new DatabaseSync(path)
  try {
    db.exec(await readFile(fixture('devin/sessions.sql'), 'utf8'))
    db.exec('DELETE FROM sessions; DELETE FROM message_nodes')
    const s = native.session
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(s.id, s.title, s.working_directory, s.created_at, s.last_activity_at, native.nodes.length, 0)
    for (const [i, message] of native.nodes.entries())
      db.prepare('INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?, ?)').run(i + 1, s.id, i + 1, i === 0 ? null : i, JSON.stringify(message), null)
  }
  finally {
    db.close()
  }
  const session = await sessions.parse('devin', { path, format: 'devin_sqlite', id: native.session.id })
  assertSessionContract(session)
  assert.deepEqual(session.records.slice(1).map(r => JSON.parse((r.native as { chat_message: string }).chat_message) as unknown), native.nodes)
  assert.deepEqual(conversationOf(session).map(e => e.id), ['m2', 'm3'])
  assert.deepEqual(toolCallsOf(session)[0]?.data, { callId: 'call_1', toolName: 'read_file', arguments: { path: 'hello.py' } })
  assert.equal(toolResultsOf(session)[0]?.data.callId, 'call_1')
  assert.equal(eventsOf(session, 'reasoning')[0]?.data.text, 'I should read it first.')
})

void it('independent fx checkpoint keeps manifest identity, interrupted calls and string arguments', async () => {
  const session = await sessions.parse('fx', { path: compatibility('fx/session.json'), format: 'fx_json' })
  assertSessionContract(session)
  assert.equal(session.id, '1787261000000-1787261000000000000-0000000000000001')
  assert.equal(session.workspace?.path, '/Users/fx-demo/Projects/alpha')
  assert.equal(conversationOf(session).filter(e => e.type === 'user_message').length, 4)
  assert.equal(toolCallsOf(session).length, 5)
  assert.equal(toolCallsOf(session)[0]?.data.arguments, '{"path":"."}')
  assert.deepEqual(toolResultsOf(session)[0]?.timestamp, { format: 'unix_millis', value: 1787261100000 })
  assert.ok(session.diagnostics.some(d => d.message.includes('call_fixture_002 has no recorded result')))
  assert.ok(session.diagnostics.some(d => d.message.includes('through_seq')))
})

void it('independent Cline artifacts preserve adjacent messages, failed user-block results and usage', async () => {
  const session = await sessions.parse('cline', { path: compatibility('cline/cline-cli-tool.json'), format: 'cline_json' })
  assertSessionContract(session)
  assert.equal(session.id, 'cline-cli-tool')
  assert.equal(session.title, 'Inspect the fixture file')
  assert.equal(session.metadata.surface, 'cli')
  assert.equal(toolCallsOf(session)[0]?.data.callId, 'cline-tool-1')
  assert.equal(toolResultsOf(session)[0]?.data.isError, true)
  assert.equal(toolResultsOf(session)[0]?.data.result, 'fixture line one')
  assert.equal(eventsOf(session, 'usage').length, 1)
  assert.equal(eventsOf(session, 'reasoning')[0]?.data.text, 'I should read the requested fixture file.')
})

void it('independent Droid store and headerless stream keep native call/result pairs', async () => {
  for (const [path, id, call] of [['session_store_small.jsonl', 'droid_s1', 'tu1'], ['stream_json_small.jsonl', 'sid_stage0_small', 'c1']] as const) {
    const session = await sessions.parse('droid', { path: compatibility(`droid/${path}`) })
    assertSessionContract(session)
    assert.equal(session.id, id)
    assert.equal(session.records.length, 4)
    assert.equal(toolCallsOf(session)[0]?.data.callId, call)
    assert.equal(toolResultsOf(session)[0]?.data.callId, call)
  }
})

void it('independently validated DeepSeek v0-v4 plain and checksummed frames share evidence and facts', async () => {
  for (let version = 0; version <= 4; version++) {
    const path = compatibility(`deepseek/v${version}_${version === 4 ? 'tool' : 'minimal'}_session.jsonl`)
    const plain = await sessions.parse('deepseek', { path })
    const compressed = await sessions.parse('deepseek', { path: `${path}.zstd`, format: 'jsonl_zstd' })
    assertSessionContract(plain)
    assertSessionContract(compressed)
    assert.equal(plain.id, `dsh-synth-v${version}${version === 4 ? '-tool' : ''}-0001`)
    assert.equal(plain.metadata.version, version)
    assert.equal(plain.workspace?.path, '/tmp/synthetic-dsh-demo')
    assert.deepEqual(compressed.events, plain.events)
    assert.deepEqual(compressed.records.map(r => r.native), plain.records.map(r => r.native))
    assert.equal(eventsOf(plain, 'unknown').length, 0)
    if (version >= 2)
      assert.equal(toolResultsOf(plain).length, 1)
    if (version === 4) {
      assert.deepEqual(toolCallsOf(plain).map(e => e.data.callId), ['call-v4-1', 'call-v4-1'])
      assert.equal(toolResultsOf(plain)[0]?.data.callId, 'call-v4-1')
    }
  }
})

void it('the public ingest kit builds a conforming third-party JSONL provider', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-ingest-'))
  t.after(async () => rm(root, { force: true, recursive: true }))
  await writeFile(join(root, 'session.jsonl'), [
    { type: 'session_meta', id: 'kit-session' },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }], timestamp: '2026-01-01T00:00:00Z' },
    '{broken',
  ].map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n'))
  for (const name of ['Ingestion', 'openFrom', 'jsonlProvider', 'jsonStoreProvider', 'sqliteStoreProvider', 'scanSource', 'jsonLines', 'jsonLinesFrom', 'header', 'readJson', 'files', 'exists', 'isDirectory', 'canonicalPath', 'pathMatcher', 'ioError', 'ioErrorOf', 'positiveLimit', 'scanFailure', 'contentBlocks', 'messageEvents', 'chatMessageEvents', 'joinedText', 'array', 'object', 'optional', 'string', 'timestamp'])
    assert.equal(typeof (ingest as unknown as Record<string, unknown>)[name], 'function', name)
  const provider = ingest.jsonlProvider({
    id: 'kit',
    roots: () => [root],
    metadata: records => ({
      ...ingest.optional('id', ingest.string(records.map(ingest.object).find(record => ingest.string(record.type) === 'session_meta')?.id)),
    }),
    parse: (lines, native) => {
      const record = ingest.object(native)
      if (ingest.string(record.type) === 'session_meta')
        lines.emit('system', { sourceType: 'session_meta', payload: record })
      else
        ingest.chatMessageEvents(lines, native)
    },
  })
  const registry = createSessionRegistry([provider])
  const { refs, failures } = await registry.scan()
  assert.deepEqual(failures, [])
  assert.equal(refs.length, 1)
  const opened = await registry.open(refs[0]!)
  assert.equal(opened.readMode, 'incremental')
  const session = await opened.snapshot()
  assertSessionContract(session)
  assert.equal(session.id, 'kit-session')
  assert.deepEqual(conversationOf(session).map(e => e.data.content), [
    [{ type: 'text', data: 'hi' }],
    [{ type: 'text', data: 'hello' }],
  ])
  assert.equal(eventsOf(session, 'unknown')[0]?.data.sourceType, 'malformed_jsonl')
  assert.equal(millisOf(conversationOf(session)[1]?.timestamp), Date.parse('2026-01-01T00:00:00Z'))
  assert.equal(millisOf({ format: 'unix_millis', value: 42 }), 42)
  assert.equal(millisOf({ format: 'rfc3339', value: 'not a date' }), undefined)
  assert.equal(millisOf(undefined), undefined)
})
