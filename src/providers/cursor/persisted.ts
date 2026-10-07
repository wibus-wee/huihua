import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import { BinaryReader, WireType } from '@bufbuild/protobuf/wire'

import { SessionError } from '../../contracts/diagnostic.ts'
import type { ReadOptions } from '../../contracts/provider.ts'
import type { SessionFrame, SessionRef } from '../../contracts/session.ts'
import type { RawRecord } from '../../contracts/source.ts'
import { contentBlocks, Ingestion, openFrom } from '../../shared/ingestion.ts'
import { readJson } from '../../shared/json-file.ts'
import { canonicalPath, exists, positiveLimit } from '../../shared/paths.ts'
import type { Row } from '../../shared/sqlite.ts'
import { binarySafe, decodeValue, SqliteReader } from '../../shared/sqlite.ts'
import { object, optional, string, timestamp } from '../../shared/value.ts'

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const blobId = /^[\da-f]{64}$/i

/** Private field selection only; the maintained protobuf library owns wire validation. */
function fields(data: Uint8Array): Map<number, Uint8Array[]> {
  const result = new Map<number, Uint8Array[]>()
  const reader = new BinaryReader(data)
  try {
    while (reader.pos < reader.len) {
      const [tag, wire] = reader.tag()
      if (wire === WireType.LengthDelimited) {
        const values = result.get(tag) ?? []
        values.push(reader.bytes())
        result.set(tag, values)
      }
      else {
        reader.skip(wire, tag)
      }
    }
  }
  catch (error) {
    throw new SessionError('CorruptedSession', 'invalid Cursor protobuf graph', { cause: error })
  }
  return result
}
function single(values: Uint8Array[] | undefined): Uint8Array {
  if (values?.length !== 1)
    throw new SessionError('CorruptedSession', 'missing or repeated Cursor graph field')
  return values[0]!
}
function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function hex(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !/^(?:[\da-f]{2})+$/i.test(value))
    return
  return Buffer.from(value, 'hex')
}

export async function persistedSidecar(path: string, options: ReadOptions) {
  if (!await exists(path) || !await canonicalPath(path))
    return
  const sidecar = await readJson(path, positiveLimit(options.maxRecordBytes, 16 * 1024 * 1024), false, options.signal)
  return object(sidecar.native).schemaVersion === 1 ? sidecar : undefined
}

export async function persistedIdentity(db: SqliteReader, path: string, storage: 'chat' | 'acp', options: ReadOptions, companionData?: Awaited<ReturnType<typeof readJson>>) {
  if (!['key', 'value'].every(column => db.columns('meta').includes(column))
    || !['id', 'data'].every(column => db.columns('blobs').includes(column))) {
    return
  }
  let sidecar: Awaited<ReturnType<typeof readJson>> | undefined
  const companion = join(dirname(path), 'meta.json')
  if (storage === 'acp') {
    if (!await canonicalPath(path))
      return
    sidecar = companionData ?? await persistedSidecar(companion, options)
    if (!sidecar)
      return
  }
  for await (const row of db.rows('meta')) {
    if (row.key !== '0')
      continue
    const bytes = hex(row.value)
    if (!bytes)
      return
    if (bytes.length > positiveLimit(options.maxRecordBytes, 16 * 1024 * 1024))
      throw new SessionError('CorruptedSession', 'Cursor session metadata exceeds record limit')
    const decoded = decodeValue(bytes)
    const v = object(decoded.native)
    const id = string(v.agentId)
    const root = string(v.latestRootBlobId)
    const directoryId = basename(dirname(path))
    if (id === undefined || !uuid.test(id) || root === undefined || !blobId.test(root)
      || (uuid.test(directoryId) && id.toLowerCase() !== directoryId.toLowerCase())) {
      return
    }
    // Discovery checks the bounded root node, without decoding the full conversation graph.
    let found = false
    for await (const blob of db.rows('blobs')) {
      if (String(blob.id).toLowerCase() === root.toLowerCase()) {
        if (!Buffer.isBuffer(blob.data) || hash(blob.data) !== root.toLowerCase())
          return
        try {
          fields(blob.data)
        }
        catch { return }
        found = true
        break
      }
    }
    if (!found)
      return
    const facts: Omit<SessionRef, 'source' | 'provider'> = {
      id,
      ...optional('title', string(v.name)),
      ...optional('createdAt', timestamp(v.createdAt)),
      ...optional('workspace', typeof object(sidecar?.native).cwd === 'string' ? { path: String(object(sidecar?.native).cwd) } : undefined),
      metadata: { id_origin: 'native', sourceFamily: storage, ...optional('lastUsedModel', v.lastUsedModel), ...optional('mode', v.mode) },
    }
    return { facts, row, decoded, root: root.toLowerCase(), sidecar, companion }
  }
}

export async function openPersisted(ref: SessionRef, storage: 'chat' | 'acp', options: ReadOptions) {
  return openFrom(ref, async function* () {
    const db = await SqliteReader.open(ref.source.path, options)
    const ingest = new Ingestion('cursor')
    function* frames(batch: SessionFrame[] = ingest.drain()) {
      for (const frame of batch) {
        options.signal?.throwIfAborted()
        yield frame
        options.signal?.throwIfAborted()
      }
    }
    try {
      const identity = await persistedIdentity(db, ref.source.path, storage, options)
      if (!identity)
        throw new SessionError('UnsupportedSchema', 'invalid Cursor persisted session metadata, identity or root')
      if (identity.facts.id !== ref.id || ref.source.locator?.id !== ref.id)
        throw new SessionError('SessionNotFound', 'Cursor persisted session identity changed')
      if (identity.sidecar) {
        ingest.record(identity.sidecar.native, { path: identity.companion }, identity.sidecar)
        ingest.emit('system', { sourceType: 'cursor_persisted_metadata', payload: identity.sidecar.native })
      }
      ingest.patch(identity.facts)
      for await (const row of db.rows('meta')) {
        const decoded = row.key === '0' ? identity.decoded : decodeValue(hex(row.value) ?? row.value)
        ingest.record({ native_row: binarySafe(row), value: decoded.native }, { path: ref.source.path, table: 'meta', key: String(row.key) }, decoded)
        ingest.emit('system', { sourceType: 'cursor_persisted_meta', payload: decoded.native })
        yield* frames()
      }
      const blobs = new Map<string, Row>()
      for await (const row of db.rows('blobs')) {
        if (typeof row.id !== 'string' || !blobId.test(row.id) || !Buffer.isBuffer(row.data) || hash(row.data) !== row.id.toLowerCase())
          throw new SessionError('CorruptedSession', 'invalid Cursor content-addressed blob')
        if (blobs.has(row.id.toLowerCase()))
          throw new SessionError('CorruptedSession', 'duplicate Cursor content address')
        blobs.set(row.id.toLowerCase(), row)
      }
      const recorded = new Map<string, RawRecord>()
      function node(id: string, normalize: (data: Buffer) => void): void {
        options.signal?.throwIfAborted()
        const row = blobs.get(id)
        if (!row || !Buffer.isBuffer(row.data))
          throw new SessionError('CorruptedSession', `missing Cursor graph blob ${id}`)
        const record = recorded.get(id)
        if (record)
          ingest.associate(record)
        else recorded.set(id, ingest.record(binarySafe(row), { path: ref.source.path, table: 'blobs', key: id }, { bytes: [...row.data] }))
        try {
          normalize(row.data)
        }
        catch (error) {
          if (error instanceof SessionError)
            throw error
          throw new SessionError('CorruptedSession', 'invalid Cursor protobuf graph', { cause: error })
        }
      }
      function reference(bytes: Uint8Array): string {
        if (bytes.length !== 32)
          throw new SessionError('CorruptedSession', 'invalid Cursor graph reference')
        return Buffer.from(bytes).toString('hex')
      }
      function text(data: Buffer, role: 'user' | 'assistant'): void {
        const value = new TextDecoder('utf8', { fatal: true }).decode(single(fields(data).get(1)))
        ingest.emit(role === 'user' ? 'user_message' : 'assistant_message', { content: contentBlocks(value) })
      }
      let turns: Uint8Array[] = []
      node(identity.root, (data) => {
        turns = fields(data).get(8) ?? []
        ingest.emit('system', { sourceType: 'cursor_conversation_root', payload: binarySafe(blobs.get(identity.root)!) })
      })
      yield* frames()
      for (const turn of turns) {
        let agent: Uint8Array | undefined
        node(reference(turn), (data) => {
          const values = fields(data)
          const count = (values.get(1)?.length ?? 0) + (values.get(2)?.length ?? 0)
          if (count > 1)
            throw new SessionError('CorruptedSession', 'ambiguous Cursor conversation turn')
          agent = values.get(1)?.[0]
          if (agent)
            ingest.emit('system', { sourceType: 'cursor_agent_turn', payload: binarySafe(blobs.get(reference(turn))!) })
          else ingest.unknown(count === 0 ? 'cursor_private_turn' : 'cursor_shell_turn', binarySafe(blobs.get(reference(turn))!))
        })
        yield* frames()
        if (!agent)
          continue
        const values = fields(agent)
        node(reference(single(values.get(1))), data => text(data, 'user'))
        yield* frames()
        for (const step of values.get(2) ?? []) {
          let assistant: Uint8Array | undefined
          node(reference(step), (data) => {
            const variants = fields(data)
            const kinds = [1, 2, 3].filter(kind => variants.has(kind))
            if (kinds.length > 1 || (kinds.length === 1 && variants.get(kinds[0]!)!.length !== 1))
              throw new SessionError('CorruptedSession', 'ambiguous Cursor conversation step')
            if (kinds[0] === 1) {
              assistant = single(variants.get(1))
              ingest.emit('system', { sourceType: 'cursor_assistant_step', payload: binarySafe(blobs.get(reference(step))!) })
            }
            else {
              ingest.unknown('cursor_private_step', binarySafe(blobs.get(reference(step))!))
            }
          })
          yield* frames()
          if (assistant) {
            node(reference(assistant), data => text(data, 'assistant'))
            yield* frames()
          }
        }
      }
      // Historical/unreferenced nodes stay evidence; their order is not invented as conversation.
      for (const [id] of blobs) {
        if (!recorded.has(id)) {
          node(id, () => ingest.unknown('cursor_unreferenced_blob', binarySafe(blobs.get(id)!)))
          yield* frames()
        }
      }
      yield* frames(ingest.finish())
    }
    finally {
      await db.close()
    }
  }, 'buffered')
}
