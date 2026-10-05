import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import type { SessionFrame } from '../src/contracts/session.ts'
import { sessions } from '../src/index.ts'

const providers = ['codex', 'claude', 'pi', 'cursor'] as const
type Provider = typeof providers[number]
type Mode = 'scan' | 'events' | 'stream' | 'early' | 'abort' | 'snapshot'
type Template = { records: unknown[], grow: (record: unknown, value: string) => void }
type Manifest = {
  provider: Provider
  path: string
  bytes: number
  records: number
  expectedEvents: number
  expectedDiagnostics: number
}
const MiB = 1024 ** 2
const GiB = 1024 ** 3

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : process.argv[i + 1]
}
function numberArg(name: string, fallback: number): number {
  const value = Number(arg(name, String(fallback)))
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`--${name} must be a positive safe integer`)
  return value
}
function bytesArg(value: string): number {
  const match = /^(\d+)(MiB|GiB)$/.exec(value)
  if (!match)
    throw new Error(`invalid size ${value}; use e.g. 2MiB or 1GiB`)
  const count = Number(match[1])
  return count * (match[2] === 'GiB' ? GiB : MiB)
}
function json(value: unknown): string {
  const result = JSON.stringify(value)
  if (result === undefined)
    throw new TypeError('value cannot be serialized as JSON')
  return result
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('expected a JSON object')
  return value as Record<string, unknown>
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new TypeError('expected a JSON array')
  return value
}
function appendText(row: Record<string, unknown>, key: string, value: string): void {
  if (typeof row[key] !== 'string')
    throw new TypeError(`expected string field ${key}`)
  row[key] = `${row[key]}${value}`
}
function setText(record: unknown, provider: Provider, field: string, value: string): void {
  const row = object(record)
  if (provider === 'codex') {
    const payload = object(row.payload)
    if (field === 'reasoning')
      appendText(object(array(payload.summary)[0]), 'text', value)
    else appendText(object(array(payload.content)[0]), 'text', value)
  }
  else if (provider === 'claude') {
    const key = field === 'reasoning' ? 'thinking' : 'text'
    const message = object(row.message)
    if (Array.isArray(message.content))
      appendText(object(message.content[0]), key, value)
    else appendText(message, 'content', value)
  }
  else if (provider === 'pi') {
    const key = field === 'reasoning' ? 'thinking' : 'text'
    const blocks = array(object(row.message).content).map(object)
    const block = blocks.find(item => item.type === key)
    if (!block)
      throw new TypeError(`Pi template has no ${key} block`)
    appendText(block, key, value)
  }
  else {
    const message = object(row.message)
    const content = message.content
    if (Array.isArray(content))
      appendText(object(content[0]), 'text', value)
    else appendText(message, 'content', value)
  }
}
function addResultText(record: unknown, provider: Provider, value: string): void {
  const row = object(record)
  if (provider === 'codex') {
    appendText(object(row.payload), 'output', value)
    return
  }
  const message = object(row.message)
  if (provider === 'pi') {
    appendText(object(array(message.content)[0]), 'text', value)
    return
  }
  const block = object(array(message.content)[0])
  if (provider === 'claude')
    appendText(object(array(block.content)[0]), 'text', value)
  else appendText(block, 'content', value)
}
function padTemplate(records: unknown[], provider: Provider): void {
  for (const record of records.slice(1)) {
    const row = object(record)
    const message = row.message === undefined ? {} : object(row.message)
    const blocks = Array.isArray(message.content) ? message.content.map(object) : []
    const codexPayload = provider === 'codex' ? object(row.payload) : {}
    const hasText = typeof message.content === 'string'
      || blocks.some(block => ['text', 'input_text', 'output_text'].includes(String(block.type)))
      || (provider === 'codex' && codexPayload.type === 'message')
    const isReasoning = (provider === 'codex' && codexPayload.type === 'reasoning')
      || blocks.some(block => block.type === 'thinking')
    const isResult = (provider === 'codex' && codexPayload.type === 'function_call_output')
      || blocks.some(block => block.type === 'tool_result')
      || message.role === 'toolResult'
    if (isResult) {
      addResultText(record, provider, 'r'.repeat(384))
      continue
    }
    if (isReasoning)
      setText(record, provider, 'reasoning', 't'.repeat(384))
    if (provider === 'pi' && blocks.some(block => block.type === 'text'))
      setText(record, provider, 'text', 'a'.repeat(512))
    else if (!isReasoning && hasText && (row.type === 'user' || row.type === 'assistant' || codexPayload.type === 'message' || message.role === 'user' || message.role === 'assistant' || row.role === 'user' || row.role === 'assistant'))
      setText(record, provider, 'text', 'm'.repeat(row.type === 'user' || message.role === 'user' || row.role === 'user' || codexPayload.role === 'user' ? 384 : 512))
  }
}
async function loadTemplate(provider: Provider): Promise<Template> {
  const root = resolve('fixtures', provider)
  const lines = async (file: string): Promise<unknown[]> => (await readFile(join(root, file), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as unknown)
  let header: unknown
  let cycle: unknown[]
  if (provider === 'codex') {
    const [base, variants, tools] = await Promise.all([lines('simple.jsonl'), lines('schema-variation.jsonl'), lines('tool-call.jsonl')])
    header = base[0]
    cycle = [base[1], variants[1], base[2], tools[1], tools[2], base[2]]
  }
  else if (provider === 'claude') {
    const [base, variants, tools] = await Promise.all([lines('simple.jsonl'), lines('schema-variation.jsonl'), lines('tool-call.jsonl')])
    header = base[0]
    cycle = [base[0], variants[1], base[1], tools[1], tools[2], base[1]]
  }
  else if (provider === 'pi') {
    const [base, tools] = await Promise.all([lines('simple.jsonl'), lines('tool-call.jsonl')])
    header = base[0]
    cycle = [base[1], base[2], tools[2], tools[3], base[2]]
  }
  else {
    const [base, tools] = await Promise.all([lines('simple.jsonl'), lines('tool-call.jsonl')])
    const cursorHeader = structuredClone(base[0])
    object(cursorHeader).sessionId = 'cursor-bench'
    header = cursorHeader
    cycle = [base[0], tools[1], tools[2], base[1]]
  }
  const records = [header, ...cycle]
  padTemplate(records, provider)
  const grow = (record: unknown, value: string) => {
    const row = object(record)
    const message = row.message === undefined ? {} : object(row.message)
    const content = Array.isArray(message.content) ? message.content.map(object) : []
    const type = (provider === 'codex' && object(row.payload).type === 'reasoning')
      || (provider === 'claude' && content[0]?.type === 'thinking')
      || (provider === 'pi' && content.some(block => block.type === 'thinking'))
    setText(record, provider, type ? 'reasoning' : 'text', value)
  }
  return { records, grow }
}
function countFrames(frames: AsyncIterable<SessionFrame>, onFrame: (frame: SessionFrame) => void): AsyncIterable<SessionFrame> {
  return {
    async* [Symbol.asyncIterator]() {
      for await (const frame of frames) {
        onFrame(frame)
        yield frame
      }
    },
  }
}
async function lineMetrics(template: Template, provider: Provider): Promise<{ headerEvents: number, headerDiagnostics: number, cycleEvents: number, cycleDiagnostics: number }> {
  const header = await sessions.parse(provider, { jsonl: `${json(template.records[0])}\n` })
  const text = `${template.records.slice(1).map(row => json(row)).join('\n')}\n`
  const result = await sessions.parse(provider, { jsonl: text })
  return { headerEvents: header.events.length, headerDiagnostics: header.diagnostics.length, cycleEvents: result.events.length, cycleDiagnostics: result.diagnostics.length }
}
async function makeManifest(provider: Provider, path: string, bytes: number): Promise<Manifest> {
  const template = await loadTemplate(provider)
  const measure = await lineMetrics(template, provider)
  const cycleBytes = template.records.slice(1).reduce<number>((sum, row) => sum + Buffer.byteLength(`${json(row)}\n`), 0)
  const cycleCount = Math.floor((bytes - Buffer.byteLength(`${json(template.records[0])}\n`)) / cycleBytes)
  const out = createWriteStream(path, { flags: 'w', highWaterMark: 64 * 1024 })
  let written = 0
  const write = async (value: string) => {
    if (!out.write(value))
      await once(out, 'drain')
    written += Buffer.byteLength(value)
  }
  try {
    await write(`${json(template.records[0])}\n`)
    for (let n = 0; n < cycleCount; n++) {
      for (let i = 1; i < template.records.length; i++) {
        const record = structuredClone(template.records[i])
        if (n === cycleCount - 1 && i === template.records.length - 1) {
          const base = `${json(record)}\n`
          const chars = bytes - written - Buffer.byteLength(base)
          if (chars < 0)
            throw new Error('cannot fit final JSONL record into requested exact size')
          template.grow(record, 'x'.repeat(chars))
        }
        await write(`${json(record)}\n`)
        if (written > bytes)
          throw new Error(`generator exceeded target (${written} > ${bytes})`)
      }
    }
    if (written < bytes) {
      // Fill a sub-cycle remainder by extending one final valid assistant/user text record.
      throw new Error(`target leaves an unfillable tail of ${bytes - written} bytes; select a size divisible by the fixture cycle`)
    }
    await new Promise<void>((resolveWrite, reject) => {
      out.once('error', reject)
      out.end(() => {
        out.off('error', reject)
        resolveWrite()
      })
    })
  }
  catch (error) {
    out.destroy()
    throw error
  }
  const info = await stat(path)
  assert.equal(info.size, bytes)
  return {
    provider,
    path,
    bytes,
    records: 1 + cycleCount * (template.records.length - 1),
    expectedEvents: measure.headerEvents + measure.cycleEvents * cycleCount,
    expectedDiagnostics: measure.headerDiagnostics + measure.cycleDiagnostics * cycleCount,
  }
}
async function generate(outDir: string, provider: Provider, bytes: number): Promise<Manifest> {
  await access(outDir)
  return makeManifest(provider, join(outDir, `${provider}-${bytes}.jsonl`), bytes)
}

async function worker(mode: Mode, manifest: Manifest, earlyRecords: number): Promise<void> {
  let handleActive = false
  const startCpu = process.cpuUsage()
  const started = performance.now()
  let first: number | undefined
  let records = 0
  let events = 0
  let diagnostics = 0
  let frames = 0
  const noteFrame = (frame: SessionFrame) => {
    frames++
    if (first === undefined)
      first = performance.now()
    if (frame.type === 'record')
      records++
    if (frame.type === 'event')
      events++
    if (frame.type === 'diagnostic')
      diagnostics++
  }
  const refs = await sessions.scan({ providers: [manifest.provider], roots: { [manifest.provider]: [manifest.path] }, headerBytes: 16 * 1024 })
  assert.equal(refs.length, 1)
  const ref = refs[0]!
  if (mode === 'scan') {
    process.send?.({ result: { mode, elapsedMs: performance.now() - started, refs: refs.length, cpuUs: cpu(startCpu), validated: refs.length === 1 } })
    return
  }
  const opened = await sessions.open(ref)
  handleActive = true
  const parseCpu = process.cpuUsage()
  const parsingStarted = performance.now()
  let error: string | undefined
  try {
    if (mode === 'events') {
      for await (const _event of opened.events()) {
        events++
        if (first === undefined)
          first = performance.now()
      }
    }
    else if (mode === 'stream') {
      for await (const frame of countFrames(opened.stream(), noteFrame)) void frame
    }
    else if (mode === 'early') {
      for await (const _frame of countFrames(opened.stream(), noteFrame)) {
        if (records >= earlyRecords)
          break
      }
    }
    else if (mode === 'abort') {
      const controller = new AbortController()
      const aborted = await sessions.open(ref, { signal: controller.signal })
      try {
        for await (const frame of countFrames(aborted.stream(), noteFrame)) {
          if (records >= earlyRecords)
            controller.abort(new Error('benchmark cancellation'))
          void frame
        }
      }
      catch (e) { error = e instanceof Error ? e.message : String(e) }
      handleActive = false
    }
    else if (mode === 'snapshot') {
      const snapshot = await opened.snapshot()
      records = snapshot.records.length
      events = snapshot.events.length
      diagnostics = snapshot.diagnostics.length
    }
  }
  finally { handleActive = false }
  const elapsedMs = performance.now() - parsingStarted
  let fdClosed: boolean | null = null
  if (process.platform === 'linux') {
    const { readdir, readlink } = await import('node:fs/promises')
    const paths = await Promise.all((await readdir('/proc/self/fd')).map(async fd => readlink(`/proc/self/fd/${fd}`).catch(() => '')))
    fdClosed = !paths.includes(manifest.path)
  }
  const result = {
    mode,
    elapsedMs,
    firstMs: first === undefined ? null : first - parsingStarted,
    records,
    events,
    diagnostics,
    frames,
    expectedRecords: manifest.records,
    expectedEvents: manifest.expectedEvents,
    expectedDiagnostics: manifest.expectedDiagnostics,
    eof: ['events', 'stream', 'snapshot'].includes(mode),
    error: error ?? null,
    resourcesClosed: !handleActive && (mode === 'early' || mode === 'abort') ? fdClosed : null,
    cpuUs: cpu(parseCpu),
  }
  const valid = mode === 'events'
    ? events === manifest.expectedEvents && result.eof
    : mode === 'stream' || mode === 'snapshot'
      ? records === manifest.records && events === manifest.expectedEvents && diagnostics === manifest.expectedDiagnostics && result.eof
      : records >= earlyRecords && result.resourcesClosed === true
  Object.assign(result, { validated: valid })
  process.send?.({ result })
}
function cpu(start: NodeJS.CpuUsage): number {
  const usage = process.cpuUsage(start)
  return usage.user + usage.system
}
async function childRun(mode: Mode, manifest: Manifest, earlyRecords: number, timeoutMs: number, profileDir: string | undefined, childExec: string): Promise<Record<string, unknown>> {
  const profileArgs = profileDir === undefined ? [] : ['--cpu-prof', `--cpu-prof-dir=${profileDir}`]
  const child = spawn(childExec, [...profileArgs, fileURLToPath(import.meta.url), '--worker', mode, JSON.stringify(manifest), String(earlyRecords)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  const stderrStream = child.stderr
  if (!stderrStream)
    throw new Error('worker stderr pipe unavailable')
  stderrStream.setEncoding('utf8')
  stderrStream.on('data', (chunk: string) => {
    stderr += chunk
  })
  let result: Record<string, unknown> | undefined
  let peakRss = 0
  let peakHeap = 0
  let heapSamples = 0
  child.on('message', (message) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message))
      return
    const content = object(message)
    if ('result' in content)
      result = object(content.result)
    if ('memory' in content) {
      const memory = object(content.memory)
      peakRss = Math.max(peakRss, Number(memory.rss))
      peakHeap = Math.max(peakHeap, Number(memory.heapUsed))
      heapSamples++
    }
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 128 : null)))
  })
  clearTimeout(timer)
  if (exitCode !== 0 || result === undefined)
    return { mode, runtimeError: `worker failed (${exitCode}): ${stderr}`, timedOut: exitCode === 128 }
  return { ...result, peakRssBytes: peakRss, peakHeapUsedBytes: peakHeap, memorySamples: heapSamples, stderr }
}
async function runParent(): Promise<void> {
  const modeValue = arg('mode', 'all')!
  const repetitions = numberArg('repetitions', 3)
  const earlyRecords = numberArg('early-records', 100)
  const timeoutMs = numberArg('timeout-ms', 30 * 60 * 1000)
  const profileDir = arg('cpu-profile-dir')
  const childExec = arg('child-exec') ?? process.execPath
  if (profileDir !== undefined && profileDir !== '')
    await mkdir(resolve(profileDir), { recursive: true })
  const profilePath = profileDir === undefined || profileDir === '' ? undefined : resolve(profileDir)
  const sizeSpecs = (arg('sizes', '16MiB')!).split(',')
  const selectedProviders = (arg('providers', providers.join(','))!).split(',') as Provider[]
  if (selectedProviders.some(provider => !providers.includes(provider)))
    throw new Error('unknown provider')
  const modes: Mode[] = modeValue === 'all' ? ['scan', 'events', 'stream', 'early', 'abort'] : [modeValue as Mode]
  const owned = arg('out') === undefined
  const outDir = arg('out') ?? await mkdtemp(join(tmpdir(), 'huihua-jsonl-bench-'))
  const manifestPath = join(outDir, 'manifest.json')
  const manifests: Manifest[] = []
  const output: Record<string, unknown>[] = []
  try {
    const generationStart = performance.now()
    for (const sizeSpec of sizeSpecs) {
      const bytes = bytesArg(sizeSpec)
      for (const provider of selectedProviders)
        manifests.push(await generate(outDir, provider, bytes))
    }
    const { writeFile } = await import('node:fs/promises')
    await writeFile(manifestPath, JSON.stringify(manifests, null, 2))
    process.stderr.write(`generated ${manifests.length} files in ${((performance.now() - generationStart) / 1000).toFixed(2)}s at ${outDir}\n`)
    for (const manifest of manifests) {
      for (const mode of modes) {
        const runs = []
        for (let repetition = 0; repetition < repetitions; repetition++)
          runs.push(await childRun(mode, manifest, earlyRecords, timeoutMs, profilePath, childExec))
        for (const run of runs) {
          if (typeof run.elapsedMs === 'number') {
            const readsToEof = ['events', 'stream', 'snapshot'].includes(mode)
            run.mibPerSecond = readsToEof ? (manifest.bytes / MiB) / (run.elapsedMs / 1000) : null
            run.recordsPerSecond = readsToEof
              ? manifest.records / (run.elapsedMs / 1000)
              : mode === 'early' || mode === 'abort'
                ? Number(run.records ?? 0) / (run.elapsedMs / 1000)
                : null
          }
        }
        output.push({ provider: manifest.provider, bytes: manifest.bytes, records: manifest.records, mode, runs, medianElapsedMs: median(runs.filter(run => typeof run.elapsedMs === 'number').map(run => Number(run.elapsedMs))) })
      }
    }
    process.stdout.write(`${JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, childExec, outDir, results: output }, null, 2)}\n`)
    if (output.some(item => (item.runs as Record<string, unknown>[]).some(run => run.validated === false || run.runtimeError !== undefined)))
      process.exitCode = 1
  }
  finally {
    if (owned)
      await rm(outDir, { recursive: true, force: true })
  }
}
function median(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0)
    return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}
if (process.argv[2] === '--worker') {
  const mode = process.argv[3] as Mode
  const manifest = JSON.parse(process.argv[4]!) as Manifest
  const limit = Number(process.argv[5])
  process.send?.({ memory: process.memoryUsage() })
  const sampler = setInterval(() => process.send?.({ memory: process.memoryUsage() }), 100)
  try {
    await worker(mode, manifest, limit)
    process.send?.({ memory: process.memoryUsage() })
  }
  finally {
    clearInterval(sampler)
    process.disconnect?.()
  }
}
else {
  await runParent()
}
