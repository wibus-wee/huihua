import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance, PerformanceObserver } from 'node:perf_hooks'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import type { SessionDecoder } from '../src/contracts/decoder.ts'

const [mode = 'stream', size = '100000', chunkSize = '65536', workload = 'messages', entry = 'src/index.ts', decoderSize = '0'] = process.argv.slice(2)
const records = Number(size)
const chunkBytes = Number(chunkSize)
const decoderCount = Number(decoderSize)
const pi = workload.startsWith('pi-')
if (!['stream', 'parse', 'select'].includes(mode) || !['messages', 'mixed', 'pi-messages', 'pi-custom', 'pi-parents'].includes(workload)
  || !Number.isSafeInteger(records) || records < 1 || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1
  || !Number.isSafeInteger(decoderCount) || decoderCount < 0 || (!pi && (decoderCount !== 0 || mode === 'select'))) {
  throw new TypeError('usage: bench-stream.ts [stream|parse|select] [records>0] [chunkBytes>0] [messages|mixed|pi-messages|pi-custom|pi-parents] [entrypoint] [decoders>=0]')
}
const module = await import(pathToFileURL(resolve(entry)).href) as typeof import('../src/index.ts')
let sessions = module.sessions
let decodedRows = 0
const empty: readonly [] = []
if (pi && decoderCount > 0) {
  const { createPiProvider } = await import(pathToFileURL(resolve(dirname(entry), 'providers/pi/index.ts')).href) as typeof import('../src/providers/pi/index.ts')
  const decoders: SessionDecoder[] = Array.from({ length: decoderCount }, (_, index) => ({
    id: `benchmark/${index}`,
    create() {
      const customType = index === decoderCount - 1 ? 'benchmark/match' : `benchmark/miss-${index}`
      return {
        decode({ type, record }) {
          if (index === 0)
            decodedRows++
          if (type !== 'record')
            return empty
          const native = record.native as { type?: string, customType?: string }
          if (native.type !== 'custom' || native.customType !== customType)
            return empty
          if (workload === 'pi-parents') {
            return [
              { type: 'metadata', record, data: { observed: record.sequence } },
              { type: 'parent_session', record, id: 'benchmark-parent' },
            ]
          }
          return [{ type: 'event', record, event: { type: 'subagent', data: { agentId: 'worker', kind: 'started', metadata: {} } } }]
        },
      }
    },
  }))
  sessions = module.createSessionRegistry([createPiProvider({ decoders })])
}
const lines = async (path: string) => (await readFile(resolve('fixtures/codex', path), 'utf8')).trimEnd().split('\n')
const messages = pi ? (await readFile(resolve('fixtures/pi/simple.jsonl'), 'utf8')).trimEnd().split('\n').slice(1, 2) : (await lines('simple.jsonl')).slice(1)
const cycle = workload === 'pi-messages'
  ? messages
  : pi
    ? [JSON.stringify({ type: 'custom', customType: 'benchmark/match', data: { agentId: 'worker' } })]
    : workload === 'messages'
      ? messages
      : [...messages, ...(await lines('tool-call.jsonl')).slice(1), ...(await lines('unknown.jsonl')).slice(1), ...(await lines('malformed.jsonl')).slice(1, 2)]

// Reuse a fixed block; input allocation must not grow with transcript length.
const blockRecords = cycle.length * 1024
const block = Buffer.from(`${Array.from({ length: blockRecords }, (_, i) => cycle[i % cycle.length]).join('\n')}\n`)
const tail = Buffer.from(`${Array.from({ length: records % blockRecords }, (_, i) => cycle[i % cycle.length]).join('\n')}${records % blockRecords ? '\n' : ''}`)
const inputBytes = Math.floor(records / blockRecords) * block.length + tail.length
let temporary: string | undefined
let opened: Awaited<ReturnType<typeof sessions.open>> | undefined
if (mode === 'select') {
  temporary = await mkdtemp(join(tmpdir(), 'huihua-decoder-bench-'))
  const path = join(temporary, 'session.jsonl')
  const file = await open(path, 'w')
  try {
    for (let remaining = records; remaining > 0; remaining -= blockRecords)
      await file.write(remaining >= blockRecords ? block : tail)
    assert.equal((await file.stat()).size, inputBytes)
  }
  finally { await file.close() }
  opened = await sessions.open({ id: `source:${path}`, provider: 'pi', source: { path, format: 'jsonl' }, metadata: {} })
}
async function* bytes(count: number): AsyncGenerator<Uint8Array> {
  for (let remaining = count; remaining > 0; remaining -= blockRecords) {
    const data = remaining >= blockRecords
      ? block
      : Buffer.from(`${Array.from({ length: remaining }, (_, i) => cycle[i % cycle.length]).join('\n')}\n`)
    for (let start = 0; start < data.length; start += chunkBytes)
      yield data.subarray(start, start + chunkBytes)
  }
}
async function consume(count: number, measured: boolean) {
  let recordCount = 0
  let eventCount = 0
  let frameCount = 0
  let diagnosticCount = 0
  let firstRecordMs: number | undefined
  const start = performance.now()
  decodedRows = 0
  const provider = pi ? 'pi' : 'codex'
  if (mode === 'stream') {
    for await (const frame of sessions.stream(provider, { jsonl: bytes(count), source: 'benchmark:fixture-cycle' })) {
      frameCount++
      if (frame.type === 'record') {
        recordCount++
        firstRecordMs ??= performance.now() - start
        if (measured && recordCount % 4096 === 0)
          sample()
      }
      else if (frame.type === 'event') {
        eventCount++
      }
      else if (frame.type === 'diagnostic') {
        diagnosticCount++
      }
    }
  }
  else if (mode === 'select') {
    await opened!.consume!({ events: [], records: false, metadata: false }, (frame) => {
      frameCount++
      assert.equal(frame.type, 'diagnostic')
      diagnosticCount++
      if (measured && diagnosticCount % 4096 === 0)
        sample()
    })
    assert.equal(decodedRows, decoderCount === 0 ? 0 : count)
  }
  else {
    const session = await sessions.parse(provider, { jsonl: bytes(count), source: 'benchmark:fixture-cycle' })
    firstRecordMs = performance.now() - start
    recordCount = session.records.length
    eventCount = session.events.length
    if (measured)
      sample()
  }
  const elapsedMs = performance.now() - start
  if (mode !== 'select') {
    assert.equal(recordCount, count)
    assert.equal(eventCount, workload === 'pi-custom' && decoderCount > 0 ? count * 2 : count)
  }
  if (pi && decoderCount > 0)
    assert.equal(decodedRows, count)
  return { elapsedMs, firstRecordMs, recordCount, eventCount, frameCount, diagnosticCount }
}

let peakHeap = 0
let peakRSS = 0
function sample(): void {
  const memory = process.memoryUsage()
  peakHeap = Math.max(peakHeap, memory.heapUsed)
  peakRSS = Math.max(peakRSS, memory.rss)
}
await consume(mode === 'select' ? records : Math.min(records, pi ? 2000 : 20000), false)
globalThis.gc?.()
const initial = process.memoryUsage()
const cpuStart = process.cpuUsage()
const measuredStart = performance.now()
let measuredEnd = Infinity
let gcCount = 0
let gcMs = 0
const observer = new PerformanceObserver((list) => {
  for (const item of list.getEntries()) {
    if (item.startTime >= measuredStart && item.startTime <= measuredEnd) {
      gcCount++
      gcMs += item.duration
    }
  }
})
observer.observe({ entryTypes: ['gc'] })
const result = await consume(records, true)
measuredEnd = performance.now()
sample()
const cpu = process.cpuUsage(cpuStart)
// GC notifications and their observer delivery can require separate event-loop turns.
await new Promise<void>(resolve => setImmediate(resolve))
await new Promise<void>(resolve => setImmediate(resolve))
observer.disconnect()
globalThis.gc?.()
const retained = process.memoryUsage()
process.stdout.write(`${JSON.stringify({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  mode,
  workload,
  records,
  decoderCount,
  chunkBytes,
  inputBytes,
  ...result,
  recordsPerSecond: records / result.elapsedMs * 1000,
  mibPerSecond: inputBytes / (1024 * 1024) / result.elapsedMs * 1000,
  cpuMs: (cpu.user + cpu.system) / 1000,
  gcCount,
  gcMs,
  initialHeap: initial.heapUsed,
  sampledPeakHeap: peakHeap,
  sampledPeakRSS: peakRSS,
  processPeakRSS: process.resourceUsage().maxRSS * 1024,
  retainedHeap: retained.heapUsed,
  gcAvailable: globalThis.gc !== undefined,
})}\n`)
if (temporary !== undefined)
  await rm(temporary, { recursive: true, force: true })
