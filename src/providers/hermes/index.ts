import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'

import type { ScanEvent, ScanOptions } from '../../contracts/provider.ts'
import type { Session } from '../../contracts/session.ts'
import type { Ingestion } from '../../shared/ingestion.ts'
import { chatMessageEvents, jsonlProvider } from '../../shared/ingestion.ts'
import { jsonStoreProvider } from '../../shared/json-store.ts'
import { binarySafe } from '../../shared/sqlite.ts'
import { sqliteStoreProvider } from '../../shared/sqlite-store.ts'
import { array, object, optional, parseNative, string, timestamp } from '../../shared/value.ts'

function roots(options: ScanOptions): readonly string[] {
  const home = options.homeDir === undefined ? process.env.HERMES_HOME : undefined
  const root = home ?? join(options.homeDir ?? homedir(), '.hermes')
  return options.roots?.hermes ?? [join(root, 'state.db'), join(root, 'sessions')]
}
const seconds = (value: unknown) => typeof value === 'number' ? timestamp(Math.round(value * 1000)) : timestamp(value)
function metadata(native: unknown): Partial<Session> {
  const v = object(native)
  const config = object(v.model_config)
  const id = string(v.session_id) ?? (Array.isArray(v.messages) || 'started_at' in v ? string(v.id) : undefined)
  return { ...optional('id', id), ...optional('title', string(v.title)), ...optional('createdAt', seconds(v.started_at ?? v.session_start)), ...optional('updatedAt', seconds(v.last_activity_at ?? v.ended_at ?? v.last_updated)), ...optional('workspace', typeof (v.cwd ?? config.cwd) === 'string' ? { path: String(v.cwd ?? config.cwd) } : undefined), ...optional('parentSessionId', string(v.parent_session_id)), metadata: { ...optional('id_origin', id === undefined ? undefined : 'native') } }
}
function snapshot(ingest: Ingestion, native: unknown) {
  const v = object(native)
  if (Array.isArray(v.messages)) {
    ingest.emit('system', { sourceType: 'hermes_snapshot', payload: native })
    for (const message of v.messages)
      chatMessageEvents(ingest, message)
  }
  else if (v.role !== undefined) {
    chatMessageEvents(ingest, native)
  }
  else {
    ingest.unknown('hermes_record', native)
  }
}
const json = jsonStoreProvider({ id: 'hermes', format: 'hermes_json', roots, accepts: path => path.endsWith('.json') && !['sessions.json', 'index.json'].includes(basename(path)), metadata, parse: snapshot })
const jsonl = jsonlProvider({ id: 'hermes', roots, metadata: records => records.reduce<Partial<Session>>((facts, record) => ({ ...facts, ...metadata(record) }), {}), parse: snapshot })
const sqlite = sqliteStoreProvider({
  id: 'hermes',
  format: 'hermes_sqlite',
  roots,
  accepts: path => path.endsWith('.db'),
  table: 'messages',
  columns: ['id', 'session_id', 'role', 'content'],
  metadata,
  normalize(ingest, rows, _session, ref, options) {
    rows.sort((a, b) => {
      const left = a.id
      const right = b.id
      return (typeof left === 'number' || typeof left === 'bigint') && (typeof right === 'number' || typeof right === 'bigint') ? left < right ? -1 : left > right ? 1 : 0 : 0
    })
    for (const row of rows) {
      options.signal?.throwIfAborted()
      ingest.record(binarySafe(row), { path: ref.source.path, table: 'messages', key: String(row.id) })
      let tools: unknown = row.tool_calls
      let content: unknown = row.content
      try {
        if (typeof tools === 'string')
          tools = parseNative(tools)
        // Hermes encodes structured content as JSON, while ordinary strings remain plain text.
        if (typeof content === 'string' && content.startsWith('\0json:'))
          content = parseNative(content.slice(6))
      }
      catch {
        ingest.unknown('hermes_message', binarySafe(row), 'invalid Hermes structured message JSON')
        continue
      }
      chatMessageEvents(ingest, { ...row, content, tool_calls: array(tools) }, { ...row, id: String(row.id), timestamp: seconds(row.timestamp)?.value }, { ...optional('active', row.active), ...optional('compacted', row.compacted) })
    }
  },
})
export const hermesProvider = {
  id: 'hermes',
  detect: async (options?: ScanOptions) => sqlite.detect(options),
  async* scan(options: ScanOptions = {}): AsyncGenerator<ScanEvent> {
    yield* sqlite.scan(options)
    yield* json.scan(options)
    yield* jsonl.scan(options)
  },
  async open(ref: Parameters<typeof sqlite.open>[0], options?: Parameters<typeof sqlite.open>[1]) {
    return ref.source.format === 'hermes_sqlite' ? sqlite.open(ref, options) : ref.source.format === 'hermes_json' ? json.open(ref, options) : jsonl.open(ref, options)
  },
  async read(ref: Parameters<typeof sqlite.read>[0], options?: Parameters<typeof sqlite.read>[1]) {
    return (await hermesProvider.open(ref, options)).snapshot()
  },
  parse: jsonl.parse,
  stream: jsonl.stream,
}
