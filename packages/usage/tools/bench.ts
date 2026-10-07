import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, cpus, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import type { FrameSelection } from 'huihua'
import { sessions } from 'huihua'

import { UsageReportBuilder } from '../src/report.ts'

const standardModes = ['full', 'selected', 'callback', 'usage', 'iterator-cli', 'cli', 'ccusage'] as const
const control = { facts: false, batchDecode: false, pushdown: false, concurrency: 1 }
const experiments = {
  'control-cli': control,
  'facts-cli': { ...control, facts: true },
  'batch-cli': { ...control, batchDecode: true },
  'pushdown-cli': { ...control, facts: true, pushdown: true },
  'concurrent-2-cli': { ...control, concurrency: 2 },
  'concurrent-4-cli': { ...control, concurrency: 4 },
  'combined-cli': { facts: true, batchDecode: true, pushdown: true, concurrency: 1 },
  'combined-concurrent-cli': { facts: true, batchDecode: true, pushdown: true, concurrency: 4 },
  'cpu-control-cli': { workers: 1 },
  'cpu-2-cli': { workers: 2 },
  'cpu-4-cli': { workers: 4 },
} as const
type Mode = typeof standardModes[number] | keyof typeof experiments | 'baseline' | 'metadata-cli' | 'published-2-cli' | 'published-4-cli'
const fields = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'totalTokens'] as const
const root = fileURLToPath(new URL('../../../', import.meta.url))
const script = fileURLToPath(import.meta.url)
const until = '2026-01-03'

async function worker(mode: string, end = until): Promise<void> {
  const { refs, failures } = await sessions.scan({ providers: ['claude'] })
  assert.deepEqual(failures, [], 'benchmark discovery must be complete')
  const builder = new UsageReportBuilder(refs, { providers: ['claude'], providerIds: sessions.providers().map(provider => provider.id), since: '2026-01-01', until: end, timeZone: 'UTC' })
  for (const ref of refs) {
    const open = await sessions.open(ref)
    const selection: FrameSelection = { events: ['usage'], records: true, metadata: true, metadataKeys: ['parentSessionId'] }
    if (mode === 'usage') {
      assert.ok(open.consumeUsage, 'usage benchmark must use the public evidence-free capability')
      await open.consumeUsage(frame => builder.add(ref, frame))
    }
    else if (mode === 'callback') {
      assert.ok(open.consume, 'callback benchmark must use the public callback capability')
      await open.consume(selection, frame => builder.add(ref, frame))
    }
    else {
      const frames = mode === 'selected' ? open.select?.(selection) ?? open.stream() : open.stream()
      for await (const frame of frames) builder.add(ref, frame)
    }
    builder.end(ref)
  }
  process.stdout.write(`${JSON.stringify(builder.finish(), null, 2)}\n`)
}
interface FixtureRow {
  sessionId: string
  uuid: string
  requestId: string
  timestamp: string
  message: { id: string, model: string, content?: unknown, usage: Record<string, number> }
}
interface ReportShape {
  daily: { date: string, modelsUsed: string[], modelBreakdowns: (Record<string, unknown> & { model?: string, modelName?: string })[] }[]
  totals: Record<string, unknown>
}
function comparable(report: ReportShape): unknown {
  const metrics = (value: unknown) => {
    const tokens = value as Record<string, unknown>
    return Object.fromEntries(fields.map(field => [field, tokens[field]]))
  }
  return {
    daily: report.daily.map(day => ({
      date: day.date,
      ...metrics(day),
      modelsUsed: day.modelsUsed.toSorted(),
      modelBreakdowns: day.modelBreakdowns.map((model) => {
        const total = fields.slice(0, 4).reduce((sum, field) => sum + Number(model[field]), 0)
        if (model.totalTokens !== undefined)
          assert.equal(model.totalTokens, total, 'Claude model total must match its four independent components')
        return { modelName: model.modelName ?? model.model, ...Object.fromEntries(fields.slice(0, 4).map(field => [field, model[field]])), totalTokens: total }
      }).sort((a, b) => String(a.modelName).localeCompare(String(b.modelName))),
    })),
    totals: metrics(report.totals),
  }
}
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
interface Measurement {
  workload: string
  mode: Mode
  repetition: number
  fullOutputMs: number
  firstOutputMs: number
  peakRssKb: number
  outputBytes: number
  outputSha256: string
}
async function measure(mode: Mode, config: string, binary: string, iteratorCli: string, baseline?: string, end = until, wrappers: Readonly<Record<string, string>> = {}, metadataCli?: string): Promise<{ measurement: Omit<Measurement, 'workload' | 'repetition'>, report: ReportShape }> {
  const published = mode === 'published-2-cli' ? '2' : mode === 'published-4-cli' ? '4' : undefined
  const args = mode === 'ccusage'
    ? ['claude', 'daily', '--since', '20260101', '--until', end.replaceAll('-', ''), '--timezone', 'UTC', '--json', '--mode', 'display', '--no-cost']
    : published !== undefined || mode === 'cli' || mode === 'baseline' || mode === 'metadata-cli' || mode === 'iterator-cli' || wrappers[mode] !== undefined
      ? [mode === 'baseline' ? baseline! : mode === 'metadata-cli' ? metadataCli! : mode === 'iterator-cli' ? iteratorCli : wrappers[mode] ?? join(root, 'packages/usage/dist/cli.js'), '--provider', 'claude', '--since', '2026-01-01', '--until', end, '--timezone', 'UTC', '--json', ...published === undefined ? [] : ['--workers', published]]
      : [script, '--worker', mode, end]
  const command = mode === 'ccusage' ? binary : process.execPath
  const start = process.hrtime.bigint()
  const child = spawn(command, args, { cwd: root, env: { ...process.env, HOME: dirname(config), XDG_CONFIG_HOME: join(dirname(config), '.config'), CLAUDE_CONFIG_DIR: config, TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const output: Uint8Array[] = []
  let first: bigint | undefined
  let peak = 0
  let stderr = ''
  const sample = () => {
    try {
      const match = readFileSync(`/proc/${child.pid}/status`, 'utf8').match(/^VmHWM:\s+(\d+)\s+kB$/m)
      if (match !== null)
        peak = Math.max(peak, Number(match[1]))
    }
    catch { /* A process may exit between samples. */ }
  }
  sample()
  const timer = setInterval(sample, 2)
  child.stdout.on('data', (data: Uint8Array) => {
    first ??= process.hrtime.bigint()
    output.push(data)
  })
  child.stderr.on('data', (data: Uint8Array) => {
    stderr += Buffer.from(data).toString()
  })
  try {
    const code = await new Promise<number | null>((accept, reject) => {
      child.on('error', reject)
      child.on('close', accept)
    })
    const end = process.hrtime.bigint()
    assert.equal(code, 0, `${mode}: ${stderr}`)
    assert.ok(first !== undefined, 'the complete report must emit a result')
    const stdout = Buffer.concat(output)
    return {
      measurement: { mode, fullOutputMs: Number(end - start) / 1e6, firstOutputMs: Number(first - start) / 1e6, peakRssKb: peak, outputBytes: stdout.length, outputSha256: sha256(stdout) },
      report: JSON.parse(stdout.toString()) as ReportShape,
    }
  }
  finally {
    clearInterval(timer)
  }
}
async function benchmark(binary: string, outputPath: string, baseline?: string, final = false, cpu = false, metadataCli?: string, published = false): Promise<void> {
  assert.equal(process.platform, 'linux', 'VmHWM measurement requires Linux')
  const temporary = await mkdtemp(join(tmpdir(), 'huihua-usage-benchmark-'))
  const modes: readonly Mode[] = [...baseline === undefined ? [] : ['baseline' as const], ...metadataCli === undefined ? [] : ['metadata-cli' as const], ...published ? ['cli', 'published-2-cli', 'published-4-cli', 'ccusage'] as const : cpu ? ['cli', 'cpu-control-cli', 'cpu-2-cli', 'cpu-4-cli', 'ccusage'] as const : final ? ['cli', 'control-cli', 'facts-cli', 'pushdown-cli', 'ccusage'] as const : [...standardModes, ...Object.keys(experiments) as (keyof typeof experiments)[]]]
  const repetitions = final || cpu || published ? 15 : 7
  try {
    // The private CLI runner disables callback delivery only for this controlled comparison.
    const iteratorCli = join(temporary, 'iterator-cli.mjs')
    const iteratorWrapper = `import {run} from ${JSON.stringify(new URL('../dist/cli.js', import.meta.url).href)};\nawait run(process.argv.slice(2),false);\n`
    await writeFile(iteratorCli, iteratorWrapper)
    const wrappers: Record<string, string> = {}
    const wrapperSources: Record<string, { options: unknown, script: string, sha256: string }> = {}
    for (const [mode, options] of Object.entries(experiments)) {
      const path = join(temporary, `${mode}.mjs`)
      const script = `import {run} from ${JSON.stringify(new URL('../dist/cli.js', import.meta.url).href)};\nawait run(process.argv.slice(2),true,${JSON.stringify(options)});\n`
      await writeFile(path, script)
      wrappers[mode] = path
      wrapperSources[mode] = { options, script, sha256: sha256(script) }
    }
    const base = JSON.parse((await readFile(join(root, 'fixtures/claude/usage-only.jsonl'), 'utf8')).split('\n')[0]!) as FixtureRow
    const content = (JSON.parse((await readFile(join(root, 'fixtures/claude/simple.jsonl'), 'utf8')).trim().split('\n')[1]!) as FixtureRow).message.content
    const workloads = published ? ['usage-only', 'many-files-content', 'large-files-content'] : ['usage-only', 'content', 'daily-models', 'narrow-date', 'many-files', ...cpu ? ['many-files-content', 'large-files-content'] : []]
    const inputs: { workload: string, rows: number, bytes: number, sha256: string, until: string, files: { path: string, bytes: number, sha256: string }[] }[] = []
    const results: Measurement[] = []
    const comparableReports: Record<string, unknown> = {}
    for (const workload of workloads) {
      const config = join(temporary, workload, '.claude')
      const projects = join(config, 'projects/test')
      await mkdir(projects, { recursive: true })
      const multiple = workload.startsWith('many-files') || workload === 'large-files-content'
      const rich = ['daily-models', 'narrow-date'].includes(workload) || multiple
      const rowCount = workload === 'large-files-content' ? 100_000 : 20_000
      const end = workload === 'narrow-date' ? '2026-01-01' : until
      const lines = Array.from({ length: rowCount }, (_, index) => JSON.stringify({
        ...base,
        uuid: `row-${index}`,
        requestId: `request-${index}`,
        timestamp: `2026-01-${String(workload === 'narrow-date' ? index % 31 + 1 : rich ? index % 3 + 1 : 1).padStart(2, '0')}T00:00:00Z`,
        ...(multiple ? { sessionId: `fixture-session-${Math.floor(index / (workload === 'large-files-content' ? 10_000 : 200))}` } : {}),
        message: {
          ...base.message,
          id: `message-${index}`,
          model: rich ? `fixture-model-${index % 2}` : base.message.model,
          ...(workload.includes('content') ? { content: Array.from({ length: 16 }).fill((content as unknown[])[0]) } : {}),
          usage: { input_tokens: rich ? 100 + index % 7 : 0, output_tokens: rich ? 4 + index % 3 : 4, cache_creation_input_tokens: rich ? 5 + index % 2 : 0, cache_read_input_tokens: rich ? 20 + index % 4 : 0 },
        },
      }))
      const input = `${lines.join('\n')}\n`
      const files: { path: string, bytes: number, sha256: string }[] = []
      const fileCount = workload === 'large-files-content' ? 10 : multiple ? 100 : 1
      for (let index = 0; index < fileCount; index++) {
        const text = fileCount === 1 ? input : `${lines.slice(index * rowCount / fileCount, (index + 1) * rowCount / fileCount).join('\n')}\n`
        const path = fileCount === 1 ? 'usage.jsonl' : `session-${String(index).padStart(3, '0')}.jsonl`
        await writeFile(join(projects, path), text)
        files.push({ path, bytes: Buffer.byteLength(text), sha256: sha256(text) })
      }
      inputs.push({ workload, rows: rowCount, bytes: Buffer.byteLength(input), sha256: sha256(input), until: end, files })
      let huihuaHash: string | undefined
      const checked = async (mode: Mode) => {
        const result = await measure(mode, config, binary, iteratorCli, baseline, end, wrappers, metadataCli)
        const normalized = comparable(result.report)
        if (comparableReports[workload] !== undefined)
          assert.deepEqual(normalized, comparableReports[workload], 'daily/model/input/output/cache/total semantics must match before accepting timings')
        comparableReports[workload] ??= normalized
        if (mode !== 'ccusage') {
          assert.equal(result.report.totals.availability, 'complete')
          huihuaHash ??= result.measurement.outputSha256
          assert.equal(result.measurement.outputSha256, huihuaHash, 'full/selected/actual CLI reports must be byte-identical')
        }
        return result.measurement
      }
      for (const mode of modes) await checked(mode)
      for (let repetition = 0; repetition < repetitions; repetition++) {
        const rotated = [...modes.slice(repetition % modes.length), ...modes.slice(0, repetition % modes.length)]
        for (const mode of repetition % 2 === 0 ? rotated : rotated.reverse())
          results.push({ ...await checked(mode), workload, repetition })
      }
      process.stderr.write(`Measured ${workload}; daily/model counters matched.\n`)
    }
    const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!
    const summaries = inputs.flatMap(input => modes.map((mode) => {
      const rows = results.filter(row => row.workload === input.workload && row.mode === mode)
      return { workload: input.workload, mode, fullOutputMs: median(rows.map(row => row.fullOutputMs)), firstOutputMs: median(rows.map(row => row.firstOutputMs)), peakRssKb: median(rows.map(row => row.peakRssKb)), outputBytes: rows[0]!.outputBytes, outputSha256: rows[0]!.outputSha256 }
    }))
    const sources = Object.fromEntries(await Promise.all(['packages/usage/src/report.ts', 'packages/usage/src/cli.ts', 'packages/usage/src/worker.ts', 'packages/usage/src/options.ts', 'packages/usage/package.json', 'packages/usage/tsdown.config.ts', ...(await readdir(join(root, 'packages/usage/dist'))).filter(path => path.endsWith('.js')).map(path => `packages/usage/dist/${path}`), 'packages/usage/tools/bench.ts', 'src/shared/jsonl.ts', 'src/shared/ingestion.ts', 'src/providers/claude/index.ts', 'src/providers/codex/index.ts', 'src/contracts/session.ts', 'src/contracts/provider.ts', 'src/registry.ts', 'package.json', 'tsdown.config.ts'].map(async path => [path, sha256(await readFile(join(root, path)))] as const)))
    const baselinePackage = baseline === undefined ? undefined : join(dirname(baseline), '../node_modules/huihua')
    const baselineConsumerPackage = baseline === undefined ? undefined : await readFile(join(dirname(baseline), '../package.json')).catch(() => undefined)
    const baselineDist = baselinePackage === undefined ? undefined : Object.fromEntries(await Promise.all((await readdir(join(baselinePackage, 'dist'), { recursive: true })).filter(path => path.endsWith('.js') || path.endsWith('.d.ts')).sort().map(async path => [path, sha256(await readFile(join(baselinePackage, 'dist', path)))] as const)))
    const metadata = {
      node: process.version,
      huihua: (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }).version,
      usageCli: (JSON.parse(await readFile(join(root, 'packages/usage/package.json'), 'utf8')) as { version: string }).version,
      ccusage: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
      binarySha256: sha256(await readFile(binary)),
      packageManager: 'pnpm@12.4.2',
      os: (await readFile('/etc/os-release', 'utf8')).match(/^PRETTY_NAME=(.*)$/m)?.[1],
      kernel: release(),
      arch: process.arch,
      cpu: cpus()[0]?.model,
      onlineCpus: availableParallelism(),
      warmups: 1,
      repetitions,
      phase: published ? 'published-worker-cli' : cpu ? 'metadata-cpu-workers' : final ? 'final-defaults' : 'four-experiments',
      filters: { provider: 'claude', since: '2026-01-01', until, timeZone: 'UTC', json: true, cost: false },
      sources,
      ...(published ? { workerCliArguments: { 'published-2-cli': ['--workers', '2'], 'published-4-cli': ['--workers', '4'] }, executionLimits: 'Actual emitted CLI with user flags, no wrapper. Single-file input falls back to serial reading in every worker mode. Buffered providers and repeated source selectors also remain serial.' } : {}),
      ...(metadataCli === undefined ? {} : { metadataOnly: { cliSha256: sha256(await readFile(metadataCli)), corePackageSha256: sha256(await readFile(join(dirname(metadataCli), '../node_modules/huihua/package.json'))), limits: 'Same preserved compiled CLI/report as baseline with the current public Huihua core; isolates metadata demand from the CPU scheduling/consumer build changes. No worker scheduling in this mode.' } }),
      iteratorCli: { wrapper: iteratorWrapper, sha256: sha256(iteratorWrapper), limits: 'Same built package and private CLI run function; disables callback and evidence-free usage delivery. One extra small ESM entry module compared with direct CLI startup.' },
      experiments: { wrappers: wrapperSources, limits: 'Every tuning mode uses the same built runner/core and one small ESM wrapper. Compare pushdown with facts-cli; compare other individual experiments with control-cli. Actual CLI and preserved baseline have no wrapper.' },
      ...(baseline === undefined ? {} : { baseline: { cliSha256: sha256(await readFile(baseline)), reportSha256: sha256(await readFile(join(dirname(baseline), 'report.ts'))), packageSha256: sha256(await readFile(join(baselinePackage!, 'package.json'))), consumerPackageSha256: baselineConsumerPackage === undefined ? null : sha256(baselineConsumerPackage), dist: baselineDist } }),
      inputs,
      method: 'Fresh sequential child processes, rotated/reversed order. Optional previous CLI receives identical input paths and must produce byte-identical complete JSON. Spawn to close and first stdout byte. Child process kernel VmHWM includes every worker thread/isolate, sampled every 2 ms; a final peak can be missed.',
      limits: 'Fixture-derived synthetic inputs, unique identities, no replay/fork/snapshots/native cost. Daily/model counters match; Huihua additionally serializes confidence, provenance, diagnostics and per-session results. No real-user or production speed claim.',
    }
    await writeFile(outputPath, `${JSON.stringify({ metadata, comparableReports, summaries, results }, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(summaries, null, 2)}\n`)
  }
  finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv[0] === '--')
    argv.shift()
  if (argv[0] === '--worker') {
    await worker(argv[1] ?? 'full', argv[2] ?? until)
  }
  else {
    assert.ok(argv[0] !== undefined && argv[1] !== undefined, 'Usage: pnpm --filter @huihua/usage bench -- <ccusage-binary> <results.json> [previous-cli.ts-or-js] [--final|--cpu] [--metadata=compiled-cli]')
    const previous = argv[2]?.startsWith('--') ? undefined : argv[2]
    const metadata = argv.find(value => value.startsWith('--metadata='))?.slice('--metadata='.length)
    await benchmark(resolve(argv[0]), resolve(argv[1]), previous === undefined ? undefined : resolve(previous), argv.includes('--final'), argv.includes('--cpu'), metadata === undefined ? undefined : resolve(metadata), argv.includes('--published'))
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
