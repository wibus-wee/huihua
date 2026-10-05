import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it } from 'node:test'

import type { SessionFrame, SessionRef } from '../src/index.ts'
import { createSessionRegistry, defineProvider, SessionError, sessions } from '../src/index.ts'
import { assertSessionContract } from '../src/testing/index.ts'
import { cases, fixtureRoot } from './oracle.ts'

async function framesOf(source: AsyncIterable<SessionFrame>): Promise<SessionFrame[]> {
  const frames: SessionFrame[] = []
  for await (const frame of source) frames.push(frame)
  return frames
}

void it('acquired streaming emits a consumed prefix before EOF', { timeout: 2000 }, async () => {
  let finishInput!: () => void
  const gate = new Promise<void>((resolve) => {
    finishInput = resolve
  })
  let atEOF = false
  async function* bytes() {
    yield Buffer.from('{"type":"event_msg","payload":{"type":"user_message","message":"prefix"}}\n')
    await gate
    atEOF = true
  }
  try {
    for await (const frame of sessions.stream('codex', { jsonl: bytes(), source: 'stored-object:synthetic' })) {
      if (frame.type === 'event') {
        assert.equal(frame.event.type, 'user_message')
        assert.equal(atEOF, false)
        finishInput()
      }
    }
    assert.equal(atEOF, true)
  }
  finally { finishInput() }
})

for (const provider of ['codex', 'claude', 'pi', 'cursor']) {
  void it(`${provider}: direct file, text, bytes and byte stream share the existing parser`, async () => {
    const path = resolve(`fixtures/${provider}/simple.jsonl`)
    const refs = await sessions.scan({ providers: [provider], roots: { [provider]: [path] } })
    const expected = await sessions.read(refs[0]!)
    const data = await readFile(path)
    async function* bytes() {
      // Split UTF-8 and newlines arbitrarily; acquisition must not affect event semantics.
      for (const byte of data) yield new Uint8Array([byte])
    }
    for (const input of [{ path }, { jsonl: data.toString() }, { jsonl: data }, { jsonl: bytes() }]) {
      const parsed = await sessions.parse(provider, input)
      assertSessionContract(parsed)
      if (!expected.id.startsWith('source:'))
        assert.equal(parsed.id, expected.id)
      else assert.equal(parsed.metadata.id_origin, 'source_locator')
      assert.deepEqual(parsed.events, expected.events)
      assert.deepEqual(parsed.records.map(r => r.native), expected.records.map(r => r.native))
      assert.deepEqual(parsed.records.map(r => r.text), expected.records.map(r => r.text))
    }
  })
}

void it('direct acquisition invokes no discovery and preserves raw evidence through a custom SPI', async () => {
  const provider = sessions.require('codex')
  assert.ok(provider.parse)
  const registry = createSessionRegistry([defineProvider({
    ...provider,
    detect: async () => { throw new Error('must not detect') },
    scan: async () => { throw new Error('must not scan') },
  })])
  const path = resolve('fixtures/codex/simple.jsonl')
  assert.equal((await registry.parse('codex', { path })).provider, 'codex')
  assert.equal((await registry.parse('codex', { jsonl: await readFile(path) })).provider, 'codex')
})

void it('acquired JSONL retains malformed lines, unknowns, exact numeric text and provenance', async () => {
  const data = '{"type":"future","large":9007199254740993}\n{broken\n{"type":"future","ok":true}'
  const session = await sessions.parse('codex', { jsonl: data, source: 'upload:example' })
  assertSessionContract(session)
  assert.equal(session.records.length, 3)
  assert.equal(session.events.filter(e => e.type === 'unknown').length, 3)
  assert.ok(session.records[0]?.text?.includes('9007199254740993'))
  assert.ok(session.records.every(r => r.source.path === 'upload:example'))
  assert.ok(session.diagnostics.some(d => d.message === 'corrupted JSONL record'))
})

void it('caller-owned buffers can be reused; invalid UTF-8 remains bytes', async () => {
  async function* bytes() {
    const buffer = Buffer.from('{"type":"future"}')
    yield buffer
    buffer.fill(32)
    yield Buffer.from('\n')
    yield Buffer.from([255, 10])
  }
  const session = await sessions.parse('codex', { jsonl: bytes() })
  assert.equal(session.records.length, 2)
  assert.deepEqual(session.records[0]?.native, { type: 'future' })
  assert.deepEqual(session.records[1]?.bytes, [255, 10])
})

void it('string encoding retains a surrogate pair at the chunk boundary', async () => {
  const prefix = JSON.stringify({ role: 'user', message: { content: '' } }).indexOf('""') + 1
  const text = `${'x'.repeat(16383 - prefix)}😀`
  const session = await sessions.parse('cursor', { jsonl: JSON.stringify({ role: 'user', message: { content: text } }) })
  assert.deepEqual(session.events[0]?.data, { content: [{ type: 'text', data: text }] })
})

for (const [provider, file] of [
  ['cursor', 'cursor/ide-current.db'],
  ['cursor', 'cursor/ide-legacy.db'],
  ['opencode', 'opencode/simple.db'],
  ['opencode', 'opencode/v2-without-seq.db'],
  ['opencode', 'opencode/legacy-files/storage/session/project/file-session.json'],
  ['codex', 'codex/simple.jsonl.zst'],
]) {
  void it(`${provider}: explicit ${file} selector reads without discovery`, async () => {
    const path = resolve('fixtures', file!)
    const ref = (await sessions.scan({ providers: [provider!], roots: { [provider!]: [path] } }))[0]!
    const expected = await sessions.read(ref)
    const adapter = sessions.require(provider!)
    const registry = createSessionRegistry([{
      ...adapter,
      detect: async () => { throw new Error('must not detect') },
      scan: async () => { throw new Error('must not scan') },
    }])
    const parsed = await registry.parse(provider!, {
      path,
      id: ref.id,
      format: ref.source.format,
      ...(ref.source.locator === undefined ? {} : { locator: ref.source.locator }),
    })
    assert.equal(parsed.id, expected.id)
    assert.deepEqual(parsed.events, expected.events)
    assert.deepEqual(parsed.records, expected.records)
  })
}

void it('selected identity stays stable when acquired headers disagree', async () => {
  const jsonl = '{"type":"session","id":"first","version":3}\n{"type":"session","id":"second","version":3}'
  for (const id of [undefined, 'caller', 'source:caller']) {
    const session = await sessions.parse('pi', { jsonl, ...(id === undefined ? {} : { id }) })
    assert.equal(session.id, id ?? 'first')
    assert.equal(session.records.length, 2)
    assert.ok(session.diagnostics.some(d => d.message.includes('conflicting native session header')))
  }
})

void it('acquired input respects record limits, cancellation and iterator cleanup', async () => {
  let closed = false
  async function* bytes() {
    try {
      yield Buffer.from('record exceeding budget')
    }
    finally { closed = true }
  }
  await assert.rejects(async () => sessions.parse('codex', { jsonl: bytes() }, { maxRecordBytes: 4 }), /exceeds/)
  assert.ok(closed)
  let acquired = false
  async function* unopened() {
    acquired = true
    yield Buffer.from('{}')
  }
  await assert.rejects(async () => sessions.parse('codex', { jsonl: unopened() }, { signal: AbortSignal.abort() }))
  assert.equal(acquired, false)
  await assert.rejects(async () => sessions.parse('codex', { jsonl: '' }, { maxRecordBytes: 0 }), RangeError)
  const controller = new AbortController()
  closed = false
  async function* interrupted() {
    try {
      yield Buffer.from('{}\n')
      controller.abort()
      yield Buffer.from('{}\n')
    }
    finally { closed = true }
  }
  await assert.rejects(async () => sessions.parse('codex', { jsonl: interrupted() }, { signal: controller.signal }))
  assert.ok(closed)
})

void it('ill-formed input strings fail instead of silently changing their evidence', async () => {
  await assert.rejects(async () => sessions.parse('codex', { jsonl: '{"type":"future","text":"\uD800"}' }), /unpaired UTF-16/)
  // Escaped surrogate lexemes are valid persisted JSON and must remain recoverable.
  const jsonl = '{"type":"future","text":"\\ud800"}'
  const parsed = await sessions.parse('codex', { jsonl })
  assert.equal(parsed.records[0]?.text, jsonl)
})

void it('missing files and unsupported acquired formats remain explicit errors', async () => {
  await assert.rejects(async () => sessions.parse('codex', { path: 'missing-session.jsonl' }), e => e instanceof SessionError && e.code === 'SessionNotFound')
  await assert.rejects(async () => sessions.parse('opencode', { jsonl: '{}' }), e => e instanceof SessionError && e.code === 'UnsupportedSchema')
  await assert.rejects(async () => sessions.parse('missing-provider', { jsonl: '{}' }), e => e instanceof SessionError && e.code === 'ProviderNotFound')
})

for (const fixture of [
  ...(await cases()).filter(fixture => fixture.path.endsWith('.jsonl')),
  { provider: 'morph', path: 'morph/store/journal/events.000000000000000001.jsonl' },
]) {
  const provider = fixture.provider === 'claude_code' ? 'claude' : fixture.provider
  void it(`${provider}: ${fixture.path} acquired frames match file frames exactly`, async (t) => {
    // Isolate the transcript: acquired bytes do not include adjacent native metadata files.
    const root = await mkdtemp(join(tmpdir(), 'huihua-acquired-'))
    t.after(async () => rm(root, { recursive: true, force: true }))
    const path = join(root, 'input.jsonl')
    const data = await readFile(resolve(fixtureRoot, fixture.path))
    await writeFile(path, data)
    const ref: SessionRef = { id: `source:${path}`, provider, source: { path, format: 'jsonl' }, metadata: { id_origin: 'source_locator' } }
    const expected = await framesOf((await sessions.open(ref)).stream())
    async function* bytes() {
      for (const byte of data) yield new Uint8Array([byte])
    }
    for (const jsonl of [data.toString(), data, bytes()]) {
      assert.deepEqual(await framesOf(sessions.stream(provider, { jsonl, source: path })), expected)
    }
  })
}

void it('Hermes acquired snapshot frames preserve all native messages and evidence', async () => {
  const jsonl = JSON.stringify(JSON.parse(await readFile(resolve(fixtureRoot, 'hermes/session.json'), 'utf8')))
  const input = { jsonl, source: 'stored-object:hermes' }
  const snapshot = await sessions.parse('hermes', input)
  const frames = await framesOf(sessions.stream('hermes', input))
  assert.deepEqual(frames.flatMap(frame => frame.type === 'record' ? [frame.record] : []), snapshot.records)
  assert.deepEqual(frames.flatMap(frame => frame.type === 'event' ? [frame.event] : []), snapshot.events)
  assert.deepEqual(frames.flatMap(frame => frame.type === 'diagnostic' ? [frame.diagnostic] : []), snapshot.diagnostics)
  assert.ok(frames.some(frame => frame.type === 'metadata' && frame.patch.id === snapshot.id))
})

void it('acquired streaming is lazy, applies backpressure and closes on early return', async () => {
  let requested = 0
  let closed = false
  async function* bytes() {
    try {
      requested++
      yield Buffer.from('{"type":"event_msg","payload":{"type":"user_message","message":"first"}}\n')
      requested++
      yield Buffer.from('oversized unread suffix')
    }
    finally { closed = true }
  }
  const frames = sessions.stream('codex', { jsonl: bytes() }, { maxRecordBytes: 100 })
  assert.equal(requested, 0)
  const iterator = frames[Symbol.asyncIterator]()
  assert.equal(requested, 0)
  const first = await iterator.next()
  assert.ok(!first.done)
  assert.equal(first.value.type, 'record')
  assert.equal(requested, 1)
  await Promise.resolve()
  assert.equal(requested, 1)
  for await (const frame of { [Symbol.asyncIterator]: () => iterator }) {
    if (frame.type === 'event')
      break
  }
  assert.equal(requested, 1)
  assert.equal(closed, true)
})

void it('acquired streams reject concurrent consumers and replay after completion, return or error', async () => {
  for (const jsonl of ['', '{}\n', 'oversized']) {
    const frames = sessions.stream('codex', { jsonl }, { maxRecordBytes: 4 })
    const iterator = frames[Symbol.asyncIterator]()
    assert.throws(() => frames[Symbol.asyncIterator](), /already consumed/)
    if (jsonl === 'oversized') {
      await assert.rejects(async () => iterator.next(), /exceeds/)
    }
    else {
      await iterator.next()
      await iterator.return?.()
    }
    assert.throws(() => frames[Symbol.asyncIterator](), /already consumed/)
  }
  const input = { jsonl: '{}\n' }
  assert.deepEqual(await framesOf(sessions.stream('codex', input)), await framesOf(sessions.stream('codex', input)))
})

void it('acquired streaming propagates cancellation between frames and closes the producer', async () => {
  const controller = new AbortController()
  const reason = new Error('stop acquired stream')
  let closed = false
  let requested = 0
  async function* bytes() {
    try {
      requested++
      yield Buffer.from('{}\n{}\n')
      requested++
      yield Buffer.from('{}\n')
    }
    finally { closed = true }
  }
  const frames = sessions.stream('codex', { jsonl: bytes() }, { signal: controller.signal })
  const iterator = frames[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.ok(!first.done)
  assert.equal(first.value.type, 'record')
  controller.abort(reason)
  await assert.rejects(async () => iterator.next(), error => error === reason)
  assert.equal(requested, 1)
  assert.equal(closed, true)

  assert.throws(() => sessions.stream('codex', { jsonl: bytes() }, { signal: controller.signal }), error => error === reason)
  assert.equal(requested, 1)
  const late = new AbortController()
  const unopened = sessions.stream('codex', { jsonl: bytes() }, { signal: late.signal })
  late.abort(reason)
  await assert.rejects(async () => framesOf(unopened), error => error === reason)
  assert.equal(requested, 1)
})

void it('cancellation after the last frame of a chunk does not request another chunk', async () => {
  const controller = new AbortController()
  const reason = new Error('stop before next chunk')
  let requested = 0
  let closed = false
  async function* bytes() {
    try {
      requested++
      yield Buffer.from('{"type":"event_msg","payload":{"type":"user_message","message":"prefix"}}\n')
      requested++
      yield Buffer.from('{}\n')
    }
    finally { closed = true }
  }
  await assert.rejects(async () => {
    for await (const frame of sessions.stream('codex', { jsonl: bytes() }, { signal: controller.signal })) {
      if (frame.type === 'event')
        controller.abort(reason)
    }
  }, error => error === reason)
  assert.equal(requested, 1)
  assert.equal(closed, true)
})

void it('acquired streaming leaves a prefix provisional and closes on limits or producer failure', async () => {
  for (const failure of ['limit', 'producer']) {
    let closed = false
    const reason = new Error('producer failed')
    async function* bytes() {
      try {
        yield Buffer.from('{}\n')
        if (failure === 'producer')
          throw reason
        yield Buffer.from('oversized suffix')
      }
      finally { closed = true }
    }
    const frames: SessionFrame[] = []
    await assert.rejects(async () => {
      for await (const frame of sessions.stream('codex', { jsonl: bytes() }, { maxRecordBytes: 4 })) frames.push(frame)
    }, error => failure === 'producer' ? error === reason : error instanceof SessionError && error.code === 'CorruptedSession')
    assert.equal(frames.filter(frame => frame.type === 'record').length, 1)
    assert.equal(closed, true)
  }
})

void it('acquired streaming retains reused buffers, invalid UTF-8 and exact numeric text', async () => {
  const text = '{"type":"future","large":9007199254740993}'
  async function* bytes() {
    const buffer = Buffer.from(text)
    yield buffer
    buffer.fill(32)
    yield Buffer.from('\n')
    yield Buffer.from([255, 10])
  }
  const frames = await framesOf(sessions.stream('codex', { jsonl: bytes(), source: 'stored-object:bytes' }))
  const records = frames.flatMap(frame => frame.type === 'record' ? [frame.record] : [])
  assert.equal(records[0]?.text, `${text}\n`)
  assert.deepEqual(records[1]?.bytes, [255, 10])
  assert.ok(records.every(record => record.source.path === 'stored-object:bytes'))
  assert.equal(frames.filter(frame => frame.type === 'diagnostic').length, 2)
})

void it('acquired streaming dispatches through the public SPI without discovery or snapshot fallback', async () => {
  const provider = sessions.require('codex')
  const unexpected = async () => {
    throw new Error('must not acquire a file or snapshot')
  }
  const registry = createSessionRegistry([defineProvider({ ...provider, detect: unexpected, scan: unexpected, read: unexpected, open: unexpected, parse: unexpected })])
  const input = { jsonl: '{}\n', source: '/nonexistent/provenance-label/wire.jsonl' }
  assert.deepEqual(await framesOf(registry.stream('codex', input)), await framesOf(sessions.stream('codex', input)))
  const snapshotOnly = createSessionRegistry([defineProvider({ id: 'snapshot-only', detect: unexpected, scan: unexpected, read: unexpected, parse: unexpected })])
  assert.throws(() => snapshotOnly.stream('snapshot-only', input), error => error instanceof SessionError && error.code === 'UnsupportedSchema')
  assert.throws(() => sessions.stream('opencode', input), error => error instanceof SessionError && error.code === 'UnsupportedSchema')
  assert.throws(() => sessions.stream('missing', input), error => error instanceof SessionError && error.code === 'ProviderNotFound')
})
