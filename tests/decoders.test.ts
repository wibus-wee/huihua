import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'

import type { FrameSelection, SessionFrame, UsageFactItem } from '../src/index.ts'
import { createSessionRegistry } from '../src/index.ts'
import type { DecoderContribution, SessionDecoder } from '../src/ingest/index.ts'
import { jsonlProvider, object } from '../src/ingest/index.ts'
import { createPiProvider, piProvider } from '../src/providers/pi/index.ts'
import { assertSessionContract } from '../src/testing/index.ts'

const header = { type: 'session', id: 'child', version: 3, timestamp: '2026-01-01T00:00:00Z' }
const entry = { type: 'custom', id: 'extension', parentId: null, timestamp: '2026-01-01T00:00:01Z', customType: 'example.subagents', data: { agentId: 'worker', parentSessionId: 'parent' } }
const jsonl = [header, entry, { ...entry, id: 'second' }].map(value => JSON.stringify(value)).join('\n')

async function framesOf(source: AsyncIterable<SessionFrame>): Promise<SessionFrame[]> {
  const frames: SessionFrame[] = []
  for await (const frame of source) frames.push(frame)
  return frames
}

function exampleDecoder(id = 'example/subagents', parent = 'parent'): SessionDecoder {
  return {
    id,
    create() {
      let count = 0
      return {
        decode(input) {
          const native = object(input.record.native)
          if (input.type === 'gap' || native.customType !== 'example.subagents')
            return []
          count++
          return [
            { type: 'event', record: input.record, event: { type: 'subagent', data: { agentId: 'worker', kind: 'started', metadata: { count } } } },
            { type: 'metadata', record: input.record, data: { count } },
            { type: 'parent_session', record: input.record, id: parent },
          ]
        },
      }
    },
  }
}

function select(full: readonly SessionFrame[], selection: FrameSelection): SessionFrame[] {
  return full.flatMap((frame): SessionFrame[] => {
    if (frame.type === 'event' && selection.events !== undefined && !selection.events.includes(frame.event.type))
      return []
    if (frame.type === 'record' && selection.records === false)
      return []
    if (frame.type !== 'metadata')
      return [frame]
    if (selection.metadata === false)
      return []
    const patch = Object.fromEntries(Object.entries(frame.patch).filter(([key]) => selection.metadataKeys === undefined || (selection.metadataKeys as readonly string[]).includes(key)))
    return Object.keys(patch).length === 0 ? [] : [{ type: 'metadata', patch }]
  })
}

void it('Pi decoders append canonical contributions without altering builtin events or native evidence', async () => {
  const seen: unknown[] = []
  const decoder = exampleDecoder()
  const observer: SessionDecoder = {
    id: 'observer',
    create: () => ({
      decode: ({ record }) => {
        seen.push(record.native)
        return []
      },
    }),
  }
  const provider = createPiProvider({ decoders: [decoder, observer] })
  const baseline = await piProvider.parse({ jsonl })
  const session = await provider.parse({ jsonl })
  assertSessionContract(session)
  assert.deepEqual(session.records, baseline.records)
  assert.deepEqual(session.events.filter(event => event.providerMetadata.decoder === undefined).map(({ sequence, ...event }) => {
    void sequence
    return event
  }), baseline.events.map(({ sequence, ...event }) => {
    void sequence
    return event
  }))
  assert.deepEqual(session.diagnostics, baseline.diagnostics)
  assert.equal(session.parentSessionId, 'parent')
  assert.deepEqual(session.events.map(event => event.sequence), [0, 1, 2, 3, 4])
  assert.deepEqual(session.events.filter(event => event.type === 'subagent').map(event => [event.record, event.id, event.providerMetadata.decoder, event.data.metadata.count]), [[1, 'extension', 'example/subagents', 1], [2, 'second', 'example/subagents', 2]])
  assert.deepEqual(session.metadata.decoders, {
    'example/subagents': { metadata: { record: 2, data: { count: 2 } }, parentSessionIds: [{ record: 1, id: 'parent' }, { record: 2, id: 'parent' }] },
  })
  session.records.forEach((record, index) => {
    assert.equal(record.native, seen[index], 'input is the actual native reference')
    assert.equal(Object.isFrozen(record.native), false)
  })
  assert.deepEqual(await createPiProvider().parse({ jsonl }), baseline)
  assert.deepEqual(await createPiProvider({ decoders: [] }).parse({ jsonl }), baseline)
})

void it('read, parse, stream, open, selection and callback replay share decoders and isolate concurrent state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-decoders-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'session.jsonl')
  await writeFile(path, jsonl)
  let created = 0
  const example = exampleDecoder()
  const decoder: SessionDecoder = {
    ...example,
    create(context) {
      created++
      return example.create(context)
    },
  }
  const registry = createSessionRegistry([createPiProvider({ decoders: [decoder] })])
  const { refs, failures } = await registry.scan({ roots: { pi: [root] } })
  assert.deepEqual(failures, [])
  assert.equal(created, 0, 'bounded scanning does not run decoders')
  const ref = refs[0]!
  assert.equal(ref.metadata.decoders, undefined)
  const opened = await registry.open(ref)
  assert.equal(created, 0, 'opening remains lazy')
  const full = await framesOf(opened.stream())
  const [first, second, read, acquired, fromFile] = await Promise.all([opened.snapshot(), opened.snapshot(), registry.read(ref), registry.parse('pi', { jsonl, source: path }), registry.parse('pi', { path })])
  for (const session of [first, second, read, acquired, fromFile]) {
    assert.deepEqual(session.events, first.events)
    assert.deepEqual(session.metadata.decoders, first.metadata.decoders)
    assert.equal(session.parentSessionId, 'parent')
  }
  // Scan-known creation time changes the native metadata prefix, not decoder delivery.
  const comparable: FrameSelection = { metadataKeys: ['parentSessionId'] }
  assert.deepEqual(select(await framesOf(registry.stream('pi', { jsonl, source: path })), comparable), select(full, comparable))
  for (const selection of [{}, { events: ['subagent'], records: false }, { events: [], metadataKeys: ['parentSessionId'] }, { records: false, metadata: false }] satisfies FrameSelection[]) {
    assert.deepEqual(await framesOf(opened.select!(selection)), select(full, selection))
    const consumed: SessionFrame[] = []
    await opened.consume!(selection, async (frame) => {
      consumed.push(frame)
    })
    assert.deepEqual(consumed, select(full, selection))
  }
  assert.ok(created > 10)
})

void it('decoder input evidence is independent of record selection and preserves unsafe numeric text', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-decoder-text-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'session.jsonl')
  const text = '{"type":"custom","customType":"number","data":9007199254740993}\n'
  await writeFile(path, text)
  const inputs: string[] = []
  const decoder: SessionDecoder = {
    id: 'text',
    create: () => ({
      decode: ({ record }) => {
        inputs.push(record.text!)
        return []
      },
    }),
  }
  const opened = await createPiProvider({ decoders: [decoder] }).open({ id: `source:${path}`, provider: 'pi', source: { path, format: 'jsonl' }, metadata: {} })
  await framesOf(opened.stream())
  await framesOf(opened.select!({ records: false, events: [], metadata: false }))
  assert.deepEqual(inputs, [text, text])
})

void it('EOF contributions retain earlier evidence and metadata namespaces combine in registration order', async () => {
  const decoder: SessionDecoder = {
    id: 'end',
    create() {
      let origin: Extract<DecoderContribution, { type: 'event' }>['record'] | undefined
      return {
        decode({ type, record }) {
          if (type === 'record' && record.sequence === 0)
            origin = record
          return []
        },
        finish: () => origin === undefined ? [] : [{ type: 'event', record: origin, event: { type: 'system', data: { sourceType: 'summary', payload: 'complete input' } } }],
      }
    },
  }
  const session = await createPiProvider({ decoders: [exampleDecoder('one'), exampleDecoder('two'), decoder] }).parse({ jsonl })
  const tail = session.events.at(-1)!
  assert.equal(tail.record, 0)
  assert.equal(tail.id, 'child')
  assert.equal(tail.providerMetadata.decoder, 'end')
  assert.equal(tail.timestamp?.value, header.timestamp)
  assert.deepEqual(session.events.filter(event => event.type === 'subagent').map(event => event.providerMetadata.decoder), ['one', 'two', 'one', 'two'])
  assert.deepEqual(Object.keys(object(session.metadata.decoders)), ['one', 'two'])
})

void it('malformed rows are gaps and invalidate decoder correlation state', async () => {
  const inputTypes: string[] = []
  const decoder: SessionDecoder = {
    id: 'correlate',
    create() {
      let pending = false
      return {
        decode(input) {
          inputTypes.push(input.type)
          if (input.type === 'gap') {
            pending = false
            return []
          }
          const native = object(input.record.native)
          if (native.customType === 'start')
            pending = true
          if (native.customType !== 'end' || !pending)
            return []
          return [{ type: 'event', record: input.record, event: { type: 'system', data: { sourceType: 'matched', payload: true } } }]
        },
      }
    },
  }
  const session = await createPiProvider({ decoders: [decoder] }).parse({ jsonl: [JSON.stringify(header), '{"type":"custom","customType":"start"}', '{broken', '{"type":"custom","customType":"end"}'].join('\n') })
  assert.deepEqual(inputTypes, ['record', 'record', 'gap', 'record'])
  assert.equal(session.events.filter(event => event.providerMetadata.decoder !== undefined).length, 0)
  assert.ok(session.events.some(event => event.type === 'unknown' && event.data.sourceType === 'malformed_jsonl'))
})

void it('early return, cancellation, producer failure and decoder failure never finalize and close the source', async () => {
  for (const mode of ['return', 'abort', 'source-error', 'decoder-error'] as const) {
    let closed = false
    let requested = 0
    let finished = 0
    const signal = new AbortController()
    const cause = new Error(mode)
    const decoder: SessionDecoder = {
      id: 'lifecycle',
      create: () => ({
        decode: () => {
          if (mode === 'decoder-error')
            throw cause
          return []
        },
        finish: () => {
          finished++
          return []
        },
      }),
    }
    async function* chunks() {
      try {
        requested++
        yield Buffer.from(`${JSON.stringify(header)}\n`)
        requested++
        throw cause
      }
      finally { closed = true }
    }
    const source = createPiProvider({ decoders: [decoder] }).stream({ jsonl: chunks() }, { signal: signal.signal })
    if (mode === 'return') {
      for await (const frame of source) {
        assert.equal(frame.type, 'record')
        if (frame.type === 'record')
          break
      }
    }
    else {
      await assert.rejects(async () => {
        for await (const frame of source) {
          if (mode === 'abort' && frame.type === 'record')
            signal.abort(cause)
        }
      }, error => mode === 'decoder-error' ? error instanceof Error && error.cause === cause && /decoder lifecycle/.test(error.message) : error === cause)
    }
    assert.equal(finished, 0, mode)
    assert.equal(closed, true, mode)
    assert.equal(requested, mode === 'source-error' ? 2 : 1, mode)
  }
})

void it('conflicting decoder parent IDs are preserved without canonical lineage or silent last-wins', async () => {
  for (const decoders of [[exampleDecoder('one', 'a'), exampleDecoder('two', 'b')], [exampleDecoder('two', 'b'), exampleDecoder('one', 'a')]]) {
    const session = await createPiProvider({ decoders }).parse({ jsonl })
    assert.equal(session.parentSessionId, undefined)
    assert.ok(session.diagnostics.some(diagnostic => diagnostic.message.includes('conflicting decoder parent-session')))
    const namespaces = object(session.metadata.decoders)
    assert.deepEqual(object(namespaces.one).parentSessionIds, [{ record: 1, id: 'a' }, { record: 2, id: 'a' }])
    assert.deepEqual(object(namespaces.two).parentSessionIds, [{ record: 1, id: 'b' }, { record: 2, id: 'b' }])
  }
})

void it('late native lineage overrides decoder candidates in all selection and direct usage paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-decoder-native-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'session.jsonl')
  const data = [entry, { type: 'parent', id: 'native-parent' }, { type: 'usage', timestamp: 42 }].map(value => JSON.stringify(value)).join('\n')
  await writeFile(path, data)
  const provider = jsonlProvider({
    id: 'native',
    usageContext: true,
    roots: () => [path],
    decoders: [exampleDecoder()],
    metadata: (records, _path, _context, keys) => keys === undefined || keys.includes('parentSessionId') ? { ...(object(records[0]).type === 'parent' ? { parentSessionId: 'native-parent' } : {}) } : {},
    parse(ingest, native) {
      const value = object(native)
      if (value.type === 'usage')
        ingest.emit('usage', { usage: { input: 1 } }, native, { native_usage_context: { model: 'test' } })
      else
        ingest.emit('system', { sourceType: String(value.type), payload: native })
    },
  })
  const opened = await provider.open({ id: `source:${path}`, provider: 'native', source: { path, format: 'jsonl' }, metadata: {} })
  const session = await opened.snapshot()
  assert.equal(session.parentSessionId, 'native-parent')
  assert.ok(session.diagnostics.some(diagnostic => diagnostic.message.includes('native parent is authoritative')))
  const full = await framesOf(opened.stream())
  const selection: FrameSelection = { events: ['usage'], records: false, metadataKeys: ['parentSessionId'] }
  assert.deepEqual(await framesOf(opened.select!(selection)), select(full, selection))
  assert.deepEqual(await framesOf(opened.select!({ events: [], records: false, metadata: false })), select(full, { events: [], records: false, metadata: false }))
  const consumed: SessionFrame[] = []
  await opened.consumeUsage!((frame) => {
    consumed.push(frame)
  })
  assert.deepEqual(consumed, select(full, selection))
  const facts: UsageFactItem[] = []
  await opened.consumeUsageFacts!((item) => {
    facts.push(item)
  })
  assert.deepEqual(facts, consumed.map((frame) => {
    if (frame.type !== 'event')
      return frame
    const { sequence, ...fact } = frame.event
    void sequence
    return fact
  }))
})

void it('configuration rejects duplicate IDs and contributions cannot borrow records across replays', async () => {
  assert.throws(() => createPiProvider({ decoders: [exampleDecoder(), exampleDecoder()] }), /duplicate decoder ID/)
  assert.throws(() => createPiProvider({ decoders: [exampleDecoder(' ')] }), /invalid.*decoder ID/)
  let retained: Extract<DecoderContribution, { type: 'event' }>['record'] | undefined
  const decoder: SessionDecoder = {
    id: 'borrow',
    create: () => ({
      decode({ record }) {
        retained ??= record
        return [{ type: 'event', record: retained, event: { type: 'system', data: { sourceType: 'borrow', payload: null } } }]
      },
    }),
  }
  const provider = createPiProvider({ decoders: [decoder] })
  await provider.parse({ jsonl: JSON.stringify(header) })
  await assert.rejects(provider.parse({ jsonl: JSON.stringify(header) }), error => error instanceof Error && error.cause instanceof Error && /from this replay/.test(error.cause.message))
})

void it('decoder tool results cannot settle a native call or another decoder call with the same ID', async () => {
  const call: SessionDecoder = {
    id: 'caller',
    create: () => ({ decode: ({ record }) => [{ type: 'event', record, event: { type: 'tool_call', data: { callId: 'same', toolName: 'extension', arguments: {} } } }] }),
  }
  const result: SessionDecoder = {
    id: 'responder',
    create: () => ({ decode: ({ record }) => [{ type: 'event', record, event: { type: 'tool_result', data: { callId: 'same', result: 'done', isError: false } } }] }),
  }
  const native = JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'same', name: 'native', arguments: {} }] } })
  const unmatched = (session: Awaited<ReturnType<typeof piProvider.parse>>) => session.diagnostics.filter(diagnostic => diagnostic.message === 'tool call same has no recorded result').length
  const separated = await createPiProvider({ decoders: [call, result] }).parse({ jsonl: native })
  assertSessionContract(separated)
  assert.equal(unmatched(separated), 2)
  assert.deepEqual(separated.events.filter(event => event.providerMetadata.decoder !== undefined).map(event => event.providerMetadata.tool_scope), [['decoder', 'caller'], ['decoder', 'responder']])
  const joined: SessionDecoder = {
    id: 'together',
    create(context) {
      const calls = call.create(context)
      const results = result.create(context)
      return { decode: input => [...calls.decode(input), ...results.decode(input)] }
    },
  }
  assert.equal(unmatched(await createPiProvider({ decoders: [joined] }).parse({ jsonl: native })), 1)
})

void it('empty input finalizes once and finish failures retain decoder identity and cause', async () => {
  let created = 0
  let finished = 0
  const cause = new Error('finalize failed')
  const decoder: SessionDecoder = {
    id: 'empty',
    create() {
      created++
      return {
        decode: () => [],
        finish() {
          finished++
          if (created === 2)
            throw cause
          return []
        },
      }
    },
  }
  const provider = createPiProvider({ decoders: [decoder] })
  assert.deepEqual((await provider.parse({ jsonl: '' })).records, [])
  assert.equal(finished, 1)
  await assert.rejects(provider.parse({ jsonl: '' }), error => error instanceof Error && error.cause === cause && error.message === 'decoder empty failed during finish')
  assert.equal(finished, 2)
})
