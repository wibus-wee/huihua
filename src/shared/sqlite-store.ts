import { SessionError } from '../contracts/diagnostic.ts'
import type { ReadOptions, ScanEvent, ScanOptions } from '../contracts/provider.ts'
import type { Session, SessionFrame, SessionRef } from '../contracts/session.ts'
import { Ingestion, openFrom } from './ingestion.ts'
import { exists, files, positiveLimit } from './paths.ts'
import { scanSource } from './scan.ts'
import type { Row } from './sqlite.ts'
import { binarySafe, SqliteReader } from './sqlite.ts'
import { optional } from './value.ts'

/** Select a native session and retain its complete metadata and ordered row evidence. */
export function sqliteStoreProvider(adapter: {
  id: string
  format: string
  roots: (options: ScanOptions) => readonly string[]
  accepts: (path: string) => boolean
  table: string
  sessionTable?: string
  sessionKey?: string
  columns: readonly string[]
  metadata: (row: Row) => Partial<Session>
  normalize: (ingest: Ingestion, rows: Row[], session: Row, ref: SessionRef, options: ReadOptions) => void | Promise<void>
}) {
  const sessionTable = adapter.sessionTable ?? 'sessions'
  const sessionKey = adapter.sessionKey ?? 'id'
  function check(db: SqliteReader) {
    if (!db.columns(sessionTable).includes(sessionKey) || !adapter.columns.every(column => db.columns(adapter.table).includes(column)))
      throw new SessionError('UnsupportedSchema', `unsupported ${adapter.id} ${sessionTable}/${adapter.table} schema`)
  }
  async function* stream(ref: SessionRef, options: ReadOptions): AsyncGenerator<SessionFrame> {
    const id = ref.source.locator?.id
    if (typeof id !== 'string')
      throw new SessionError('UnsupportedSchema', `${adapter.id} database requires locator.id`)
    const db = await SqliteReader.open(ref.source.path, options)
    try {
      check(db)
      let selected: Row | undefined
      for await (const row of db.rows(sessionTable)) {
        if (row[sessionKey] === id)
          selected = row
      }
      if (!selected)
        throw new SessionError('SessionNotFound', `${adapter.id} session ${id} was not found`)
      const ingest = new Ingestion(adapter.id)
      ingest.record(binarySafe(selected), { path: ref.source.path, table: sessionTable, key: id })
      const { id: nativeId, ...facts } = adapter.metadata(selected)
      ingest.patch({ ...facts, ...optional('id', ref.metadata.id_origin === 'caller' ? undefined : nativeId), ...optional('metadata', ref.metadata.id_origin === 'caller' ? { ...facts.metadata, id_origin: 'caller' } : facts.metadata) })
      ingest.emit('system', { sourceType: 'session_metadata', payload: binarySafe(selected) })
      yield* ingest.drain()
      const rows: Row[] = []
      const index = db.indexes(adapter.table).find(candidate => candidate.columns[0] === 'session_id')
      if (index !== undefined) {
        const found: { rowid: number | bigint, row: Row }[] = []
        for (const rowid of await db.rowIds(index, [id])) {
          const row = await db.rowById(adapter.table, rowid)
          if (row !== undefined)
            found.push({ rowid, row })
        }
        found.sort((a, b) => (a.rowid < b.rowid ? -1 : a.rowid > b.rowid ? 1 : 0))
        rows.push(...found.map(entry => entry.row))
      }
      else {
        for await (const row of db.rows(adapter.table)) {
          if (row.session_id === id)
            rows.push(row)
        }
      }
      await adapter.normalize(ingest, rows, selected, ref, options)
      const changed = await db.changedPaths()
      if (changed.length !== 0)
        ingest.diagnostic('PartialParse', `SQLite store changed during reading: ${changed.join(', ')}; delivered rows may span inconsistent snapshots`)
      yield* ingest.drain()
      yield* ingest.finish()
    }
    finally {
      await db.close(false)
    }
  }
  async function open(ref: SessionRef, options: ReadOptions = {}) {
    if (ref.provider !== adapter.id)
      throw new SessionError('ProviderNotFound', `expected ${adapter.id}, got ${ref.provider}`)
    if (ref.source.format !== adapter.format)
      throw new SessionError('UnsupportedSchema', `unsupported ${adapter.id} source format ${ref.source.format}`)
    return openFrom(ref, () => stream(ref, options), 'buffered')
  }
  return {
    id: adapter.id,
    async detect(options: ScanOptions = {}) {
      const roots: string[] = []
      for (const path of adapter.roots(options)) {
        if (await exists(path))
          roots.push(path)
      }
      return { provider: adapter.id, roots, available: roots.length > 0 }
    },
    async* scan(options: ScanOptions = {}): AsyncGenerator<ScanEvent> {
      for await (const path of files(adapter.roots(options), adapter.accepts, options, adapter.id)) {
        if (typeof path !== 'string') {
          yield path
          continue
        }
        const source = { path, format: adapter.format }
        yield* scanSource(adapter.id, source, options, async function* () {
          const db = await SqliteReader.open(path, { ...optional('signal', options.signal), maxRecordBytes: positiveLimit(options.headerBytes, 65536) })
          try {
            check(db)
            for await (const row of db.rows(sessionTable)) {
              if (typeof row[sessionKey] !== 'string')
                throw new SessionError('UnsupportedSchema', `${adapter.id} session identity is not a string`)
              const id = String(row[sessionKey])
              yield { type: 'ref', ref: { id, provider: adapter.id, source: { ...source, locator: { id } }, metadata: { id_origin: 'native' }, ...adapter.metadata(row) } }
            }
          }
          finally {
            await db.close()
          }
        })
      }
    },
    open,
    async read(ref: SessionRef, options?: ReadOptions) {
      return (await open(ref, options)).snapshot()
    },
  }
}
