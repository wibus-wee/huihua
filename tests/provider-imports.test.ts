import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it } from 'node:test'

import { conversationOf, eventsOf, fileChangesOf, sessions, toolCallsOf, toolResultsOf } from '../src/index.ts'
import { assertSessionContract } from '../src/testing/index.ts'

const fixture = (path: string) => resolve('fixtures', path)

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
  const refs = await sessions.scan({ providers: ['morph'], roots: { morph: [fixture('morph/store')] } })
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
