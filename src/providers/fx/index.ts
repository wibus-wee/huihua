import { Buffer } from 'node:buffer'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { SessionError } from '../../contracts/diagnostic.ts'
import type { ReadOptions } from '../../contracts/provider.ts'
import type { SessionFrame, SessionRef } from '../../contracts/session.ts'
import { contentBlocks, Ingestion, openFrom } from '../../shared/ingestion.ts'
import { readJson } from '../../shared/json-file.ts'
import { jsonStoreProvider } from '../../shared/json-store.ts'
import { jsonLines } from '../../shared/jsonl.ts'
import { exists, positiveLimit } from '../../shared/paths.ts'
import { array, object, optional, string, timestamp } from '../../shared/value.ts'

function durable(value: unknown): unknown {
  const v = object(value)
  if (v.encoding === 'base64' && typeof v.data === 'string') {
    const bytes = Buffer.from(v.data, 'base64')
    try {
      return new TextDecoder('utf8', { fatal: true }).decode(bytes)
    }
    catch {
      return value
    }
  }
  return value
}
function call(ingest: Ingestion, native: unknown) {
  const c = object(native)
  if (typeof c.name === 'string')
    ingest.emit('tool_call', { ...optional('callId', string(c.id)), toolName: c.name, arguments: c.arguments_json ?? null })
  else
    ingest.unknown('fx_tool_call', native)
}
const snapshots = jsonStoreProvider({
  id: 'fx',
  format: 'fx_json',
  roots: options => options.roots?.fx ?? [join(options.homeDir ?? homedir(), '.fx/sessions')],
  accepts: path => basename(path) === 'session.json',
  metadataFiles: path => [join(dirname(path), 'display.json')],
  async sources(path) {
    const display = join(dirname(path), 'display.json')
    return [path, join(dirname(path), 'checkpoint.json'), ...await exists(display) ? [display] : []]
  },
  metadata(native) {
    const v = object(native)
    const state = object(v.state ?? native)
    const id = string(v.session_id) ?? string(state.id)
    return { ...optional('id', id), ...optional('title', string(v.title)), ...optional('createdAt', timestamp(state.created_at_ms)), ...optional('updatedAt', timestamp(state.updated_at_ms)), ...optional('workspace', typeof state.workspace_root === 'string' ? { path: state.workspace_root } : undefined), metadata: { ...optional('id_origin', id === undefined ? undefined : 'native'), ...optional('preferences', v.preferences ?? state.preferences) } }
  },
  parse(ingest, native, path) {
    const v = object(native)
    if (basename(path) === 'display.json') {
      ingest.emit('system', { sourceType: 'fx_display', payload: native })
      return
    }
    const checkpoint = 'state' in v
    if (checkpoint ? v.schema_version !== 1 : v.schema_version !== 3 || v.storage_format !== 'event_log_v1')
      throw new SessionError('UnsupportedSchema', 'unsupported fx snapshot schema')
    ingest.emit('system', { sourceType: checkpoint ? 'fx_checkpoint' : 'fx_manifest', payload: native })
    if (!checkpoint)
      return
    const state = object(v.state)
    ingest.diagnostic('PartialParse', 'fx checkpoint snapshot only; events after through_seq are not replayed')
    for (const nativeTurn of array(state.history)) {
      const turn = object(nativeTurn)
      if (!['assistant', 'interrupted', 'background_command', 'compacted_summary'].includes(String(turn.kind))) {
        ingest.unknown('fx_history', nativeTurn)
        continue
      }
      const user = object(turn.user)
      if ('text' in user)
        ingest.emit('user_message', { content: contentBlocks(durable(user.text)) })
      for (const image of array(user.images))
        ingest.emit('user_message', { content: [{ type: 'image', data: { data: image, metadata: object(image) } }] })
      for (const nativeStep of array(object(turn.execution).tool_steps)) {
        const step = object(nativeStep)
        if (step.assistant !== null && step.assistant !== undefined)
          ingest.emit('assistant_message', { content: contentBlocks(durable(step.assistant)) })
        for (const tool of array(step.tool_calls))
          call(ingest, tool)
        for (const nativeResult of array(step.tool_results)) {
          const r = object(nativeResult)
          ingest.emit('tool_result', { ...optional('callId', string(r.tool_call_id)), ...optional('toolName', string(r.tool_name)), result: r, isError: r.status === 'failure' }, { timestamp: r.created_at_ms })
        }
      }
      if (turn.assistant !== null && turn.assistant !== undefined)
        ingest.emit('assistant_message', { content: contentBlocks(durable(turn.assistant)) })
      if (turn.tool_call !== null && turn.tool_call !== undefined)
        call(ingest, turn.tool_call)
      if (turn.kind === 'compacted_summary' || turn.kind === 'interrupted')
        ingest.emit('system', { sourceType: String(turn.kind), payload: nativeTurn })
    }
  },
})

function conversation(ingest: Ingestion, native: unknown) {
  const v = object(native)
  const envelope = { timestamp: v.timestamp_ms }
  const evidence = { ...optional('seq', v.seq) }
  if (typeof v.schema_version !== 'number' || ![1, 2, 3].includes(v.schema_version)) {
    ingest.unknown('fx_conversation', native, 'unsupported fx conversation schema', envelope, evidence)
    ingest.diagnostic('UnsupportedSchema', `unsupported fx conversation schema ${String(v.schema_version)}`)
    return
  }
  const event = object(v.event)
  const keys = Object.keys(event)
  const kind = keys[0]
  const data = object(kind === undefined ? undefined : event[kind])
  if (keys.length !== 1) {
    ingest.unknown('fx_conversation', native, 'invalid fx conversation event', envelope, evidence)
    return
  }
  if ((kind === 'user' || kind === 'assistant' || kind === 'steering') && typeof data.text === 'string') {
    const content = contentBlocks(data.text)
    for (const image of array(data.images))
      content.push({ type: 'image', data: { data: image, metadata: object(image) } })
    ingest.emit(kind === 'assistant' ? 'assistant_message' : 'user_message', { content }, envelope, { ...evidence, kind })
  }
  else if (kind === 'tool_call' && typeof data.tool_name === 'string') {
    ingest.emit('tool_call', { ...optional('callId', string(data.call_id)), toolName: data.tool_name, arguments: data.arguments_json ?? null }, envelope, evidence)
  }
  else if (kind === 'tool_result' && typeof data.tool_name === 'string') {
    ingest.emit('tool_result', { ...optional('callId', string(data.call_id)), toolName: data.tool_name, result: data, isError: data.status === 'failure' }, envelope, evidence)
  }
  else if (kind === 'turn_completed' || kind === 'interrupted' || kind === 'context_checkpoint') {
    if (kind === 'interrupted' && typeof data.partial_text === 'string')
      ingest.emit('assistant_message', { content: contentBlocks(data.partial_text) }, envelope, evidence)
    ingest.emit('system', { sourceType: kind, payload: event[kind] }, envelope, evidence)
  }
  else {
    ingest.unknown(kind ?? 'fx_conversation', native, undefined, envelope, evidence)
  }
}

async function open(ref: SessionRef, options: ReadOptions = {}) {
  if (ref.provider !== 'fx')
    throw new SessionError('ProviderNotFound', `expected fx, got ${ref.provider}`)
  if (ref.source.format !== 'fx_json')
    throw new SessionError('UnsupportedSchema', `unsupported fx source format ${ref.source.format}`)
  async function* stream(): AsyncGenerator<SessionFrame> {
    const header = await readJson(ref.source.path, positiveLimit(options.maxRecordBytes, 16 * 1024 * 1024), false, options.signal)
    const metadata = object(header.native)
    if (metadata.schema_version !== 4 || basename(ref.source.path) !== 'session.json') {
      yield* (await snapshots.open(ref, options)).stream()
      return
    }
    const id = string(metadata.id)
    if (id === undefined)
      throw new SessionError('CorruptedSession', 'fx metadata has no native session identity')
    if (id !== ref.id && !ref.id.startsWith('source:') && ref.metadata.id_origin !== 'caller')
      throw new SessionError('CorruptedSession', 'conflicting fx snapshot identity')
    const ingest = new Ingestion('fx')
    ingest.record(header.native, { path: ref.source.path }, header)
    ingest.patch({
      ...optional('id', ref.metadata.id_origin !== 'caller' ? id : undefined),
      ...optional('title', string(metadata.title)),
      ...optional('createdAt', timestamp(metadata.created_at_ms)),
      ...optional('updatedAt', timestamp(metadata.updated_at_ms)),
      ...optional('workspace', typeof metadata.workspace_root === 'string' ? { path: metadata.workspace_root } : undefined),
      metadata: { id_origin: ref.metadata.id_origin === 'caller' ? 'caller' : 'native' },
    })
    ingest.emit('system', { sourceType: 'fx_metadata', payload: header.native })
    yield* ingest.drain()
    const path = join(dirname(ref.source.path), 'events.jsonl')
    for await (const line of jsonLines(path, false, options)) {
      ingest.record(line.native, { path, position: line.position }, line)
      if (line.malformed)
        ingest.unknown('malformed_jsonl', line.native)
      else
        conversation(ingest, line.native)
      yield* ingest.drain()
    }
    const display = join(dirname(ref.source.path), 'display.json')
    if (await exists(display)) {
      const record = await readJson(display, positiveLimit(options.maxRecordBytes, 16 * 1024 * 1024), false, options.signal)
      ingest.record(record.native, { path: display }, record)
      if (record.malformed) {
        ingest.unknown('malformed_json', record.native)
      }
      else {
        ingest.patch({ ...optional('title', string(object(record.native).title)) })
        ingest.emit('system', { sourceType: 'fx_display', payload: record.native })
      }
      yield* ingest.drain()
    }
    yield* ingest.finish()
  }
  // The legacy route still reads a complete bounded checkpoint before yielding it.
  return openFrom(ref, stream, 'buffered')
}

export const fxProvider = {
  ...snapshots,
  open,
  async read(ref: SessionRef, options?: ReadOptions) {
    return (await open(ref, options)).snapshot()
  },
}
