import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

export function required(name: string): string {
  const value = process.env[name]
  assert(value !== undefined && value !== '', `${name} is required`)
  return value
}
export async function json(url: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { 'content-type': 'application/json', 'x-api-key': 'synthetic-test-key', 'anthropic-version': '2023-06-01' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
  assert(response.ok, `${url}: ${response.status} ${await response.clone().text()}`)
  return await response.json() as Record<string, unknown>
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
  for (const [kind, count] of Object.entries(actual.unknown))
    assert(count <= (baseline.unknown[kind] ?? 0), `unknown native record growth: ${kind}=${count}`)
  assert.equal(actual.structured, baseline.structured, 'new structured fallback content')
  if (actual.groupedFieldPaths !== undefined || baseline.groupedFieldPaths !== undefined) {
    assert(actual.groupedFieldPaths, 'missing independent per-record-type native observations')
    assert(baseline.groupedFieldPaths, 'missing reviewed per-record-type native baseline')
    assertNativePaths(actual.groupedFieldPaths, baseline.groupedFieldPaths, baseline.optionalGroupedFieldPaths ?? [], 'native per-record-type field/type drift')
  }
  assertNativePaths(actual.fieldPaths, baseline.fieldPaths, baseline.optionalFieldPaths ?? [], 'native field/type drift; inspect report before updating baseline')
}

export interface NativeStore {
  path: string
  id: string
  rows: { position: number, text: string, native: Record<string, unknown> }[]
}

export function nativeFieldPaths(stores: NativeStore[], grouped = true): string[] {
  const paths = new Set<string>()
  function visit(value: unknown, path: string): void {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    paths.add(`${path}:${type}`)
    if (Array.isArray(value)) {
      for (const item of value) visit(item, `${path}[]`)
    }
    else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`)
    }
  }
  for (const store of stores) {
    for (const row of store.rows) visit(row.native, grouped ? `${JSON.stringify(row.native.type ?? null)}:$` : '$')
  }
  return [...paths].sort()
}

// Shared infrastructure only; provider protocols and reading assertions stay in their scenarios.
export function startSimulator(directory: string, port: number) {
  const server = spawn(process.execPath, ['--import', join(directory, 'node_modules/tsx/dist/loader.mjs'), join(directory, 'run.ts'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
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
