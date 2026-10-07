import { Buffer } from 'node:buffer'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'

import { SessionError } from '../../contracts/diagnostic.ts'
import type { ScanEvent, ScanOptions } from '../../contracts/provider.ts'
import { zstdChunks } from '../../shared/binary.ts'
import type { Ingestion } from '../../shared/ingestion.ts'
import { chatMessageEvents, jsonlProvider } from '../../shared/ingestion.ts'
import { positiveLimit } from '../../shared/paths.ts'
import { binarySafe } from '../../shared/sqlite.ts'
import { sqliteStoreProvider } from '../../shared/sqlite-store.ts'
import { object, optional, parseNative, string, timestamp } from '../../shared/value.ts'

function roots(options: ScanOptions): readonly string[] {
  const root = options.homeDir === undefined ? process.env.OPENCLAW_STATE_DIR : undefined
  return options.roots?.openclaw ?? (root !== undefined && root !== '' ? [join(root, 'agents')] : [join(options.homeDir ?? homedir(), '.openclaw/agents'), join(options.homeDir ?? homedir(), '.clawdbot/agents')])
}
function metadata(records: readonly unknown[]) {
  const v = object(records.find(r => object(r).type === 'session'))
  return { ...optional('id', string(v.id)), ...optional('createdAt', timestamp(v.timestamp)), ...optional('workspace', typeof v.cwd === 'string' ? { path: v.cwd } : undefined), metadata: { ...optional('version', v.version), ...optional('id_origin', typeof v.id === 'string' ? 'native' : undefined) } }
}
function normalize(ingest: Ingestion, native: unknown) {
  const v = object(native)
  const type = string(v.type) ?? 'openclaw_record'
  if (type === 'message')
    chatMessageEvents(ingest, v.message, { ...v, timestamp: v.timestamp ?? object(v.message).timestamp })
  else if (['session', 'model_change', 'thinking_level_change', 'compaction', 'branch_summary', 'custom', 'custom_message', 'session_info', 'reset'].includes(type))
    ingest.emit('system', { sourceType: type, payload: native })
  else
    ingest.unknown(type, native)
}
const jsonl = jsonlProvider({ id: 'openclaw', roots, accepts: path => /\.jsonl(?:\.deleted\.[^/\\]+)?$/.test(path) && !/\.trajectory\.jsonl(?:\.deleted\.|$)/.test(path), metadata, parse: normalize })
const sqlite = sqliteStoreProvider({
  id: 'openclaw',
  format: 'openclaw_sqlite',
  roots,
  accepts: path => basename(path) === 'openclaw-agent.sqlite',
  sessionTable: 'session_windows',
  sessionKey: 'session_id',
  table: 'transcript_events',
  columns: ['session_id', 'seq', 'event_json'],
  metadata: row => ({ ...optional('id', string(row.session_id)), ...optional('createdAt', timestamp(row.created_at)), ...optional('updatedAt', timestamp(row.updated_at)), metadata: { id_origin: 'native', session_key: row.session_key } }),
  async normalize(ingest, rows, session, ref, options) {
    rows.sort((a, b) => {
      const left = a.seq
      const right = b.seq
      return (typeof left === 'number' || typeof left === 'bigint') && (typeof right === 'number' || typeof right === 'bigint') ? left < right ? -1 : left > right ? 1 : 0 : 0
    })
    for (const row of rows) {
      options.signal?.throwIfAborted()
      let text = string(row.event_json)
      const compressed = row.event_zstd
      if (text === undefined && Buffer.isBuffer(compressed)) {
        const chunks: Buffer[] = []
        let size = 0
        const encoded: Buffer = compressed
        async function* bytes() {
          yield encoded
        }
        for await (const chunk of zstdChunks(bytes())) {
          options.signal?.throwIfAborted()
          size += chunk.length
          if (size > positiveLimit(options.maxRecordBytes, 16 * 1024 * 1024))
            throw new SessionError('CorruptedSession', 'OpenClaw decompressed event exceeds record limit')
          chunks.push(chunk)
        }
        if (typeof row.event_utf8_bytes !== 'number' || size !== row.event_utf8_bytes)
          throw new SessionError('CorruptedSession', 'OpenClaw compressed event size mismatch')
        const decoded = Buffer.concat(chunks)
        try {
          text = new TextDecoder('utf8', { fatal: true }).decode(decoded)
        }
        catch {
          ingest.record(binarySafe(row), { path: ref.source.path, table: 'transcript_events', key: String(row.seq) }, { bytes: [...decoded] })
          ingest.unknown('openclaw_event_utf8', binarySafe(row))
          continue
        }
      }
      ingest.record(binarySafe(row), { path: ref.source.path, table: 'transcript_events', key: String(row.seq) }, optional('text', text))
      let native: unknown
      try {
        if (text === undefined)
          throw new Error('missing event payload')
        native = parseNative(text)
      }
      catch {
        ingest.unknown('openclaw_event_json', binarySafe(row))
        continue
      }
      const facts = metadata([native])
      if (facts.id !== undefined && facts.id !== session.session_id) {
        ingest.unknown('openclaw_session_header', native, 'OpenClaw header differs from selected session window')
        continue
      }
      const { id: _id, ...rest } = facts
      ingest.patch(rest)
      normalize(ingest, native)
    }
  },
})
export const openclawProvider = {
  id: 'openclaw',
  detect: async (options?: ScanOptions) => sqlite.detect(options),
  async* scan(options: ScanOptions = {}): AsyncGenerator<ScanEvent> {
    yield* sqlite.scan(options)
    yield* jsonl.scan(options)
  },
  async open(ref: Parameters<typeof sqlite.open>[0], options?: Parameters<typeof sqlite.open>[1]) {
    return ref.source.format === 'openclaw_sqlite' ? sqlite.open(ref, options) : jsonl.open(ref, options)
  },
  async read(ref: Parameters<typeof sqlite.read>[0], options?: Parameters<typeof sqlite.read>[1]) {
    return (await openclawProvider.open(ref, options)).snapshot()
  },
  parse: jsonl.parse,
  stream: jsonl.stream,
}
