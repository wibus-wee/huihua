import { SessionError } from '../contracts/diagnostic.ts'
import type { ReadOptions, ScanEvent, ScanOptions } from '../contracts/provider.ts'
import type { Session, SessionFrame, SessionRef } from '../contracts/session.ts'
import { Ingestion, openFrom } from './ingestion.ts'
import { readJson } from './json-file.ts'
import { exists, files, positiveLimit } from './paths.ts'
import { scanSource } from './scan.ts'
import { optional } from './value.ts'

/** A bounded JSON snapshot is one evidence record, even when it contains many messages. */
export function jsonStoreProvider(adapter: {
  id: string
  format: string
  roots: (options: ScanOptions) => readonly string[]
  accepts: (path: string) => boolean
  sources?: (path: string) => readonly string[]
  metadata: (native: unknown) => Partial<Session>
  parse: (ingest: Ingestion, native: unknown, path: string, ref: SessionRef) => void
}) {
  async function* stream(ref: SessionRef, options: ReadOptions): AsyncGenerator<SessionFrame> {
    const ingest = new Ingestion(adapter.id)
    let nativeId: string | undefined
    for (const path of adapter.sources?.(ref.source.path) ?? [ref.source.path]) {
      options.signal?.throwIfAborted()
      const data = await readJson(path, positiveLimit(options.maxRecordBytes, 16 * 1024 * 1024), false, options.signal)
      ingest.record(data.native, { path }, { ...optional('text', data.text), ...optional('bytes', data.bytes) })
      if (data.malformed) {
        ingest.unknown('malformed_json', data.native)
      }
      else {
        const facts = adapter.metadata(data.native)
        if (facts.id !== undefined && ((nativeId !== undefined && facts.id !== nativeId) || (facts.id !== ref.id && !ref.id.startsWith('source:') && ref.metadata.id_origin !== 'caller')))
          throw new SessionError('CorruptedSession', `conflicting ${adapter.id} snapshot identity`)
        nativeId ??= facts.id
        const { id, ...rest } = facts
        ingest.patch({ ...rest, ...optional('id', ref.id.startsWith('source:') && ref.metadata.id_origin !== 'caller' ? id : undefined), ...optional('metadata', ref.metadata.id_origin === 'caller' ? { ...rest.metadata, id_origin: 'caller' } : rest.metadata) })
        const before = ingest.eventCount()
        adapter.parse(ingest, data.native, path, ref)
        if (ingest.eventCount() === before)
          ingest.unknown('json_snapshot', data.native)
      }
      yield* ingest.drain()
    }
    yield* ingest.finish()
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
          const data = await readJson(path, positiveLimit(options.headerBytes, 65536), false, options.signal)
          yield { type: 'ref', ref: { id: `source:${path}`, provider: adapter.id, source, metadata: { id_origin: 'source_locator' }, ...adapter.metadata(data.native) } }
        })
      }
    },
    open,
    async read(ref: SessionRef, options?: ReadOptions) {
      return (await open(ref, options)).snapshot()
    },
  }
}
