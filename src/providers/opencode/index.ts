import { Buffer } from 'node:buffer'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import process from 'node:process'

import { SessionError } from '../../contracts/diagnostic.ts'
import type { ReadOptions, ScanOptions } from '../../contracts/provider.ts'
import type { Session, SessionRef } from '../../contracts/session.ts'
import {
  contentBlocks,
  Ingestion,
  messageEvents,
  openFrom,
} from '../../shared/ingestion.ts'
import { exists, files, ioError, positiveLimit } from '../../shared/paths.ts'
import type { Row } from '../../shared/sqlite.ts'
import { binarySafe, decodeValue, SqliteReader } from '../../shared/sqlite.ts'
import {
  array,
  object,
  optional,
  string,
  timestamp,
} from '../../shared/value.ts'

function roots(options: ScanOptions): readonly string[] {
  const xdg
    = options.homeDir === undefined ? process.env.XDG_DATA_HOME : undefined
  return (
    options.roots?.opencode ?? [
      join(
        xdg !== undefined && isAbsolute(xdg)
          ? xdg
          : join(options.homeDir ?? homedir(), '.local/share'),
        'opencode',
      ),
    ]
  )
}
function metadata(value: unknown): Partial<Session> {
  const v = object(value)
  const time = object(v.time)
  return {
    ...optional('id', string(v.id)),
    ...optional('title', string(v.title)),
    ...optional('createdAt', timestamp(v.time_created ?? time.created)),
    ...optional('updatedAt', timestamp(v.time_updated ?? time.updated)),
    ...optional(
      'workspace',
      typeof v.directory === 'string' ? { path: v.directory } : undefined,
    ),
    ...optional(
      'parentSessionId',
      string(v.parent_id) ?? string(v.parentID) ?? string(v.fork_session_id),
    ),
    metadata: {
      ...optional('id_origin', typeof v.id === 'string' ? 'native' : undefined),
    },
  }
}
async function readJson(
  path: string,
  limit: number,
  prefix = false,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  let file
  try {
    file = await open(path, 'r')
  }
  catch (error) {
    ioError(error, path)
  }
  try {
    const size = (await file.stat()).size
    if (!prefix && size > limit) {
      throw new SessionError(
        'CorruptedSession',
        `JSON record exceeds ${limit} bytes`,
      )
    }
    const data = Buffer.alloc(Math.min(size, limit))
    let offset = 0
    while (offset < data.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await file.read(
        data,
        offset,
        data.length - offset,
        offset,
      )
      if (!bytesRead)
        break
      offset += bytesRead
    }
    return decodeValue(data.subarray(0, offset))
  }
  finally {
    await file.close()
  }
}
function partEvents(
  ingest: Ingestion,
  value: unknown,
  role: string,
  model?: string,
): void {
  const v = object(value)
  const type = string(v.type) ?? 'untyped'
  const state = object(v.state)
  if (
    (type === 'text' || type === 'file')
    && (role === 'user' || role === 'assistant')
  ) {
    messageEvents(ingest, role, value, model)
  }
  else if (type === 'reasoning') {
    ingest.emit('reasoning', { ...optional('text', string(v.text)) })
  }
  else if (type === 'tool') {
    const name = string(v.tool) ?? string(v.name)
    if (name === undefined) {
      ingest.unknown(type, value)
      return
    }
    const callId = string(v.callID) ?? string(v.id)
    ingest.emit('tool_call', {
      ...optional('callId', callId),
      toolName: name,
      arguments: state.input ?? null,
    })
    if (state.status === 'completed' || state.status === 'error') {
      ingest.emit('tool_result', {
        ...optional('callId', callId),
        toolName: name,
        result: state,
        isError: state.status === 'error',
      })
    }
  }
  else if (type === 'step-finish') {
    ingest.emit('usage', { usage: value })
  }
  else if (['step-start', 'snapshot', 'compaction'].includes(type)) {
    ingest.emit('system', { sourceType: type, payload: value })
  }
  else {
    ingest.unknown(type, value)
  }
}
function modernEvents(ingest: Ingestion, value: unknown): void {
  const v = object(value)
  const type = string(v.type) ?? 'untyped'
  if (type === 'user') {
    const content = contentBlocks(v.text ?? null)
    for (const file of array(v.files)) {
      const f = object(file)
      content.push({
        type: 'file',
        data: {
          ...optional('uri', string(f.url) ?? string(f.path)),
          ...optional('mimeType', string(f.mime)),
          metadata: f,
        },
      })
    }
    ingest.emit('user_message', { content })
  }
  else if (type === 'assistant') {
    const before = ingest.eventCount()
    for (const item of array(v.content))
      partEvents(ingest, item, 'assistant', string(object(v.model).id))
    if ('tokens' in v) {
      ingest.emit('usage', {
        usage: { tokens: v.tokens, cost: v.cost ?? null },
      })
    }
    if (before === ingest.eventCount())
      ingest.unknown(type, value)
  }
  else if (type === 'shell') {
    ingest.emit('command', {
      command: v.command ?? null,
      ...optional('output', v.output),
    })
  }
  else if (
    ['system', 'synthetic', 'model-switched', 'agent-switched'].includes(type)
  ) {
    ingest.emit('system', { sourceType: type, payload: value })
  }
  else {
    ingest.unknown(type, value)
  }
}
function emitRow(
  ingest: Ingestion,
  path: string,
  table: string,
  row: Row,
  data: unknown,
  emit: () => void,
  evidence: { text?: string, bytes?: readonly number[] } = {},
): void {
  const native = {
    id: row.id ?? null,
    timestamp: row.time_created ?? object(object(data).time).created ?? null,
    native_row: binarySafe(row),
    data,
  }
  ingest.record(
    native,
    { path, table, position: ingest.eventCount() },
    evidence,
  )
  emit()
}
function compare(keys: readonly string[]) {
  return (a: Row, b: Row): number => {
    for (const key of keys) {
      const x = a[key]
      const y = b[key]
      if (x === y)
        continue
      if (x === null || x === undefined)
        return -1
      if (y === null || y === undefined)
        return 1
      if (
        (typeof x === 'number' || typeof x === 'bigint')
        && (typeof y === 'number' || typeof y === 'bigint')
      ) {
        return x < y ? -1 : 1
      }
      const c = String(x) < String(y) ? -1 : 1
      return c
    }
    return 0
  }
}
async function associated(
  db: SqliteReader,
  table: string,
  id: string,
  keys: readonly string[],
  column = 'session_id',
): Promise<Row[]> {
  const rows: Row[] = []
  for await (const row of db.rows(table)) {
    if (row[column] === id)
      rows.push(row)
  }
  return rows.sort(compare(keys))
}
async function* readDatabase(ref: SessionRef, options: ReadOptions) {
  const id = string(ref.source.locator?.id)
  const table = ref.source.locator?.table ?? 'session'
  if (id === undefined)
    throw new SessionError('SessionNotFound', 'missing OpenCode selector')
  if (table !== 'session' && table !== 'session_v2') {
    throw new SessionError(
      'UnsupportedSchema',
      'invalid OpenCode session table selector',
    )
  }
  const db = await SqliteReader.open(ref.source.path, options)
  const ingest = new Ingestion('opencode')
  try {
    let native: Row | undefined
    for await (const row of db.rows(table)) {
      if (row.id === id) {
        native = row
        break
      }
    }
    if (!native) {
      throw new SessionError(
        'SessionNotFound',
        'OpenCode session no longer exists',
      )
    }
    ingest.record(binarySafe(native), {
      path: ref.source.path,
      table,
      position: 0,
    })
    ingest.patch(metadata(native))
    ingest.emit('system', { sourceType: table, payload: binarySafe(native) })
    yield* ingest.drain()
    async function* unknownTable(table: string) {
      const columns = db.columns(table)
      if (!columns.includes('session_id')) {
        ingest.diagnostic(
          'PartialParse',
          `${table} lacks session_id; cannot associate rows safely`,
        )
        yield* ingest.drain()
        return
      }
      for (const row of await associated(
        db,
        table,
        id!,
        columns.includes('id')
          ? ['id']
          : columns.includes('position')
            ? ['position']
            : ['session_id'],
      )) {
        const decoded = decodeValue(row.data)
        emitRow(
          ingest,
          ref.source.path,
          table,
          row,
          decoded.native,
          () => ingest.unknown(table, { type: table, data: decoded.native }),
          decoded,
        )
        yield* ingest.drain()
      }
    }
    if (db.tables.has('session_message')) {
      const cols = db.columns('session_message')
      if (
        !['id', 'session_id', 'type', 'data'].every(c => cols.includes(c))
      ) {
        ingest.diagnostic(
          'PartialParse',
          'partially migrated session_message table; native rows retained',
        )
        yield* unknownTable('session_message')
      }
      else {
        if (!cols.includes('seq')) {
          ingest.diagnostic(
            'PartialParse',
            'session_message lacks seq; using stable native time/id order',
          )
        }
        for (const row of await associated(
          db,
          'session_message',
          id,
          cols.includes('seq')
            ? ['seq', 'id']
            : cols.includes('time_created')
              ? ['time_created', 'id']
              : ['id'],
        )) {
          const decoded = decodeValue(row.data)
          const data
            = typeof decoded.native === 'object'
              && decoded.native !== null
              && !Array.isArray(decoded.native)
              ? { ...object(decoded.native), type: row.type }
              : decoded.native
          emitRow(
            ingest,
            ref.source.path,
            'session_message',
            row,
            data,
            () => modernEvents(ingest, data),
            decoded,
          )
          yield* ingest.drain()
        }
      }
    }
    if (db.tables.has('message')) {
      const cols = db.columns('message')
      if (!cols.includes('session_id')) {
        ingest.diagnostic('PartialParse', 'message table lacks session_id')
      }
      else {
        for (const row of await associated(
          db,
          'message',
          id,
          cols.includes('time_created') ? ['time_created', 'id'] : ['id'],
        )) {
          const decoded = decodeValue(row.data)
          const info = object(decoded.native)
          const messageId = string(row.id) ?? ''
          emitRow(
            ingest,
            ref.source.path,
            'message',
            row,
            decoded.native,
            () => {
              ingest.emit('system', {
                sourceType: 'message_metadata',
                payload: decoded.native,
              })
              if ('tokens' in info) {
                ingest.emit('usage', {
                  usage: { tokens: info.tokens, cost: info.cost ?? null },
                })
              }
              if ('error' in info)
                ingest.emit('error', { details: info.error })
            },
            decoded,
          )
          yield* ingest.drain()
          if (
            db.tables.has('part')
            && db.columns('part').includes('message_id')
          ) {
            for (const part of await associated(
              db,
              'part',
              messageId,
              ['id'],
              'message_id',
            )) {
              const decoded = decodeValue(part.data)
              emitRow(
                ingest,
                ref.source.path,
                'part',
                part,
                decoded.native,
                () =>
                  partEvents(
                    ingest,
                    decoded.native,
                    string(info.role) ?? '',
                    string(info.modelID),
                  ),
                decoded,
              )
              yield* ingest.drain()
            }
          }
          else {
            ingest.diagnostic(
              'PartialParse',
              `parts unavailable for message ${messageId}`,
            )
            yield* ingest.drain()
          }
        }
      }
      // Association with a message anywhere in the store is evidence; do not invent orphans.
      const allIds = new Set<string>()
      for await (const row of db.rows('message')) {
        if (typeof row.id === 'string')
          allIds.add(row.id)
      }
      if (
        db.columns('part').includes('message_id')
        && db.columns('part').includes('session_id')
      ) {
        for (const row of await associated(db, 'part', id, ['id'])) {
          if (!allIds.has(String(row.message_id))) {
            const decoded = decodeValue(row.data)
            ingest.diagnostic(
              'PartialParse',
              'orphan part without message metadata',
            )
            emitRow(
              ingest,
              ref.source.path,
              'part',
              row,
              decoded.native,
              () =>
                ingest.unknown(
                  string(object(decoded.native).type) ?? 'untyped',
                  decoded.native,
                ),
              decoded,
            )
            yield* ingest.drain()
          }
        }
      }
    }
    else if (db.tables.has('part')) {
      yield* unknownTable('part')
    }
    else if (!db.tables.has('session_message')) {
      ingest.diagnostic(
        'PartialParse',
        'no message tables; session metadata retained',
      )
    }
    for (const name of ['session_input', 'todo']) {
      if (db.tables.has(name))
        yield* unknownTable(name)
    }
    yield* ingest.finish()
  }
  finally {
    await db.close()
  }
}
function safeComponent(id: string): void {
  if (!id || id === '.' || id === '..' || /[/\\\0:]/.test(id)) {
    throw new SessionError(
      'CorruptedSession',
      'native filesystem ID is not a single safe path component',
    )
  }
}
async function* readFilesystem(ref: SessionRef, options: ReadOptions) {
  const limit = positiveLimit(options.maxRecordBytes, 16 * 1024 * 1024)
  const ingest = new Ingestion('opencode')
  const decoded = await readJson(ref.source.path, limit, false, options.signal)
  const facts = metadata(decoded.native)
  ingest.record(
    decoded.native,
    { path: ref.source.path, position: 0 },
    decoded,
  )
  ingest.patch(facts)
  ingest.emit('system', { sourceType: 'session', payload: decoded.native })
  yield* ingest.drain()
  let root = dirname(ref.source.path)
  while (basename(root) !== 'storage' && dirname(root) !== root)
    root = dirname(root)
  if (basename(root) !== 'storage') {
    ingest.diagnostic(
      'PartialParse',
      'standalone metadata; related storage root unavailable',
    )
    yield* ingest.finish()
    return
  }
  const id = facts.id ?? ref.id
  safeComponent(id)
  for (const base of [root, join(root, 'session')]) {
    for await (const path of files(
      [join(base, 'message', id)],
      p => p.endsWith('.json'),
      options.signal,
    )) {
      const decoded = await readJson(path, limit, false, options.signal)
      const info = object(decoded.native)
      const messageId = string(info.id) ?? ''
      let valid = true
      try {
        safeComponent(messageId)
      }
      catch {
        valid = false
      }
      if (!valid) {
        ingest.diagnostic(
          'PartialParse',
          'legacy message has no safe ID; retained without traversing part paths',
        )
        emitRow(
          ingest,
          path,
          'message',
          info,
          decoded.native,
          () => ingest.unknown(string(info.type) ?? 'untyped', decoded.native),
          decoded,
        )
        yield* ingest.drain()
        continue
      }
      emitRow(
        ingest,
        path,
        'message',
        info,
        decoded.native,
        () =>
          ingest.emit('system', {
            sourceType: 'message_metadata',
            payload: decoded.native,
          }),
        decoded,
      )
      yield* ingest.drain()
      for await (const path of files(
        [join(base, 'part', messageId), join(base, 'part', id, messageId)],
        p => p.endsWith('.json'),
        options.signal,
      )) {
        const decoded = await readJson(path, limit, false, options.signal)
        emitRow(
          ingest,
          path,
          'part',
          object(decoded.native),
          decoded.native,
          () =>
            partEvents(
              ingest,
              decoded.native,
              string(info.role) ?? '',
              string(info.modelID),
            ),
          decoded,
        )
        yield* ingest.drain()
      }
    }
  }
  yield* ingest.finish()
}
async function openSession(ref: SessionRef, options: ReadOptions = {}) {
  if (ref.provider !== 'opencode')
    throw new SessionError('ProviderNotFound', 'expected opencode reference')
  if (ref.source.format === 'opencode_sqlite')
    return openFrom(ref, () => readDatabase(ref, options), 'buffered')
  if (ref.source.format === 'opencode_files')
    return openFrom(ref, () => readFilesystem(ref, options), 'incremental')
  throw new SessionError('UnsupportedSchema', 'unknown OpenCode source format')
}
export const opencodeProvider = {
  id: 'opencode',
  open: openSession,
  async detect(options: ScanOptions = {}) {
    const found: string[] = []
    for (const path of roots(options)) {
      if (await exists(path))
        found.push(path)
    }
    return { provider: 'opencode', roots: found, available: found.length > 0 }
  },
  async scan(options: ScanOptions = {}): Promise<SessionRef[]> {
    const refs: SessionRef[] = []
    const explicitFiles = new Set(roots(options).map(p => resolve(p)))
    for await (const path of files(
      roots(options),
      p => /\.(?:db|sqlite|json)$/.test(p),
      options.signal,
    )) {
      if (path.endsWith('.json')) {
        const directories = dirname(path).split(sep)
        if (
          !explicitFiles.has(path)
          && (!directories.some(p => p === 'session' || p === 'info')
            || directories.some(p => p === 'message' || p === 'part'))
        ) {
          continue
        }
        const native = await readJson(
          path,
          positiveLimit(options.headerBytes, 65536),
          true,
          options.signal,
        )
        refs.push({
          id: `source:${path}`,
          provider: 'opencode',
          metadata: { id_origin: 'source_locator' },
          ...metadata(native.native),
          source: { path, format: 'opencode_files' },
        })
      }
      else {
        const db = await SqliteReader.open(path, {
          ...optional('signal', options.signal),
        })
        try {
          for (const table of ['session', 'session_v2']) {
            if (!db.tables.has(table))
              continue
            if (!db.columns(table).includes('id')) {
              throw new SessionError(
                'UnsupportedSchema',
                `${table} table lacks id`,
              )
            }
            for await (const row of db.rows(table)) {
              const id = string(row.id)
              if (id === undefined) {
                throw new SessionError(
                  'UnsupportedSchema',
                  `${table} session id is not text`,
                )
              }
              refs.push({
                id,
                provider: 'opencode',
                metadata: {},
                ...metadata(row),
                source: {
                  path,
                  format: 'opencode_sqlite',
                  locator: { id, ...(table === 'session' ? {} : { table }) },
                },
              })
            }
          }
        }
        finally {
          await db.close()
        }
      }
    }
    return refs
  },
  async read(ref: SessionRef, options?: ReadOptions) {
    return (await openSession(ref, options)).snapshot()
  },
}
