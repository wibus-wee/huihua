import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it } from 'node:test'

import type { ScanEvent, Session, SessionEvent, SessionRef } from '../src/index.ts'
import {
  createSessionRegistry,
  defineProvider,
  jsonOf,
  SESSION_SCHEMA,
  SessionError,
  sessions,
} from '../src/index.ts'
import {
  conversationOf,
  eventsOf,
  fileChangesOf,
  subagentsOf,
  toolCallsOf,
  toolResultsOf,
} from '../src/observe/index.ts'
import { files } from '../src/shared/paths.ts'
import { scanSource } from '../src/shared/scan.ts'
import { assertSessionContract } from '../src/testing/index.ts'

async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'huihua-test-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  return root
}
function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof SessionError && error.code === code
}
void it('scan preserves other providers when a database cannot be scanned', async (t) => {
  const damaged = join(await directory(t), 'damaged.db')
  await writeFile(damaged, Buffer.alloc(100))
  const result = await sessions.scan({
    providers: ['codex', 'cursor', 'pi'],
    roots: {
      codex: [resolve('fixtures/codex/simple.jsonl')],
      cursor: [damaged],
      pi: [resolve('fixtures/pi/simple.jsonl')],
    },
  })
  assert.deepEqual(result.refs.map(ref => ref.provider), ['codex', 'pi'])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]!.provider, 'cursor')
  assert.equal(result.failures[0]!.scope, 'source')
  assert.deepEqual(result.failures[0]!.source, { path: damaged, format: 'cursor_sqlite' })
  assert.equal(result.failures[0]!.code, 'UnsupportedSchema')
})
void it('scan continues Cursor sources after a damaged database', async (t) => {
  const damaged = join(await directory(t), 'damaged.db')
  await writeFile(damaged, Buffer.alloc(100))
  const result = await sessions.scan({
    providers: ['cursor'],
    roots: { cursor: [resolve('fixtures/cursor/ide-current.db'), damaged, resolve('fixtures/cursor/simple.jsonl')] },
  })
  assert.deepEqual(result.refs.map(ref => ref.source.format).sort(), ['cursor_sqlite', 'jsonl'])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]!.source?.path, damaged)
})
void it('scan reports a denied directory and continues its siblings and later roots', async (t) => {
  const root = await directory(t)
  const denied = join(root, 'a-denied')
  await mkdir(denied)
  await writeFile(join(root, 'b-readable.jsonl'), '{"type":"session_meta","payload":{"id":"sibling"}}\n')
  const original = fs.readdir
  const cause = Object.assign(new Error('denied'), { code: 'EACCES', syscall: 'scandir' })
  t.mock.method(fs, 'readdir', async (path: string, options: { withFileTypes: true }) => {
    if (path === denied)
      throw cause
    return original(path, options)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const result = await sessions.scan({ providers: ['codex'], roots: { codex: [root, resolve('fixtures/codex/simple.jsonl')] } })
  assert.equal(result.refs.length, 2)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]!.code, 'PermissionDenied')
  assert.deepEqual(result.failures[0]!.source, { path: denied })
  assert.equal((result.failures[0]!.cause as SessionError).cause, cause)
  await assert.rejects(async () => {
    for await (const path of files([root], () => true)) void path
  }, hasCode('PermissionDenied'))
})
void it('scan reports the failing companion path and continues independent JSONL sources', async (t) => {
  const root = await directory(t)
  const transcript = join(root, 'blocked/updates.jsonl')
  const companion = join(root, 'blocked/summary.json')
  await mkdir(join(root, 'blocked'))
  await writeFile(transcript, '{}\n')
  const original = fs.stat
  const cause = Object.assign(new Error('companion denied'), { code: 'EACCES', syscall: 'stat' })
  t.mock.method(fs, 'stat', async (path: string) => {
    if (path === companion)
      throw cause
    return original(path)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const result = await sessions.scan({ providers: ['grok'], roots: { grok: [transcript, resolve('fixtures/grok/session/updates.jsonl')] } })
  assert.equal(result.refs.length, 1)
  assert.equal(result.refs[0]!.source.path, resolve('fixtures/grok/session/updates.jsonl'))
  assert.equal(result.failures.length, 1)
  assert.deepEqual(result.failures[0]!.source, { path: companion })
  assert.equal(result.failures[0]!.code, 'PermissionDenied')
})
void it('scan isolates an unexpected provider exception and closes its yielded prefix', async () => {
  const cause = new Error('adapter invariant failed')
  const ref: SessionRef = { id: 'kept', provider: 'custom', source: { path: 'memory', format: 'custom' }, metadata: {} }
  let closed = false
  const provider = defineProvider({
    id: 'custom',
    async detect() { return { provider: 'custom', roots: [], available: true } },
    async* scan(): AsyncGenerator<ScanEvent> {
      try {
        yield { type: 'ref', ref }
        throw cause
      }
      finally { closed = true }
    },
    async read() { throw new Error('unexpected read') },
  })
  const registry = createSessionRegistry([provider, sessions.require('codex')])
  const result = await registry.scan({ roots: { codex: [resolve('fixtures/codex/simple.jsonl')] } })
  assert.equal(closed, true)
  assert.deepEqual(result.refs.map(ref => ref.provider), ['codex', 'custom'])
  assert.deepEqual(result.failures, [{ provider: 'custom', scope: 'provider', code: 'Unknown', message: cause.message, cause }])
})
void it('scanStream is lazy, retains discovery order and source identity, and closes on early return', async () => {
  let started = 0
  let closed = 0
  const first: SessionRef = { id: 'repeated', provider: 'custom', source: { path: 'z', format: 'custom', locator: { id: '1' } }, metadata: {} }
  const second: SessionRef = { ...first, source: { ...first.source, path: 'a' } }
  const failure = { provider: 'custom', scope: 'provider' as const, code: 'UnsupportedSchema' as const, message: 'explicit provider failure' }
  const provider = defineProvider({
    id: 'custom',
    async detect() { return { provider: 'custom', roots: [], available: true } },
    async* scan(): AsyncGenerator<ScanEvent> {
      started++
      try {
        yield { type: 'ref', ref: first }
        yield { type: 'ref', ref: { ...first, title: 'same source' } }
        yield { type: 'failure', failure }
        yield { type: 'ref', ref: second }
      }
      finally { closed++ }
    },
    async read() { throw new Error('unexpected read') },
  })
  const registry = createSessionRegistry([provider])
  const stream = registry.scanStream()
  assert.equal(started, 0)
  assert.deepEqual(await stream.next(), { done: false, value: { type: 'ref', ref: first } })
  await stream.return(undefined)
  assert.equal(started, 1)
  assert.equal(closed, 1)
  const events: ScanEvent[] = []
  for await (const event of registry.scanStream()) events.push(event)
  assert.deepEqual(events, [{ type: 'ref', ref: first }, { type: 'failure', failure }, { type: 'ref', ref: second }])
  assert.deepEqual(await registry.scan(), { refs: [second, first], failures: [failure] })
  assert.equal(closed, 3)
})
void it('scan rejects invalid requests before entering providers, including empty registries', async () => {
  let started = false
  const provider = defineProvider({
    id: 'custom',
    async detect() { return { provider: 'custom', roots: [], available: false } },
    async* scan(): AsyncGenerator<ScanEvent> {
      started = true
    },
    async read() { throw new Error('unexpected read') },
  })
  const registry = createSessionRegistry([provider])
  await assert.rejects(registry.scan({ providers: ['custom', 'missing'] }), hasCode('ProviderNotFound'))
  for (const headerBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(registry.scan({ headerBytes }), RangeError)
    await assert.rejects(createSessionRegistry().scan({ headerBytes }), RangeError)
  }
  const cause = new SessionError('IOError', 'caller cancelled')
  await assert.rejects(registry.scan({ signal: AbortSignal.abort(cause) }), error => error === cause)
  assert.equal(started, false)
})
void it('scan cancellation after a ref propagates its reason and stops later providers', async () => {
  const controller = new AbortController()
  const reason = new SessionError('IOError', 'caller cancelled')
  let closed = false
  let laterStarted = false
  const ref: SessionRef = { id: 's', provider: 'custom', source: { path: 'memory', format: 'custom' }, metadata: {} }
  const provider = defineProvider({
    id: 'custom',
    async detect() { return { provider: 'custom', roots: [], available: true } },
    async* scan(): AsyncGenerator<ScanEvent> {
      try {
        yield { type: 'ref', ref }
        controller.abort(reason)
        throw new Error('masked cancellation')
      }
      finally { closed = true }
    },
    async read() { throw new Error('unexpected read') },
  })
  const later = defineProvider({
    ...provider,
    id: 'later',
    async* scan(): AsyncGenerator<ScanEvent> {
      laterStarted = true
    },
  })
  const events: ScanEvent[] = []
  await assert.rejects(async () => {
    for await (const event of createSessionRegistry([provider, later]).scanStream({ signal: controller.signal })) events.push(event)
  }, error => error === reason)
  assert.deepEqual(events, [{ type: 'ref', ref }])
  assert.equal(closed, true)
  assert.equal(laterStarted, false)
})
void it('scan source boundaries distinguish native I/O, unknown adapter errors and cancellation', async () => {
  const source = { path: 'native.jsonl', format: 'jsonl' }
  const native = Object.assign(new Error('read denied'), { code: 'EACCES', syscall: 'read' })
  const errors: unknown[] = [native, new Error('adapter bug'), undefined]
  for (const cause of errors) {
    const stream = scanSource('custom', source, {}, async function* (): AsyncGenerator<ScanEvent> {
      throw cause
    })
    if (cause === native) {
      const events: ScanEvent[] = []
      for await (const event of stream) events.push(event)
      assert.equal(events.length, 1)
      assert.equal(events[0]?.type, 'failure')
      if (events[0]?.type === 'failure') {
        assert.equal(events[0].failure.code, 'PermissionDenied')
        assert.equal((events[0].failure.cause as SessionError).cause, native)
      }
    }
    else {
      await assert.rejects(async () => {
        for await (const event of stream) void event
      }, error => error === cause)
    }
  }
  const controller = new AbortController()
  const reason = new SessionError('CorruptedSession', 'cancel source')
  const stream = scanSource('custom', source, { signal: controller.signal }, async function* (): AsyncGenerator<ScanEvent> {
    controller.abort(reason)
    throw reason
  })
  await assert.rejects(async () => {
    for await (const event of stream) void event
  }, error => error === reason)
})
void it('scanStream propagates consumer throw and early-return cleanup errors without failure events', async () => {
  const reason = new SessionError('IOError', 'consumer stop')
  const ref: SessionRef = { id: 's', provider: 'custom', source: { path: 'memory', format: 'custom' }, metadata: {} }
  let closed = 0
  async function close() {
    closed++
    throw reason
  }
  const provider = defineProvider({
    id: 'custom',
    async detect() { return { provider: 'custom', roots: [], available: true } },
    scan: () => scanSource('custom', ref.source, {}, async function* (): AsyncGenerator<ScanEvent> {
      try {
        yield { type: 'ref', ref }
      }
      finally {
        await close()
      }
    }),
    async read() { throw new Error('unexpected read') },
  })
  const registry = createSessionRegistry([provider])
  const early = registry.scanStream()
  await early.next()
  await assert.rejects(early.return(undefined), error => error === reason)
  assert.equal(closed, 1)
  const thrown = registry.scanStream()
  await thrown.next()
  await assert.rejects(thrown.throw(reason), error => error === reason)
  assert.equal(closed, 2)
})
for (const [provider, header, message] of [
  [
    'codex',
    { type: 'session_meta', payload: { id: 'large' } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: 'text' },
    },
  ],
  [
    'claude',
    { type: 'system', sessionId: 'large' },
    { type: 'user', sessionId: 'large', message: { content: 'text' } },
  ],
  [
    'pi',
    { type: 'session', id: 'large', version: 3 },
    { type: 'message', message: { role: 'user', content: 'text' } },
  ],
  [
    'cursor',
    { role: 'user', message: { content: 'header' } },
    { role: 'assistant', message: { content: 'text' } },
  ],
] as const) {
  void it(`${provider}: cheap scan, lazy open, early return, full snapshot and cancellation`, async (t) => {
    const root = await directory(t)
    const path = join(root, 'large.jsonl')
    await writeFile(
      path,
      `${JSON.stringify(header)
      }\n${
        (`${JSON.stringify(message)}\n`).repeat(20000)
      }${JSON.stringify({ late: 'x'.repeat(2048) })
      }\n`,
    )
    const { refs } = await sessions.scan({
      providers: [provider],
      roots: { [provider]: [path] },
      homeDir: root,
      headerBytes: 128,
    })
    const ref = refs[0]!
    assert.equal(refs.length, 1)
    const opened = await sessions.open(ref, { maxRecordBytes: 1024 })
    assert.equal(opened.readMode, 'incremental')
    let count = 0
    for await (const event of opened.events()) {
      assert.equal(event.sequence, count++)
      if (count === 3)
        break
    }
    assert.equal(count, 3) // A late oversized record must not be read after early return.
    await assert.rejects(async () => opened.snapshot(), hasCode('CorruptedSession'))
    const snapshot = await sessions.read(ref)
    assert.equal(snapshot.records.length, 20002)
    assertSessionContract(snapshot)
    assert.equal(snapshot.events.at(-1)?.type, 'unknown')
    const controller = new AbortController()
    const cancelled = await sessions.open(ref, { signal: controller.signal })
    await assert.rejects(async () => {
      for await (const event of cancelled.events()) {
        assert.equal(event.sequence, 0)
        controller.abort(new Error('stop'))
      }
    }, /stop/)
  })
}
void it('malformed binary lines and blank lines retain physical positions and later events', async (t) => {
  const root = await directory(t)
  const path = join(root, 's.jsonl')
  await writeFile(
    path,
    Buffer.concat([
      Buffer.from('{"type":"session_meta","payload":{"id":"s"}}\n\n'),
      Buffer.from([255, 254, 10]),
      Buffer.from(
        '{"type":"response_item","payload":{"type":"message","role":"user","content":"later"}}\n',
      ),
    ]),
  )
  const ref = (await sessions.scan({ providers: ['codex'], roots: { codex: [path] } })).refs[0]!
  const snapshot = await sessions.read(ref)
  assert.deepEqual(
    snapshot.records.map(r => r.source.position),
    [1, 3, 4],
  )
  assert.deepEqual(snapshot.records[1]!.bytes, [255, 254, 10])
  assert.equal(snapshot.events.at(-1)?.type, 'user_message')
  assertSessionContract(snapshot)
})
void it('large JSON integer lexemes remain exact raw evidence', async (t) => {
  const root = await directory(t)
  const path = join(root, 's.jsonl')
  const line = '{"type":"future","integer":9007199254740993,"decimal":1.2300}'
  await writeFile(path, `${line}\n`)
  const ref = (await sessions.scan({ providers: ['codex'], roots: { codex: [path] } })).refs[0]!
  const snapshot = await sessions.read(ref)
  assert.equal(snapshot.records[0]!.text, `${line}\n`)
  assert.equal(snapshot.events[0]!.type, 'unknown')
  assert.ok(jsonOf(snapshot).includes('9007199254740993'))
})
void it('tool calls selection excludes native tool results', async () => {
  const ref = (await sessions.scan({
    providers: ['codex'],
    roots: { codex: [resolve('fixtures/codex/tool-call.jsonl')] },
  })).refs[0]!
  const session = await sessions.read(ref)
  assert.deepEqual(toolCallsOf(session).map(event => event.type), ['tool_call'])
})
void it('event selection retains evidence, repeated IDs and order with narrowed types', async () => {
  const native = await readFile(resolve('fixtures/codex/tool-call.jsonl'), 'utf8')
  const session = await sessions.parse('codex', { jsonl: native + native })
  const calls: readonly Extract<SessionEvent, { type: 'tool_call' }>[] = toolCallsOf(session)
  const results: readonly Extract<SessionEvent, { type: 'tool_result' }>[] = toolResultsOf(session)
  const selected: readonly Extract<SessionEvent, { type: 'tool_call' | 'tool_result' }>[] = eventsOf(session, 'tool_result', 'tool_call', 'tool_call')
  assert.deepEqual(calls.map(event => event.data.callId), ['call-1', 'call-1'])
  assert.deepEqual(results.map(event => event.data.callId), ['call-1', 'call-1'])
  assert.deepEqual(selected, [calls[0], results[0], calls[1], results[1]])
  for (const event of selected)
    assert.equal(event, session.events[event.sequence])
  assert.deepEqual(eventsOf(session, 'usage'), [])
  assert.deepEqual(conversationOf(session), [])
  assert.deepEqual(fileChangesOf(session), [])
  assert.throws(() => Reflect.apply(eventsOf, undefined, [session]), /at least one event type/)
})
void it('file changes selection returns explicit canonical changes', () => {
  const change: SessionEvent = {
    sequence: 0,
    record: 0,
    providerMetadata: {},
    type: 'file_change',
    data: { path: 'example.ts', operation: 'modify' },
  }
  const changes: readonly Extract<SessionEvent, { type: 'file_change' }>[] = fileChangesOf({ events: [change] })
  assert.equal(changes[0], change)
})
void it('opened handles expose buffering for each native source format', async () => {
  for (const [provider, path, mode] of [
    ['codex', 'codex/simple.jsonl.zst', 'incremental'],
    ['cursor', 'cursor/ide-current.db', 'buffered'],
    ['opencode', 'opencode/simple.db', 'buffered'],
    ['opencode', 'opencode/legacy-files', 'incremental'],
  ] as const) {
    const { refs } = await sessions.scan({ providers: [provider], roots: { [provider]: [resolve('fixtures', path)] } })
    assert.ok(refs.length > 0)
    for (const ref of refs)
      assert.equal((await sessions.open(ref)).readMode, mode)
  }
})
void it('evidence is stored once and projections keep repeated IDs, native tools and branches', async () => {
  for (const [provider, path] of [
    ['claude', 'fixtures/claude/schema-variation.jsonl'],
    ['pi', 'fixtures/pi/tree.jsonl'],
    ['codex', 'fixtures/codex/subagents.jsonl'],
  ]) {
    const ref = (await sessions.scan({
      providers: [provider!],
      roots: { [provider!]: [resolve(path!)] },
    })).refs[0]!
    const snapshot = await sessions.read(ref)
    assertSessionContract(snapshot)
    assert.deepEqual(
      conversationOf(snapshot),
      snapshot.events.filter(
        e => e.type === 'user_message' || e.type === 'assistant_message',
      ),
    )
    assert.ok(toolCallsOf(snapshot).every(e => snapshot.events.includes(e)))
    assert.ok(subagentsOf(snapshot).every(e => snapshot.events.includes(e)))
    assert.equal(snapshot.parentSessionId, undefined)
    if (provider === 'pi') {
      assert.equal(snapshot.metadata.parentSession, '/fixture/parent.jsonl')
      assert.ok(
        snapshot.events.some(e => e.providerMetadata.parentId === 'u1'),
      )
    }
  }
})
void it('unknown providers, duplicate registration, absent stores and custom eager SPI', async (t) => {
  const root = await directory(t)
  assert.deepEqual(await sessions.scan({ homeDir: root }), { refs: [], failures: [] })
  await assert.rejects(
    async () => sessions.scan({ providers: ['no-such-provider'] }),
    hasCode('ProviderNotFound'),
  )
  const ref: SessionRef = {
    id: 's',
    provider: 'internal',
    source: { path: 'memory', format: 'custom' },
    metadata: {},
  }
  const snapshot: Session = {
    ...ref,
    schema: SESSION_SCHEMA,
    events: [],
    records: [],
    diagnostics: [],
  }
  let reads = 0
  const provider = defineProvider({
    id: 'internal',
    async detect() {
      return { provider: 'internal', available: true, roots: [] }
    },
    async* scan() {
      yield { type: 'ref' as const, ref }
    },
    async read() {
      reads++
      return snapshot
    },
  })
  const registry = createSessionRegistry([provider])
  assert.deepEqual(await registry.scan(), { refs: [ref], failures: [] })
  const opened = await registry.open(ref)
  assert.equal(opened.readMode, 'buffered')
  assert.equal(reads, 0)
  assert.equal(await opened.snapshot(), snapshot)
  assert.equal(await registry.read(ref), snapshot)
  assert.equal(registry.require('internal'), provider)
  assert.equal(sessions.require('codex').id, 'codex')
  assert.throws(
    () => registry.require('no-such-provider'),
    hasCode('ProviderNotFound'),
  )
  assert.throws(() => createSessionRegistry([provider, provider]), /duplicate/)
  assert.throws(() => defineProvider({ ...provider, id: ' ' }), /nonempty/)
})
void it('explicit home isolates environment discovery and explicit empty roots disable a provider', async (t) => {
  const root = await directory(t)
  await mkdir(join(root, '.config/claude/projects'), { recursive: true })
  await writeFile(
    join(root, '.config/claude/projects/s.jsonl'),
    '{"type":"system","sessionId":"s"}',
  )
  const { refs } = await sessions.scan({ homeDir: root })
  assert.deepEqual(
    refs.map(r => r.provider),
    ['claude'],
  )
  assert.deepEqual(
    await sessions.scan({ homeDir: root, roots: { claude: [] } }),
    { refs: [], failures: [] },
  )
})
void it('unsafe filesystem session ID cannot traverse paths', async (t) => {
  const root = await directory(t)
  const path = join(root, 'storage/session/project/a.json')
  await mkdir(join(root, 'storage/session/project'), { recursive: true })
  await writeFile(path, '{"id":"../../outside"}')
  const ref = (await sessions.scan({
    providers: ['opencode'],
    roots: { opencode: [join(root, 'storage')] },
  })).refs[0]!
  await assert.rejects(async () => sessions.read(ref), hasCode('CorruptedSession'))
})
void it('malformed legacy message cannot hide later parts', async (t) => {
  const root = await directory(t)
  const storage = join(root, 'storage')
  for (const p of ['session/project', 'message/s', 'part/m'])
    await mkdir(join(storage, p), { recursive: true })
  await writeFile(join(storage, 'session/project/s.json'), '{"id":"s"}')
  await writeFile(join(storage, 'message/s/0.json'), Buffer.from([255, 10]))
  await writeFile(
    join(storage, 'message/s/1.json'),
    '{"id":"m","role":"user"}',
  )
  await writeFile(
    join(storage, 'part/m/p.json'),
    '{"id":"p","type":"text","text":"survives"}',
  )
  const ref = (await sessions.scan({
    providers: ['opencode'],
    roots: { opencode: [storage] },
  })).refs[0]!
  const session = await sessions.read(ref)
  assert.ok(session.events.some(e => e.type === 'unknown'))
  assert.ok(jsonOf(session).includes('survives'))
  assertSessionContract(session)
})
void it('sQL record evidence keeps the full row beside its normalized projections', async () => {
  const ref = (await sessions.scan({
    providers: ['opencode'],
    roots: { opencode: [resolve('fixtures/opencode/schema-variation.db')] },
  })).refs[0]!
  const session = await sessions.read(ref)
  const record = session.records.find(
    r => r.source.table === 'session_message',
  )!
  assert.ok('native_row' in (record.native as object))
  assert.ok(record.text?.includes('"files"'))
  const path = resolve('fixtures/opencode/schema-variation.db')
  const before = await readFile(path)
  await sessions.read(ref)
  assert.deepEqual(await readFile(path), before)
})
void it('cursor retains whole legacy index row but does not guess workspace from store paths', async () => {
  const ref = (await sessions.scan({
    providers: ['cursor'],
    roots: { cursor: [resolve('fixtures/cursor/ide-index.db')] },
  })).refs[0]!
  const session = await sessions.read(ref)
  assert.ok(jsonOf(session.records[0]!.native).includes('allComposers'))
  assert.equal(session.workspace, undefined)
})

void it('invalid UTF-8 in a header does not fabricate a native session identity', async (t) => {
  const root = await directory(t)
  const path = join(root, 'invalid.jsonl')
  await writeFile(
    path,
    Buffer.concat([
      Buffer.from('{"type":"system","sessionId":"'),
      Buffer.from([255]),
      Buffer.from('"}\n{"type":"user","message":{"content":"later"}}\n'),
    ]),
  )
  const ref = (await sessions.scan({ providers: ['claude'], roots: { claude: [path] } })).refs[0]!
  assert.equal(ref.id, `source:${path}`)
  const session = await sessions.read(ref)
  assert.ok(session.records[0]!.bytes?.includes(255))
  assert.equal(session.events.at(-1)?.type, 'user_message')
})
