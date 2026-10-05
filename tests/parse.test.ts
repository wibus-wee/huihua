import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { it } from 'node:test'

import { createSessionRegistry, defineProvider, SessionError, sessions } from '../src/index.ts'
import { assertSessionContract } from '../src/testing/index.ts'

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
