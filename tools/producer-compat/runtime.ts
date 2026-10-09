import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import type { Session } from '../../src/index.ts'
import type { CompatibilityProgress } from './report.ts'

export function required(name: string): string {
  const value = process.env[name]
  assert(value !== undefined && value !== '', `${name} is required`)
  return value
}
export async function json(url: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { 'content-type': 'application/json', 'authorization': 'Bearer synthetic-test-key', 'x-api-key': 'synthetic-test-key', 'anthropic-version': '2023-06-01' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
  assert(response.ok, `${url}: ${response.status} ${await response.clone().text()}`)
  return await response.json() as Record<string, unknown>
}

export function assertSimulatorRequests(ledger: Record<string, unknown>, expected: { path: string, marker: string, stream?: boolean, bodyIncludes?: string }[]): void {
  assert(Array.isArray(ledger.requests), 'missing simulator request ledger')
  const requests = ledger.requests as { method: string, path: string, body?: Record<string, unknown> }[]
  const modelPaths = ['/v1/messages', '/v1/responses', '/v1/chat/completions']
  const model = requests.filter(request => modelPaths.includes(request.path))
  assert.equal(model.length, expected.length, 'unexpected/missing model requests')
  for (const [index, plan] of expected.entries()) {
    const actual = model[index]!
    assert.equal(actual.method, 'POST', `model request ${index}: method`)
    assert.equal(actual.path, plan.path, `model request ${index}: protocol`)
    assert.equal(actual.body?.stream ?? false, plan.stream ?? true, `model request ${index}: streaming`)
    assert(JSON.stringify(actual.body).includes(plan.marker), `model request ${index}: missing scenario marker ${plan.marker}`)
    if (plan.bodyIncludes !== undefined)
      assert(JSON.stringify(actual.body).includes(plan.bodyIncludes), `model request ${index}: missing purpose ${plan.bodyIncludes}`)
  }
  for (const request of requests.filter(request => !modelPaths.includes(request.path)))
    assert((request.method === 'GET' && /^\/v1\/models(?:\/[^/]+)?$/.test(request.path)) || (request.method === 'POST' && ['/v1/messages/count_tokens', '/v1/responses/input_tokens'].includes(request.path)), `unexpected auxiliary request: ${request.method} ${request.path}`)
}
export function exchange(label: string, marker: string, block: Record<string, unknown>, stop: string, template: Record<string, unknown>) {
  const delta = block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text }
  return { label, request: { method: 'POST', path: '/v1/messages', bodyTextIncludes: [marker] }, response: { kind: 'stream', steps: [
    { kind: 'event', event: { type: 'message_start', message: { ...template, id: `msg_${label.replaceAll(' ', '_')}`, content: [], stop_reason: null } } },
    { kind: 'event', event: { type: 'content_block_start', index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' } } },
    { kind: 'event', event: { type: 'content_block_delta', index: 0, delta } },
    { kind: 'event', event: { type: 'content_block_stop', index: 0 } },
    { kind: 'event', event: { type: 'message_delta', context_management: null, delta: { stop_reason: stop, stop_sequence: null, stop_details: null, container: null }, usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, fallback_credit: null, input_tokens: 1, iterations: null, output_tokens: 12, output_tokens_details: null, server_tool_use: null } } },
    { kind: 'event', event: { type: 'message_stop' } },
    { kind: 'close' },
  ] } }
}

export interface DriftSummary {
  unknown: Record<string, number>
  structured: number
  fieldPaths: string[]
  optionalFieldPaths?: string[]
  groupedFieldPaths?: string[]
  optionalGroupedFieldPaths?: string[]
}

export interface NativeDrift {
  added: string[]
  removed: string[]
}

export class NativeDriftError extends Error {
  readonly drift: NativeDrift

  constructor(message: string, drift: NativeDrift) {
    super(message)
    this.drift = drift
    this.name = 'NativeDriftError'
  }
}

function assertNativePaths(actual: string[], baseline: string[], optional: string[], label: string): void {
  const ignored = new Set(optional)
  const observed = new Set(actual.filter(path => !ignored.has(path)))
  const expected = new Set(baseline.filter(path => !ignored.has(path)))
  const drift = {
    added: [...observed].filter(path => !expected.has(path)).sort(),
    removed: [...expected].filter(path => !observed.has(path)).sort(),
  }
  if (drift.added.length || drift.removed.length)
    throw new NativeDriftError(label, drift)
}

export function assertNoProducerDrift(actual: DriftSummary, baseline: DriftSummary): void {
  if (actual.groupedFieldPaths !== undefined || baseline.groupedFieldPaths !== undefined) {
    assert(actual.groupedFieldPaths, 'missing independent per-record-type native observations')
    assert(baseline.groupedFieldPaths, 'missing reviewed per-record-type native baseline')
    assertNativePaths(actual.groupedFieldPaths, baseline.groupedFieldPaths, baseline.optionalGroupedFieldPaths ?? [], 'native per-record-type field/type drift')
  }
  assertNativePaths(actual.fieldPaths, baseline.fieldPaths, baseline.optionalFieldPaths ?? [], 'native field/type drift; inspect report before updating baseline')
  for (const [kind, count] of Object.entries(actual.unknown))
    assert(count <= (baseline.unknown[kind] ?? 0), `unknown native record growth: ${kind}=${count}`)
  assert.equal(actual.structured, baseline.structured, 'new structured fallback content')
}

export interface NativeStore {
  path: string
  id: string
  rows: { position: number, text: string, native: Record<string, unknown> }[]
}

export function nativeFieldPaths(stores: NativeStore[], grouped = true, recordType = (native: Record<string, unknown>) => JSON.stringify(native.type ?? null)): string[] {
  const paths = new Set<string>()
  function visit(value: unknown, path: string): void {
    const type = value instanceof Uint8Array ? 'bytes' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    paths.add(`${path}:${type}`)
    if (value instanceof Uint8Array) {
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, `${path}[]`)
    }
    else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`)
    }
  }
  for (const store of stores) {
    for (const row of store.rows) visit(row.native, grouped ? `${recordType(row.native)}:$` : '$')
  }
  return [...paths].sort()
}

export function nativeReadSummary(stores: NativeStore[], session: Session, recordType?: (native: Record<string, unknown>) => string): DriftSummary & { diagnosticCodes: string[] } {
  const unknown: Record<string, number> = {}
  for (const event of session.events) {
    if (event.type === 'unknown')
      unknown[event.data.sourceType] = (unknown[event.data.sourceType] ?? 0) + 1
  }
  return {
    unknown,
    structured: session.events.flatMap(event => event.type === 'user_message' || event.type === 'assistant_message' ? event.data.content : []).filter(block => block.type === 'structured').length,
    fieldPaths: nativeFieldPaths(stores, false),
    groupedFieldPaths: nativeFieldPaths(stores, true, recordType),
    diagnosticCodes: session.diagnostics.map(diagnostic => diagnostic.code).sort(),
  }
}

export async function assertNativeBaseline(provider: string, summary: ReturnType<typeof nativeReadSummary>, root: string, progress: CompatibilityProgress): Promise<void> {
  progress.stage = 'baseline'
  await writeFile(join(root, 'drift-report.json'), JSON.stringify(summary, null, 2))
  const baseline = JSON.parse(await readFile(new URL(`./baselines/${provider}.json`, import.meta.url), 'utf8')) as ReturnType<typeof nativeReadSummary>
  assertNoProducerDrift(summary, baseline)
  assert.deepEqual(summary.diagnosticCodes, baseline.diagnosticCodes, 'native diagnostic drift; inspect report before updating baseline')
  progress.completed.push('baseline')
}

// Shared infrastructure only; provider protocols and reading assertions stay in their scenarios.
export function startSimulator(directory: string, port: number) {
  const server = spawn(process.execPath, ['--import', join(directory, 'node_modules/tsx/dist/loader.mjs'), import.meta.filename, directory, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  let spawnError: Error | undefined
  server.on('error', (error) => {
    spawnError = error
  })
  server.stdout.on('data', (chunk) => {
    log += String(chunk)
  })
  server.stderr.on('data', (chunk) => {
    log += String(chunk)
  })
  const closed = new Promise<void>(resolve => server.once('close', () => resolve()))
  return {
    async template(protocol = 'anthropic'): Promise<Record<string, unknown>> {
      return json(`http://127.0.0.1:${port + 1}/_simulator/template`, { protocol })
    },
    async assertExhausted(): Promise<void> {
      await json(`http://127.0.0.1:${port + 1}/_simulator/assert-exhausted`, {})
    },
    async ready(): Promise<void> {
      for (let attempt = 0; ; attempt++) {
        if (spawnError)
          throw spawnError
        try {
          await json(`http://127.0.0.1:${port + 1}/_simulator/requests`)
          return
        }
        catch (error) {
          if (attempt >= 40 || server.exitCode !== null || server.signalCode !== null)
            throw error
          await delay(100)
        }
      }
    },
    async stop(logPath: string): Promise<void> {
      try {
        await writeFile(join(logPath, '..', 'ledger.json'), JSON.stringify(await json(`http://127.0.0.1:${port + 1}/_simulator/requests`), null, 2))
      }
      catch (error) {
        log += `\nCould not preserve request ledger: ${String(error)}\n`
      }
      server.kill('SIGINT')
      await Promise.race([closed, delay(1000)])
      if (server.exitCode === null && server.signalCode === null) {
        server.kill('SIGKILL')
        await closed
      }
      await writeFile(logPath, log)
    },
  }
}

// Launch the pinned simulator's public API with automatic model replies disabled.
// Template synthesis uses a separate setup-only listener, never the producer endpoint.
async function runSimulator(directory: string, port: number): Promise<void> {
  interface Simulator {
    anthropicBaseUrl: string
    openaiBaseUrl: string
    controller: { enqueue: (scenario: unknown) => void, reset: () => void, requests: () => unknown, assertExhausted: () => void }
    close: () => Promise<void>
  }
  const api = await import(pathToFileURL(join(directory, 'src/index.ts')).href) as { startModelApiSimulator: (options: { port?: number, autoRespond: boolean }) => Promise<Simulator> }
  const simulator = await api.startModelApiSimulator({ port, autoRespond: false })
  const control = createServer((request, response) => {
    void (async () => {
      const chunks = []
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk as Uint8Array))
      const body = Buffer.concat(chunks).toString('utf8')
      const input = body ? JSON.parse(body) as Record<string, unknown> : {}
      let output: unknown = { ok: true }
      switch (`${request.method} ${request.url}`) {
        case 'GET /_simulator/requests':
          output = { requests: simulator.controller.requests() }
          break
        case 'POST /_simulator/enqueue':
          simulator.controller.enqueue(input)
          break
        case 'POST /_simulator/reset':
          simulator.controller.reset()
          break
        case 'POST /_simulator/assert-exhausted':
          simulator.controller.assertExhausted()
          break
        case 'POST /_simulator/template': {
          assert(['anthropic', 'openai'].includes(String(input.protocol)))
          const bootstrap = await api.startModelApiSimulator({ autoRespond: true })
          try {
            output = input.protocol === 'anthropic'
              ? await json(`${bootstrap.anthropicBaseUrl}/v1/messages`, { model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'synthetic template' }] })
              : await json(`${bootstrap.openaiBaseUrl}/responses`, { model: 'gpt-5.4', input: 'synthetic template' })
          }
          finally { await bootstrap.close() }
          break
        }
        default: throw new Error(`Unexpected control request: ${request.method} ${request.url}`)
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(output))
    })().catch((error: unknown) => {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: String(error) }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject)
    control.listen(port + 1, '127.0.0.1', resolve)
  })
  process.once('SIGINT', () => {
    void simulator.close().finally(() => control.close())
  })
}

if (import.meta.main)
  await runSimulator(requiredArg(2), Number(requiredArg(3)))

function requiredArg(index: number): string {
  const value = process.argv[index]
  assert(value !== undefined && value !== '', `missing simulator argument ${index}`)
  return value
}

export function chatExchange(label: string, marker: string, reply: string) {
  const base = { id: `chatcmpl_${label}`, object: 'chat.completion.chunk', created: 1, model: 'gpt-test' }
  return { label, request: { method: 'POST', path: '/v1/chat/completions', bodyTextIncludes: [marker] }, response: { kind: 'stream', steps: [
    { kind: 'event', event: { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] } },
    { kind: 'event', event: { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
    { kind: 'event', event: { ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } } },
    { kind: 'event', event: '[DONE]' },
    { kind: 'close' },
  ] } }
}
