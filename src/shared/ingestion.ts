import { Buffer } from 'node:buffer'

import type { Diagnostic, ErrorCode } from '../contracts/diagnostic.ts'
import { SessionError } from '../contracts/diagnostic.ts'
import type {
  ContentBlock,
  EventBody,
  EventDataMap,
  EventType,
  SessionEvent,
} from '../contracts/event.ts'
import type {
  JsonlInput,
  ReadOptions,
  ScanOptions,
  SessionProvider,
} from '../contracts/provider.ts'
import type {
  OpenSession,
  Session,
  SessionFrame,
  SessionRef,
} from '../contracts/session.ts'
import { SESSION_SCHEMA } from '../contracts/session.ts'
import type { RawRecord } from '../contracts/source.ts'
import type { NativeLine } from './jsonl.ts'
import { header, jsonLines, jsonLinesFrom } from './jsonl.ts'
import { exists, files } from './paths.ts'
import { array, object, optional, string, timestamp } from './value.ts'

export class Ingestion {
  #record = 0
  #event = 0
  #current: RawRecord | undefined
  #frames: SessionFrame[] = []
  readonly #pending = new Set<string>()
  readonly #provider: string
  constructor(provider: string) {
    this.#provider = provider
  }

  record(
    native: unknown,
    source: RawRecord['source'],
    evidence: { text?: string, bytes?: readonly number[] } = {},
  ): void {
    const raw = object(native)
    this.#current = {
      sequence: this.#record++,
      provider: this.#provider,
      ...optional('type', string(raw.type)),
      native,
      source,
      ...optional('text', evidence.text),
      ...optional('bytes', evidence.bytes),
    }
    this.#frames.push({ type: 'record', record: this.#current })
  }

  emit<K extends EventType>(
    type: K,
    data: EventDataMap[K],
    envelope: unknown = this.#current?.native,
  ): void {
    const raw = object(envelope)
    const record = this.#current
    if (!record)
      throw new Error('event without native record')
    const metadata: Record<string, unknown> = {}
    for (const key of [
      'type',
      'parentId',
      'parentUuid',
      'sessionId',
      'ordinal',
      'isSidechain',
      'agentId',
    ]) {
      if (key in raw)
        metadata[key] = raw[key]
    }
    if (record.source.position !== undefined)
      metadata.native_position = record.source.position
    const event = {
      sequence: this.#event++,
      record: record.sequence,
      ...optional('id', string(raw.id) ?? string(raw.uuid)),
      ...optional('timestamp', timestamp(raw.timestamp)),
      providerMetadata: metadata,
      type,
      data,
    } as SessionEvent
    this.#frames.push({ type: 'event', event })
    if (event.type === 'tool_call' && event.data.callId !== undefined)
      this.#pending.add(event.data.callId)
    if (event.type === 'tool_result' && event.data.callId !== undefined)
      this.#pending.delete(event.data.callId)
  }

  body(body: EventBody, envelope?: unknown): void {
    this.emit(body.type, body.data, envelope)
  }

  unknown(
    type: string,
    payload: unknown,
    message = `unrecognized native record ${type}`,
  ): void {
    this.emit('unknown', { sourceType: type, payload })
    this.diagnostic('PartialParse', message, this.#current?.source.position)
  }

  diagnostic(code: ErrorCode, message: string, position?: number): void {
    this.#frames.push({
      type: 'diagnostic',
      diagnostic: { code, message, ...optional('position', position) },
    })
  }

  patch(patch: Extract<SessionFrame, { type: 'metadata' }>['patch']): void {
    this.#frames.push({ type: 'metadata', patch })
  }

  drain(): SessionFrame[] {
    const frames = this.#frames
    this.#frames = []
    return frames
  }

  eventCount(): number {
    return this.#event
  }

  finish(): SessionFrame[] {
    for (const call of [...this.#pending].sort()) {
      this.diagnostic(
        'PartialParse',
        `tool call ${call} has no recorded result`,
      )
    }
    return this.drain()
  }
}
export function contentBlocks(value: unknown): ContentBlock[] {
  if (typeof value === 'string')
    return [{ type: 'text', data: value }]
  if (Array.isArray(value))
    return value.flatMap(contentBlocks)
  const v = object(value)
  const type = string(v.type)
  if (
    ['text', 'input_text', 'output_text'].includes(type ?? '')
    && typeof v.text === 'string'
  ) {
    return [{ type: 'text', data: v.text }]
  }
  if (['image', 'input_image', 'file'].includes(type ?? '')) {
    const source = object(v.source)
    const uri
      = string(v.image_url)
        ?? string(object(v.image_url).url)
        ?? string(v.url)
        ?? string(v.path)
    return [
      {
        type: type === 'file' ? 'file' : 'image',
        data: {
          ...optional('uri', uri),
          ...optional(
            'mimeType',
            string(v.mimeType)
            ?? string(v.mime_type)
            ?? string(source.media_type),
          ),
          ...optional('data', v.data ?? source.data),
          metadata: v,
        },
      },
    ]
  }
  return [{ type: 'structured', data: value }]
}
export function messageEvents(
  ingest: Ingestion,
  role: string,
  content: unknown,
  model?: string,
): void {
  const values: unknown[] = Array.isArray(content) ? content : [content]
  for (const item of values) {
    const v = object(item)
    const type = string(v.type)
    if (
      type === 'thinking'
      || type === 'reasoning'
      || type === 'redacted_thinking'
    ) {
      ingest.emit('reasoning', {
        ...optional('text', string(v.thinking) ?? string(v.text)),
        ...optional('summary', string(v.summary)),
        ...optional(
          'encrypted',
          type === 'redacted_thinking' ? v.data : v.encrypted,
        ),
      })
    }
    else if (
      (type === 'tool_use' || type === 'toolCall')
      && typeof v.name === 'string'
    ) {
      ingest.emit('tool_call', {
        ...optional('callId', string(v.id)),
        toolName: v.name,
        arguments: v.input ?? v.arguments ?? null,
      })
    }
    else if (type === 'tool_result') {
      ingest.emit('tool_result', {
        ...optional('callId', string(v.tool_use_id)),
        ...optional('toolName', string(v.name)),
        result: v.content ?? null,
        isError: v.is_error === true,
      })
    }
    else if (role === 'user') {
      ingest.emit('user_message', { content: contentBlocks(item) })
    }
    else if (role === 'assistant') {
      ingest.emit('assistant_message', {
        content: contentBlocks(item),
        ...optional('model', model),
      })
    }
    else {
      ingest.unknown('message', { role, content: item })
    }
  }
}
export function openFrom(
  ref: SessionRef,
  stream: () => AsyncIterable<SessionFrame>,
  readMode: OpenSession['readMode'],
): OpenSession {
  return {
    ref,
    readMode,
    stream,
    async* events() {
      for await (const frame of stream()) {
        if (frame.type === 'event')
          yield frame.event
      }
    },
    async* records() {
      for await (const frame of stream()) {
        if (frame.type === 'record')
          yield frame.record
      }
    },
    async snapshot() {
      let metadata = { ...ref.metadata }
      let facts: Partial<Session> = {}
      const records: RawRecord[] = []
      const events: SessionEvent[] = []
      const diagnostics: Diagnostic[] = []
      for await (const frame of stream()) {
        switch (frame.type) {
          case 'record':
            records.push(frame.record)
            break
          case 'event':
            events.push(frame.event)
            break
          case 'diagnostic':
            diagnostics.push(frame.diagnostic)
            break
          case 'metadata':
            facts = { ...facts, ...frame.patch }
            if (frame.patch.metadata)
              metadata = { ...metadata, ...frame.patch.metadata }
            break
        }
      }
      return {
        ...ref,
        ...facts,
        schema: SESSION_SCHEMA,
        metadata,
        records,
        events,
        diagnostics,
      }
    },
  }
}
export interface JsonlAdapter {
  id: string
  roots: (options: ScanOptions) => readonly string[]
  metadata: (records: readonly unknown[], path: string) => Partial<Session>
  parse: (ingest: Ingestion, native: unknown) => void
  accepts?: (path: string) => boolean
}
export function jsonlProvider(adapter: JsonlAdapter): SessionProvider & {
  open: (ref: SessionRef, options?: ReadOptions) => Promise<OpenSession>
  parse: (input: JsonlInput, options?: ReadOptions) => Promise<Session>
} {
  const open = async (
    ref: SessionRef,
    options: ReadOptions = {},
  ): Promise<OpenSession> => {
    if (ref.provider !== adapter.id) {
      throw new SessionError(
        'ProviderNotFound',
        `expected ${adapter.id}, got ${ref.provider}`,
      )
    }
    if (!['jsonl', 'jsonl_zstd'].includes(ref.source.format)) {
      throw new SessionError(
        'UnsupportedSchema',
        `unsupported ${adapter.id} source format ${ref.source.format}`,
      )
    }
    return openFrom(ref, () => ingestLines(ref, jsonLines(
      ref.source.path,
      ref.source.format === 'jsonl_zstd',
      options,
    )), 'incremental')
  }
  async function* ingestLines(ref: SessionRef, lines: AsyncIterable<NativeLine>): AsyncGenerator<SessionFrame> {
    const ingest = new Ingestion(adapter.id)
    let selectedId = ref.id.startsWith('source:') && ref.metadata.id_origin !== 'caller' && ref.metadata.id_origin !== 'native'
      ? undefined
      : ref.id
    let createdKnown = ref.createdAt !== undefined
    let workspace = ref.workspace
    for await (const line of lines) {
      ingest.record(
        line.native,
        { path: ref.source.path, position: line.position },
        { ...optional('text', line.text), ...optional('bytes', line.bytes) },
      )
      if (line.malformed) {
        ingest.unknown(
          'malformed_jsonl',
          line.native,
          'corrupted JSONL record',
        )
      }
      else {
        let facts = adapter.metadata([line.native], ref.source.path)
        if (
          facts.id !== undefined
          && selectedId !== undefined
          && facts.id !== selectedId
        ) {
          ingest.diagnostic(
            'PartialParse',
            ref.id.startsWith('source:') || ref.metadata.id_origin === 'caller'
              ? 'conflicting native session header retained; selected identity is authoritative'
              : 'conflicting native session header retained; scan-selected identity is authoritative',
            line.position,
          )
          facts = {}
        }
        selectedId ??= facts.id
        const { createdAt, ...rest } = facts
        if (facts.workspace)
          workspace = { ...workspace, ...facts.workspace }
        ingest.patch({
          ...rest,
          ...optional('workspace', workspace),
          ...optional('createdAt', createdKnown ? undefined : createdAt),
        })
        if (createdAt)
          createdKnown = true
        const before = ingest.eventCount()
        adapter.parse(ingest, line.native)
        if (ingest.eventCount() === before) {
          ingest.unknown(
            string(object(line.native).type) ?? 'unknown',
            line.native,
          )
        }
        const time = timestamp(object(line.native).timestamp)
        if (time) {
          ingest.patch({
            updatedAt: time,
            metadata: { updated_at_origin: 'last_recorded_event' },
          })
        }
      }
      yield* ingest.drain()
    }
    yield* ingest.finish()
  }
  return {
    id: adapter.id,
    async detect(options = {}) {
      const roots: string[] = []
      for (const path of adapter.roots(options)) {
        if (await exists(path))
          roots.push(path)
      }
      return { provider: adapter.id, roots, available: roots.length > 0 }
    },
    async scan(options = {}) {
      const refs: SessionRef[] = []
      for await (const path of files(
        adapter.roots(options),
        adapter.accepts ?? (p => p.endsWith('.jsonl')),
        options.signal,
      )) {
        const compressed = path.endsWith('.jsonl.zst')
        const facts = adapter.metadata(
          await header(path, compressed, options.headerBytes, options.signal),
          path,
        )
        refs.push({
          id: `source:${path}`,
          provider: adapter.id,
          metadata: { id_origin: 'source_locator' },
          ...facts,
          source: { path, format: compressed ? 'jsonl_zstd' : 'jsonl' },
        })
      }
      return refs
    },
    open,
    async parse(input: JsonlInput, options: ReadOptions = {}) {
      const path = input.source ?? 'memory:jsonl'
      const ref: SessionRef = {
        id: input.id ?? `source:${path}`,
        provider: adapter.id,
        source: { path, format: 'jsonl' },
        metadata: { id_origin: input.id === undefined ? 'source_locator' : 'caller' },
      }
      async function* bytes(): AsyncGenerator<Uint8Array> {
        if (typeof input.jsonl === 'string') {
          // Bound UTF-8 encoding allocations; do not split a surrogate pair between chunks.
          for (let start = 0; start < input.jsonl.length;) {
            options.signal?.throwIfAborted()
            let end = Math.min(start + 16384, input.jsonl.length)
            const last = input.jsonl.charCodeAt(end - 1)
            if (end < input.jsonl.length && last >= 0xD800 && last <= 0xDBFF)
              end--
            const text = input.jsonl.slice(start, end)
            const encoded = Buffer.from(text)
            if (encoded.toString() !== text) {
              throw new SessionError('CorruptedSession', 'JSONL text contains unpaired UTF-16 surrogates; provide original bytes to preserve evidence')
            }
            yield encoded
            start = end
          }
        }
        else if (input.jsonl instanceof Uint8Array) {
          yield input.jsonl
        }
        else {
          yield* input.jsonl
        }
      }
      return openFrom(ref, () => ingestLines(ref, jsonLinesFrom(bytes(), options)), 'incremental').snapshot()
    },
    async read(ref, options) {
      return (await open(ref, options)).snapshot()
    },
  }
}
export function joinedText(value: unknown): string | undefined {
  const parts = array(value).flatMap((item) => {
    const text = string(item) ?? string(object(item).text)
    return text === undefined ? [] : [text]
  })
  return parts.length ? parts.join('\n') : undefined
}
