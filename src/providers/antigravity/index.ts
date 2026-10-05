import { Buffer } from 'node:buffer'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'

import { BinaryReader, WireType } from '@bufbuild/protobuf/wire'

import { SessionError } from '../../contracts/diagnostic.ts'
import type { ReadOptions, ScanEvent, ScanOptions } from '../../contracts/provider.ts'
import type { SessionFrame, SessionRef } from '../../contracts/session.ts'
import { contentBlocks, Ingestion, openFrom } from '../../shared/ingestion.ts'
import { exists, files } from '../../shared/paths.ts'
import { scanSource } from '../../shared/scan.ts'
import type { Row } from '../../shared/sqlite.ts'
import { binarySafe, SqliteReader } from '../../shared/sqlite.ts'
import { optional, parseNative } from '../../shared/value.ts'

function roots(options: ScanOptions): readonly string[] {
  const root = options.homeDir === undefined ? process.env.AGY_CONVERSATIONS_DIR : undefined
  return options.roots?.antigravity ?? [root ?? join(options.homeDir ?? homedir(), '.gemini/antigravity-cli/conversations')]
}

/** Select observed schema fields; the maintained library owns wire validation and skipping. */
function field(data: Uint8Array | undefined, number: number): Uint8Array | undefined {
  if (!data)
    return
  const reader = new BinaryReader(data)
  let value: Uint8Array | undefined
  while (reader.pos < reader.len) {
    const [tag, wire] = reader.tag()
    if (tag === number) {
      if (wire !== WireType.LengthDelimited)
        throw new Error(`Antigravity field ${number} has an incompatible wire type`)
      value = reader.bytes()
    }
    else {
      reader.skip(wire, tag)
    }
  }
  return value
}
function text(data: Uint8Array | undefined, number: number): string | undefined {
  const bytes = field(data, number)
  return bytes === undefined ? undefined : new TextDecoder('utf8', { fatal: true }).decode(bytes)
}
function normalize(ingest: Ingestion, row: Row): void {
  const payload = Buffer.isBuffer(row.step_payload) ? row.step_payload : undefined
  if (!payload) {
    ingest.unknown('antigravity_step', binarySafe(row))
    return
  }
  try {
    const user = field(payload, 19)
    const assistant = field(payload, 20)
    const tool = field(field(payload, 5), 4)
    const title = field(payload, 30)
    const envelope = { id: typeof row.idx === 'number' || typeof row.idx === 'bigint' ? String(row.idx) : undefined }
    const before = ingest.eventCount()
    if (row.step_type === 14 && user) {
      const input = text(user, 2) ?? text(field(user, 3), 1)
      if (input !== undefined)
        ingest.emit('user_message', { content: contentBlocks(input) }, envelope)
    }
    else if (row.step_type === 15 && assistant) {
      const output = text(assistant, 1)
      if (output !== undefined)
        ingest.emit('assistant_message', { content: contentBlocks(output) }, envelope)
    }
    else if (row.step_type === 23 && title) {
      const value = text(title, 4)
      ingest.emit('system', { sourceType: 'antigravity_title', payload: { ...optional('title', value) } }, envelope)
      if (value !== undefined)
        ingest.patch({ title: value })
    }
    else if (tool) {
      const name = text(tool, 2) ?? text(tool, 9)
      const args = text(tool, 3)
      let argumentsValue: unknown = args ?? null
      if (args !== undefined) {
        try {
          argumentsValue = parseNative(args)
        }
        catch {
          ingest.diagnostic('PartialParse', 'Antigravity tool input is not valid JSON; original text retained')
        }
      }
      if (name !== undefined)
        ingest.emit('tool_call', { ...optional('callId', text(tool, 1)), toolName: name, arguments: argumentsValue }, envelope, { step_type: row.step_type, status: row.status })
      // Status and tool-result protobuf semantics are not established by the compatibility evidence.
      ingest.diagnostic('PartialParse', 'Antigravity tool result/status remains native evidence; no outcome inferred')
    }
    if (ingest.eventCount() === before)
      ingest.unknown('antigravity_step', binarySafe(row))
  }
  catch (error) {
    ingest.unknown('antigravity_protobuf', binarySafe(row), `invalid or incompatible Antigravity protobuf: ${String(error)}`)
  }
}

function check(db: SqliteReader): void {
  if (!['idx', 'step_type', 'status', 'step_payload'].every(column => db.columns('steps').includes(column)))
    throw new SessionError('UnsupportedSchema', 'unsupported Antigravity steps table')
}
async function* stream(ref: SessionRef, options: ReadOptions): AsyncGenerator<SessionFrame> {
  const db = await SqliteReader.open(ref.source.path, options)
  try {
    check(db)
    const rows: Row[] = []
    for await (const row of db.rows('steps'))
      rows.push(row)
    rows.sort((a, b) => {
      const left = a.idx
      const right = b.idx
      if ((typeof left === 'number' || typeof left === 'bigint') && (typeof right === 'number' || typeof right === 'bigint'))
        return left < right ? -1 : left > right ? 1 : 0
      return 0
    })
    const ingest = new Ingestion('antigravity')
    for (const row of rows) {
      options.signal?.throwIfAborted()
      ingest.record(binarySafe(row), { path: ref.source.path, table: 'steps', key: String(row.idx) })
      normalize(ingest, row)
      yield* ingest.drain()
    }
    yield* ingest.finish()
  }
  finally {
    await db.close()
  }
}
async function open(ref: SessionRef, options: ReadOptions = {}) {
  if (ref.provider !== 'antigravity')
    throw new SessionError('ProviderNotFound', `expected antigravity, got ${ref.provider}`)
  if (ref.source.format !== 'antigravity_sqlite')
    throw new SessionError('UnsupportedSchema', `unsupported Antigravity source format ${ref.source.format}`)
  return openFrom(ref, () => stream(ref, options), 'buffered')
}
export const antigravityProvider = {
  id: 'antigravity',
  async detect(options: ScanOptions = {}) {
    const found: string[] = []
    for (const root of roots(options)) {
      if (await exists(root))
        found.push(root)
    }
    return { provider: 'antigravity', roots: found, available: found.length > 0 }
  },
  async* scan(options: ScanOptions = {}): AsyncGenerator<ScanEvent> {
    for await (const path of files(roots(options), p => p.endsWith('.db'), options, 'antigravity')) {
      if (typeof path !== 'string') {
        yield path
        continue
      }
      const source = { path, format: 'antigravity_sqlite' }
      yield* scanSource('antigravity', source, options, async function* () {
        const db = await SqliteReader.open(path, { ...optional('signal', options.signal), ...optional('maxRecordBytes', options.headerBytes) })
        try {
          check(db)
          yield { type: 'ref', ref: { id: basename(path, '.db'), provider: 'antigravity', source, metadata: { id_origin: 'source_locator', compatibility: 'observed_cli_steps' } } }
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
