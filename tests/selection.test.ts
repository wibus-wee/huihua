import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { it } from 'node:test'

import type { SessionFrame, UsageFactItem } from '../src/index.ts'
import { sessions } from '../src/index.ts'
import { cases, fixtureRoot } from './oracle.ts'

async function framesOf(source: AsyncIterable<SessionFrame>): Promise<SessionFrame[]> {
  const frames: SessionFrame[] = []
  for await (const frame of source) frames.push(frame)
  return frames
}
// Reuse the opt-in benchmark's Linux descriptor check without running a workload.
async function assertClosed(path: string): Promise<void> {
  if (process.platform === 'linux') {
    const paths = await Promise.all((await readdir('/proc/self/fd')).map(async fd => readlink(`/proc/self/fd/${fd}`).catch(() => '')))
    assert.ok(!paths.includes(path), 'callback exit must close the source descriptor')
  }
}

for (const fixture of await cases()) {
  if (!/\.jsonl(?:\.zst|\.zstd)?$/.test(fixture.path))
    continue
  const provider = fixture.provider === 'claude_code' ? 'claude' : fixture.provider
  void it(`${provider}: ${fixture.path} selective frames preserve evidence, sequences and diagnostics`, async () => {
    const { refs } = await sessions.scan({
      providers: [provider],
      roots: { [provider]: [resolve(fixtureRoot, fixture.path)] },
      homeDir: fixtureRoot,
    })
    const opened = await sessions.open(refs[0]!)
    assert.ok(opened.select)
    const full = await framesOf(opened.stream())
    const selected = await framesOf(opened.select({ events: ['usage'] }))
    assert.deepEqual(selected, full.filter(frame => frame.type !== 'event' || frame.event.type === 'usage'))
    const lineage = await framesOf(opened.select({ events: ['usage'], metadataKeys: ['parentSessionId', 'parentSessionId'] }))
    const expected = full.flatMap((frame): SessionFrame[] => {
      if (frame.type === 'event' && frame.event.type !== 'usage')
        return []
      if (frame.type === 'metadata')
        return Object.hasOwn(frame.patch, 'parentSessionId') ? [{ type: 'metadata', patch: Object.fromEntries(Object.entries(frame.patch).filter(([key]) => key === 'parentSessionId')) }] : []
      return [frame]
    })
    assert.deepEqual(lineage, expected)
    assert.ok(opened.consume)
    const consumed: SessionFrame[] = []
    await opened.consume({ events: ['usage'], metadataKeys: ['parentSessionId'] }, (frame) => {
      consumed.push(frame)
    })
    assert.deepEqual(consumed, lineage)
    if (provider === 'claude' || provider === 'codex') {
      for (const metadataKeys of [[], ['metadata'], ['updatedAt'], ['createdAt', 'workspace', 'title'], ['id', 'parentSessionId']] as const) {
        const actual = await framesOf(opened.select({ events: ['usage'], metadataKeys }))
        const expected = full.flatMap((frame): SessionFrame[] => {
          if (frame.type === 'event' && frame.event.type !== 'usage')
            return []
          if (frame.type !== 'metadata')
            return [frame]
          const patch = Object.fromEntries(Object.entries(frame.patch).filter(([key]) => (metadataKeys as readonly string[]).includes(key)))
          return Object.keys(patch).length === 0 ? [] : [{ type: 'metadata', patch }]
        })
        assert.deepEqual(actual, expected, `demand-selected ${metadataKeys.join(',')} must match full evidence`)
      }
    }
    if (provider === 'claude' || provider === 'codex') {
      assert.ok(opened.consumeUsage)
      const usage: SessionFrame[] = []
      await opened.consumeUsage((frame) => {
        usage.push(frame)
      })
      assert.ok(usage.every(frame => frame.type !== 'record'))
      const withoutContext = usage.map((frame) => {
        if (frame.type !== 'event')
          return frame
        const { native_usage_context, ...providerMetadata } = frame.event.providerMetadata
        assert.ok(native_usage_context !== undefined)
        assert.equal(frame.event.type, 'usage')
        return { ...frame, event: { ...frame.event, providerMetadata } }
      })
      assert.deepEqual(withoutContext, lineage.filter(frame => frame.type !== 'record'))
      assert.ok(opened.consumeUsageFacts)
      const facts: UsageFactItem[] = []
      await opened.consumeUsageFacts((item) => {
        facts.push(item)
      })
      const expectedFacts = usage.map((frame) => {
        if (frame.type !== 'event')
          return frame
        const { sequence, ...fact } = frame.event
        assert.ok(Number.isInteger(sequence))
        return fact
      })
      assert.deepEqual(facts, expectedFacts)
      const filtered: UsageFactItem[] = []
      await opened.consumeUsageFacts((item) => {
        filtered.push(item)
      }, { acceptTimestamp: () => false })
      assert.deepEqual(filtered, facts.filter(item => item.type !== 'usage'), 'filtering cannot suppress source diagnostics or parent lineage')
    }
    else {
      assert.equal(opened.consumeUsage, undefined, 'format owners must opt in to complete usage context')
      assert.equal(opened.consumeUsageFacts, undefined)
    }
    const batched = await sessions.open(refs[0]!, { batchDecode: true })
    assert.deepEqual(await framesOf(batched.stream()), full)
    const all: SessionFrame[] = []
    await opened.consume({}, (frame) => {
      all.push(frame)
    })
    assert.deepEqual(all, full)
  })
}

void it('usage-only delivery keeps duplicate usage, foreign identity, malformed and tool diagnostics', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-selection-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'mixed.jsonl')
  const native = await Promise.all(['tool-call', 'interrupted', 'usage-only', 'unknown', 'malformed'].map(async name => readFile(resolve(fixtureRoot, `claude/${name}.jsonl`), 'utf8')))
  await writeFile(path, native.join('\n'))
  const { refs } = await sessions.scan({ providers: ['claude'], roots: { claude: [path] } })
  const opened = await sessions.open(refs[0]!)
  assert.ok(opened.select)
  const full = await framesOf(opened.stream())
  assert.deepEqual(await framesOf(opened.select({})), full)
  const selected = await framesOf(opened.select({ events: ['usage'], records: false, metadata: false }))
  assert.deepEqual(selected, full.filter(frame => frame.type === 'diagnostic' || (frame.type === 'event' && frame.event.type === 'usage')))
  assert.equal(selected.filter(frame => frame.type === 'event').length, 2)
  const messages = selected.filter(frame => frame.type === 'diagnostic').map(frame => frame.diagnostic.message)
  assert.ok(messages.some(message => message.includes('scan-selected identity')))
  assert.ok(messages.includes('corrupted JSONL record'))
  assert.ok(messages.some(message => message.includes('has no recorded result')))
  const withKeys = await framesOf(opened.select({ events: ['usage'], records: false, metadata: false, metadataKeys: ['parentSessionId'] }))
  assert.deepEqual(withKeys, selected, 'metadata false overrides key selection without suppressing diagnostics')
  const emptyKeys = await framesOf(opened.select({ metadataKeys: [] }))
  assert.deepEqual(emptyKeys, full.filter(frame => frame.type !== 'metadata'))
})

void it('evidence-free usage keeps suffix validation, backpressure, replay and cancellation cleanup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-usage-callback-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'usage.jsonl')
  const native = await readFile(resolve(fixtureRoot, 'claude/usage-only.jsonl'), 'utf8')
  const ref = { id: 'claude-usage', provider: 'claude', metadata: { id_origin: 'native' }, source: { path, format: 'jsonl' as const } }
  const open = await sessions.open(ref, { maxRecordBytes: 512 })
  assert.ok(open.consumeUsage)
  await writeFile(path, native)
  const frames: SessionFrame[] = []
  await open.consumeUsage(async (frame) => {
    await Promise.resolve()
    frames.push(frame)
  })
  assert.equal(frames.filter(frame => frame.type === 'event').length, 2)
  assert.ok(frames.every(frame => frame.type !== 'record'))
  const reason = new Error('usage consumer rejected')
  await assert.rejects(open.consumeUsage(async () => {
    throw reason
  }), error => error === reason)
  await assertClosed(path)
  await writeFile(path, `${native}${JSON.stringify({ late: 'x'.repeat(1024) })}\n`)
  await assert.rejects(open.consumeUsage(() => {}), /exceeds 512 bytes/)
  await assertClosed(path)
  const controller = new AbortController()
  const cancelled = await sessions.open(ref, { signal: controller.signal })
  assert.ok(cancelled.consumeUsage)
  let delivered = 0
  await assert.rejects(cancelled.consumeUsage(() => {
    delivered++
    controller.abort(reason)
  }), error => error === reason)
  assert.equal(delivered, 1)
  await assertClosed(path)
})

void it('direct usage facts await backpressure and close sources after predicate/consumer errors and cancellation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-usage-facts-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'usage.jsonl')
  await writeFile(path, await readFile(resolve(fixtureRoot, 'claude/usage-only.jsonl')))
  const ref = (await sessions.scan({ providers: ['claude'], roots: { claude: [path] } })).refs[0]!
  const opened = await sessions.open(ref, { batchDecode: true })
  assert.ok(opened.consumeUsageFacts)
  let resume!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  const first = new Promise<void>((resolve) => {
    started = resolve
  })
  t.after(() => resume())
  let calls = 0
  const completion = opened.consumeUsageFacts(async (item) => {
    assert.equal(item.type, 'usage')
    calls++
    if (calls === 1) {
      started()
      await gate
    }
  })
  await first
  assert.equal(calls, 1)
  resume()
  await completion
  assert.equal(calls, 2)
  const reason = new Error('stop usage facts')
  await assert.rejects(opened.consumeUsageFacts(() => {}, { acceptTimestamp: () => {
    throw reason
  } }), error => error === reason)
  await assertClosed(path)
  await assert.rejects(opened.consumeUsageFacts(async () => {
    throw reason
  }), error => error === reason)
  await assertClosed(path)
  const controller = new AbortController()
  const cancelled = await sessions.open(ref, { signal: controller.signal, batchDecode: true })
  assert.ok(cancelled.consumeUsageFacts)
  await assert.rejects(cancelled.consumeUsageFacts(() => {
    controller.abort(reason)
  }), error => error === reason)
  await assertClosed(path)
})

void it('selected metadata retains late parent facts after the discovery header and all identity checks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-selection-parent-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'late-parent.jsonl')
  const base = JSON.parse((await readFile(resolve(fixtureRoot, 'claude/usage-only.jsonl'), 'utf8')).split('\n')[0]!) as Record<string, unknown>
  const rows: Record<string, unknown>[] = Array.from({ length: 10 }, (_, index) => ({ ...base, ...(index === 9 ? { parentSessionId: 'native-parent' } : {}) }))
  rows.push({ ...base, sessionId: 'conflicting-native-id', parentSessionId: 'foreign-parent' })
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
  const { refs } = await sessions.scan({ providers: ['claude'], roots: { claude: [path] } })
  assert.equal(refs[0]!.metadata.parentSessionId, undefined)
  const opened = await sessions.open(refs[0]!)
  assert.ok(opened.select)
  const full = await framesOf(opened.stream())
  const selected = await framesOf(opened.select({ events: ['usage'], metadataKeys: ['parentSessionId'] }))
  assert.deepEqual(selected.filter(frame => frame.type === 'metadata'), [{ type: 'metadata', patch: { parentSessionId: 'native-parent' } }])
  assert.deepEqual(selected.filter(frame => frame.type === 'diagnostic'), full.filter(frame => frame.type === 'diagnostic'))
  assert.ok(selected.some(frame => frame.type === 'diagnostic' && frame.diagnostic.message.includes('scan-selected identity')))
})

void it('selective delivery is lazy, replayable, bounded and cancellable after a usage yield', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-selection-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'usage.jsonl')
  const ref = { id: 'claude-usage', provider: 'claude', metadata: { id_origin: 'native' }, source: { path, format: 'jsonl' as const } }
  const opened = await sessions.open(ref, { maxRecordBytes: 512 })
  assert.ok(opened.select)
  const usage = await readFile(resolve(fixtureRoot, 'claude/usage-only.jsonl'), 'utf8')
  await writeFile(path, `${usage}${JSON.stringify({ late: 'x'.repeat(1024) })}\n`)
  const selection = { events: ['usage' as const], records: false, metadata: false }
  let prefixCount = 0
  for await (const frame of opened.select(selection)) {
    assert.equal(frame.type, 'event')
    if (++prefixCount === 1)
      break
  }
  assert.equal(prefixCount, 1)
  await assert.rejects(async () => framesOf(opened.select!({ events: [], records: false, metadata: false })), /exceeds 512 bytes/)
  await writeFile(path, usage)
  const first = await framesOf(opened.select(selection))
  await writeFile(path, usage + usage)
  assert.equal((await framesOf(opened.select(selection))).length, first.length * 2)
  const controller = new AbortController()
  const cancelled = await sessions.open(ref, { signal: controller.signal })
  assert.ok(cancelled.select)
  await assert.rejects(async () => {
    for await (const frame of cancelled.select!(selection)) {
      assert.equal(frame.type, 'event')
      controller.abort(new Error('stop selection'))
    }
  }, /stop selection/)
})

void it('callback delivery awaits consumer backpressure and reaches the same validated EOF', { timeout: 2000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-callback-backpressure-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'callback.jsonl')
  const native = await Promise.all(['interrupted', 'usage-only', 'malformed'].map(async name => readFile(resolve(fixtureRoot, `claude/${name}.jsonl`), 'utf8')))
  await writeFile(path, native.join('\n'))
  const ref = (await sessions.scan({ providers: ['claude'], roots: { claude: [path] } })).refs[0]!
  const opened = await sessions.open(ref)
  assert.ok(opened.consume)
  let resume!: () => void
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  t.after(resume)
  let received!: () => void
  const first = new Promise<void>((resolve) => {
    received = resolve
  })
  const delivered: SessionFrame[] = []
  const completion = opened.consume({}, async (frame) => {
    delivered.push(frame)
    if (delivered.length === 1) {
      received()
      await gate
    }
  })
  await first
  assert.equal(delivered.length, 1)
  resume()
  await completion
  await assertClosed(path)
  assert.deepEqual(delivered, await framesOf(opened.stream()))
  assert.ok(delivered.some(frame => frame.type === 'diagnostic' && frame.diagnostic.message.includes('has no recorded result')))
  assert.ok(delivered.some(frame => frame.type === 'diagnostic' && frame.diagnostic.message === 'corrupted JSONL record'))
})

void it('callback errors, rejection, cancellation and suffix limits propagate without later delivery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-callback-errors-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'callback.jsonl')
  const usage = await readFile(resolve(fixtureRoot, 'claude/usage-only.jsonl'), 'utf8')
  const ref = { id: 'claude-usage', provider: 'claude', metadata: { id_origin: 'native' }, source: { path, format: 'jsonl' as const } }
  // Opening still performs no source I/O; callback consumption performs the lazy read.
  const opened = await sessions.open(ref, { maxRecordBytes: 512 })
  assert.ok(opened.consume)
  await assert.rejects(opened.consume({}, () => {
    throw new Error('no callback before I/O')
  }), /ENOENT|no such file/i)
  await writeFile(path, `${usage}${JSON.stringify({ late: 'x'.repeat(1024) })}\n`)
  for (const asynchronous of [false, true]) {
    const reason = new Error(asynchronous ? 'sink rejected' : 'sink threw')
    let callbacks = 0
    const consumer = asynchronous
      ? async () => {
        callbacks++
        throw reason
      }
      : () => {
          callbacks++
          throw reason
        }
    await assert.rejects(opened.consume({ events: ['usage'], records: false, metadata: false }, consumer), error => error === reason)
    assert.equal(callbacks, 1)
    await assertClosed(path)
  }
  await assert.rejects(opened.consume({ events: [], records: false, metadata: false }, () => {
    throw new Error('no selected frames')
  }), /exceeds 512 bytes/)
  const controller = new AbortController()
  const cancelled = await sessions.open(ref, { signal: controller.signal })
  assert.ok(cancelled.consume)
  const reason = new Error('stop callback')
  let callbacks = 0
  await assert.rejects(cancelled.consume({}, () => {
    callbacks++
    controller.abort(reason)
  }), error => error === reason)
  assert.equal(callbacks, 1)
  await assertClosed(path)
  // A replay starts fresh after each failed consumer and still validates the complete source.
  await writeFile(path, usage)
  const replayed: SessionFrame[] = []
  await opened.consume({}, (frame) => {
    replayed.push(frame)
  })
  assert.deepEqual(replayed, await framesOf(opened.stream()))
  await assertClosed(path)
})
