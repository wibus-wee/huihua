#!/usr/bin/env node
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { isMainThread, Worker } from 'node:worker_threads'

import type { FrameSelection, OpenSession, SessionProvider, SessionRef } from 'huihua'
import { createSessionRegistry } from 'huihua/registry'

import { parseUsageArgs } from './options.ts'
import type { UsagePartition } from './report.ts'
import { formatUsageReport, UsageReportBuilder } from './report.ts'

// Consumer composition uses public provider modules; discovery and parsing remain provider-owned.
const providers: Readonly<Record<string, () => Promise<SessionProvider>>> = {
  claude: async () => (await import('huihua/providers/claude')).claudeProvider,
  codex: async () => (await import('huihua/providers/codex')).codexProvider,
  cursor: async () => (await import('huihua/providers/cursor')).cursorProvider,
  opencode: async () => (await import('huihua/providers/opencode')).opencodeProvider,
  pi: async () => (await import('huihua/providers/pi')).piProvider,
  acp: async () => (await import('huihua/providers/acp')).acpProvider,
  antigravity: async () => (await import('huihua/providers/antigravity')).antigravityProvider,
  grok: async () => (await import('huihua/providers/grok')).grokProvider,
  kimi: async () => (await import('huihua/providers/kimi')).kimiProvider,
  oar: async () => (await import('huihua/providers/oar')).oarProvider,
  morph: async () => (await import('huihua/providers/morph')).morphProvider,
  copilot: async () => (await import('huihua/providers/copilot')).copilotProvider,
  openclaw: async () => (await import('huihua/providers/openclaw')).openclawProvider,
  qwen: async () => (await import('huihua/providers/qwen')).qwenProvider,
  droid: async () => (await import('huihua/providers/droid')).droidProvider,
  deepseek: async () => (await import('huihua/providers/deepseek')).deepseekProvider,
  cline: async () => (await import('huihua/providers/cline')).clineProvider,
  fx: async () => (await import('huihua/providers/fx')).fxProvider,
  devin: async () => (await import('huihua/providers/devin')).devinProvider,
  hermes: async () => (await import('huihua/providers/hermes')).hermesProvider,
}

function usage(): string {
  return [
    'huihua-usage [--provider ID]... [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--timezone IANA] [--json] [--workers 1|2|4]',
    '',
    'Read local session usage through Huihua discovery and streaming contracts.',
    'Date bounds are inclusive calendar days in the selected timezone (default UTC).',
    'Report daily input/output/cache token totals and model breakdowns, with per-session totals in JSON.',
    'Unavailable counters are null; partial totals and unsupported cumulative scopes have diagnostics.',
    'Workers parse multiple JSONL sessions on separate CPU threads; default 1. More workers use more memory.',
  ].join('\n')
}

/** Private benchmark controls; these are not CLI flags or Huihua public API. */
export interface ExecutionOptions {
  readonly facts?: boolean
  readonly batchDecode?: boolean
  readonly pushdown?: boolean
  readonly concurrency?: number
  readonly maxRecordBytes?: number
  readonly workers?: number
}

export async function usageRegistry(ids: readonly string[]) {
  if (ids.length === 0)
    return (await import('huihua')).sessions
  return createSessionRegistry(await Promise.all(Array.from(new Set(ids), async (id) => {
    if (!Object.hasOwn(providers, id))
      return createSessionRegistry().require(id)
    return providers[id]!()
  })))
}

export async function consumeRef(builder: UsageReportBuilder, ref: SessionRef, open: OpenSession, execution: ExecutionOptions, useCallback = true): Promise<void> {
  const selection: FrameSelection = { events: ['usage'], records: true, metadata: true, metadataKeys: ['parentSessionId'] }
  if (useCallback && execution.facts && open.consumeUsageFacts) {
    await open.consumeUsageFacts(item => builder.addFact(ref, item), execution.pushdown
      ? { acceptTimestamp: timestamp => builder.acceptTimestamp(ref, timestamp) }
      : {})
  }
  else if (useCallback && open.consumeUsage) {
    await open.consumeUsage(frame => builder.add(ref, frame))
  }
  else if (useCallback && open.consume) {
    await open.consume(selection, frame => builder.add(ref, frame))
  }
  else {
    const frames = open.select?.(selection) ?? open.stream()
    for await (const frame of frames) builder.add(ref, frame)
  }
  builder.end(ref)
}

async function workerPartitions(refs: readonly SessionRef[], builder: UsageReportBuilder, execution: ExecutionOptions, options: ConstructorParameters<typeof UsageReportBuilder>[1], count: number, useCallback: boolean): Promise<void> {
  const workers: Worker[] = []
  let firstFailure: Error | undefined
  try {
    const results = await Promise.allSettled(Array.from({ length: Math.min(count, refs.length) }, async (_, index) => {
      const begin = Math.floor(refs.length * index / count)
      const end = Math.floor(refs.length * (index + 1) / count)
      const worker = new Worker(new URL('./worker.js', import.meta.url), {
        workerData: { refs: refs.slice(begin, end), options, execution, useCallback },
        stdout: true,
        stderr: true,
      })
      workers.push(worker)
      // No worker may print a partial report or leak native input through diagnostics.
      worker.stdout.resume()
      worker.stderr.resume()
      return new Promise<UsagePartition>((accept, reject) => {
        let partition: UsagePartition | undefined
        let failure: Error | undefined
        const cancel = (error: Error) => {
          firstFailure ??= error
          failure ??= error
          for (const sibling of workers) sibling.postMessage('abort')
        }
        worker.on('message', (message: UsagePartition | { error: string }) => {
          if ('error' in message)
            cancel(new Error(message.error))
          else partition = message
        })
        worker.on('error', cancel)
        worker.on('exit', (code) => {
          if (failure !== undefined) {
            reject(failure)
          }
          else if (code !== 0 || partition === undefined) {
            const error = new Error(`usage worker exited without a complete partition (${code})`)
            cancel(error)
            reject(error)
          }
          else {
            accept(partition)
          }
        })
      })
    }))
    if (firstFailure !== undefined)
      throw firstFailure
    for (const result of results) {
      if (result.status === 'rejected')
        throw result.reason
    }
    // Results retain original contiguous partition order, regardless of completion order.
    for (const result of results) {
      if (result.status === 'fulfilled')
        builder.importPartition(result.value)
    }
  }
  finally {
    await Promise.allSettled(workers.map(async worker => worker.terminate()))
  }
}

export async function run(argv: readonly string[] = process.argv.slice(2), useCallback = true, execution: ExecutionOptions = {}): Promise<void> {
  const args = parseUsageArgs(argv)
  if (args.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const sessions = await usageRegistry(args.providers)
  const { refs, failures } = await sessions.scan(args.providers.length === 0 ? {} : { providers: args.providers })
  if (failures.length !== 0)
    throw new Error(`Incomplete usage discovery: ${failures.map(failure => `${failure.provider} ${failure.code} ${failure.source?.path ?? failure.scope}: ${failure.message}`).join('; ')}`)
  const options = {
    ...(args.providers.length === 0 ? {} : { providers: args.providers }),
    providerIds: sessions.providers().map(provider => provider.id),
    ...(args.since === undefined ? {} : { since: args.since }),
    ...(args.until === undefined ? {} : { until: args.until }),
    timeZone: args.timeZone,
  }
  const builder = new UsageReportBuilder(refs, options)
  const concurrency = execution.concurrency ?? 1
  if (![1, 2, 4].includes(concurrency))
    throw new TypeError('usage concurrency must be one, two or four')
  const controller = new AbortController()
  // The measured benefit is a narrow date query, not compact envelopes alone.
  const singleDay = args.since !== undefined && args.since === args.until
  execution = { ...execution, facts: execution.facts ?? singleDay, pushdown: execution.pushdown ?? singleDay }
  const workerCount = execution.workers ?? args.workers
  if (![1, 2, 4].includes(workerCount))
    throw new TypeError('usage workers must be one, two or four')
  async function read(ref: SessionRef, open: OpenSession): Promise<void> {
    await consumeRef(builder, ref, open, execution, useCallback)
  }
  const parallel: SessionRef[] = []
  let pending: { ref: SessionRef, open: OpenSession }[] = []
  async function flush(): Promise<void> {
    const batch = pending
    pending = []
    const outcomes = await Promise.allSettled(batch.map(async ({ ref, open }) => {
      try {
        await read(ref, open)
      }
      catch (error) {
        controller.abort(error)
        throw error
      }
    }))
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected')
        throw outcome.reason
    }
  }
  for (const ref of refs) {
    const open = await sessions.open(ref, {
      signal: controller.signal,
      batchDecode: execution.batchDecode === true,
      ...(execution.maxRecordBytes === undefined ? {} : { maxRecordBytes: execution.maxRecordBytes }),
    })
    if (workerCount > 1 && open.readMode === 'incremental' && ['jsonl', 'jsonl_zstd'].includes(ref.source.format)) {
      parallel.push(ref)
    }
    else if (open.readMode === 'buffered') {
      await flush()
      await read(ref, open)
    }
    else {
      pending.push({ ref, open })
      if (pending.length === concurrency)
        await flush()
    }
  }
  await flush()
  if (parallel.length > 1 && new Set(parallel.map(ref => JSON.stringify([ref.provider, ref.source]))).size === parallel.length) {
    await workerPartitions(parallel, builder, execution, options, Math.min(workerCount, parallel.length), useCallback)
  }
  else {
    for (const ref of parallel)
      await read(ref, await sessions.open(ref, { signal: controller.signal, ...(execution.maxRecordBytes === undefined ? {} : { maxRecordBytes: execution.maxRecordBytes }), batchDecode: execution.batchDecode === true }))
  }
  const report = builder.finish()
  process.stdout.write(`${args.json ? JSON.stringify(report, null, 2) : formatUsageReport(report)}\n`)
}

if (isMainThread && process.argv[1] !== undefined && [import.meta.url, new URL('./cli.js', import.meta.url).href].includes(pathToFileURL(resolve(process.argv[1])).href)) {
  run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
