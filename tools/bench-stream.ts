import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const [mode = 'stream', size = '100000', chunkSize = '65536', workload = 'messages', entry = 'src/index.ts'] = process.argv.slice(2)
const records = Number(size)
const chunkBytes = Number(chunkSize)
if (!['stream', 'parse'].includes(mode) || !['messages', 'mixed'].includes(workload)
  || !Number.isSafeInteger(records) || records < 1 || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
  throw new TypeError('usage: bench-stream.ts [stream|parse] [records>0] [chunkBytes>0] [messages|mixed] [entrypoint]')
}
const { sessions } = await import(pathToFileURL(resolve(entry)).href) as typeof import('../src/index.ts')
const lines = async (path: string) => (await readFile(resolve('fixtures/codex', path), 'utf8')).trimEnd().split('\n')
const messages = (await lines('simple.jsonl')).slice(1)
const cycle = workload === 'messages'
  ? messages
  : [...messages, ...(await lines('tool-call.jsonl')).slice(1), ...(await lines('unknown.jsonl')).slice(1), ...(await lines('malformed.jsonl')).slice(1, 2)]

// Reuse a fixed block; input allocation must not grow with transcript length.
const blockRecords = cycle.length * 1024
const block = Buffer.from(`${Array.from({ length: blockRecords }, (_, i) => cycle[i % cycle.length]).join('\n')}\n`)
const tail = Buffer.from(`${Array.from({ length: records % blockRecords }, (_, i) => cycle[i % cycle.length]).join('\n')}${records % blockRecords ? '\n' : ''}`)
const inputBytes = Math.floor(records / blockRecords) * block.length + tail.length
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
  let firstRecordMs: number | undefined
  const start = performance.now()
  if (mode === 'stream') {
    for await (const frame of sessions.stream('codex', { jsonl: bytes(count), source: 'benchmark:fixture-cycle' })) {
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
    }
  }
  else {
    const session = await sessions.parse('codex', { jsonl: bytes(count), source: 'benchmark:fixture-cycle' })
    firstRecordMs = performance.now() - start
    recordCount = session.records.length
    eventCount = session.events.length
    if (measured)
      sample()
  }
  const elapsedMs = performance.now() - start
  assert.equal(recordCount, count)
  assert.equal(eventCount, count)
  return { elapsedMs, firstRecordMs, recordCount, eventCount, frameCount }
}

let peakHeap = 0
let peakRSS = 0
function sample(): void {
  const memory = process.memoryUsage()
  peakHeap = Math.max(peakHeap, memory.heapUsed)
  peakRSS = Math.max(peakRSS, memory.rss)
}
await consume(Math.min(records, 20000), false)
globalThis.gc?.()
const initial = process.memoryUsage()
const cpuStart = process.cpuUsage()
const result = await consume(records, true)
sample()
const cpu = process.cpuUsage(cpuStart)
globalThis.gc?.()
const retained = process.memoryUsage()
process.stdout.write(`${JSON.stringify({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  mode,
  workload,
  records,
  chunkBytes,
  inputBytes,
  ...result,
  recordsPerSecond: records / result.elapsedMs * 1000,
  mibPerSecond: inputBytes / (1024 * 1024) / result.elapsedMs * 1000,
  cpuMs: (cpu.user + cpu.system) / 1000,
  initialHeap: initial.heapUsed,
  sampledPeakHeap: peakHeap,
  sampledPeakRSS: peakRSS,
  processPeakRSS: process.resourceUsage().maxRSS * 1024,
  retainedHeap: retained.heapUsed,
  gcAvailable: globalThis.gc !== undefined,
})}\n`)
