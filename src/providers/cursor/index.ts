import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { SessionError } from '../../contracts/diagnostic.ts'
import type { ReadOptions, ScanEvent, ScanOptions } from '../../contracts/provider.ts'
import type { SessionRef } from '../../contracts/session.ts'
import {
  Ingestion,
  jsonlProvider,
  messageEvents,
  openFrom,
} from '../../shared/ingestion.ts'
import { files } from '../../shared/paths.ts'
import { scanSource } from '../../shared/scan.ts'
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
  const home = options.homeDir ?? homedir()
  return (
    options.roots?.cursor ?? [
      join(home, 'Library/Application Support/Cursor/User'),
      join(home, '.config/Cursor/User'),
      join(home, 'AppData/Roaming/Cursor/User'),
      join(home, '.cursor/projects'),
    ]
  )
}
const cli = jsonlProvider({
  id: 'cursor',
  roots,
  metadata(records) {
    const id = records
      .map(v => string(object(v).sessionId))
      .find(v => v !== undefined)
    return { ...optional('id', id), metadata: {} }
  },
  parse(ingest, native) {
    const v = object(native)
    const role = string(v.role)
    const message = object(v.message)
    const error = string(v.error)
    if ((role === 'user' || role === 'assistant') && 'content' in message)
      messageEvents(ingest, role, message.content)
    else if ((role === undefined || role === '') && v.type === 'turn_ended' && v.status === 'error' && error !== undefined && error !== '')
      ingest.emit('error', { message: error, details: native })
    else ingest.unknown(string(v.type) ?? 'untyped', native)
  },
})
function payload(row: Row): unknown {
  return decodeValue(row.value).native
}
function wrapped(row: Row, id?: string): Row {
  const v = payload(row)
  return {
    ...optional('id', id),
    ...optional('timestamp', object(v).createdAt),
    value: v,
    native_row: binarySafe(row),
  }
}
function bubble(ingest: Ingestion, value: unknown): void {
  const v = object(value)
  const role = v.type === 1 ? 'user' : v.type === 2 ? 'assistant' : undefined
  if (!role) {
    ingest.unknown(string(v.type) ?? 'untyped', value)
    return
  }
  if ('text' in v || 'content' in v) {
    messageEvents(
      ingest,
      role,
      'text' in v ? v.text : v.content,
      string(v.model),
    )
  }
  else if ('richText' in v) {
    const content = [{ type: 'structured' as const, data: v.richText }]
    if (role === 'user')
      ingest.emit('user_message', { content })
    else ingest.emit('assistant_message', { content })
  }
  else {
    ingest.unknown('unknown', value)
  }
}
async function* scanDatabase(
  path: string,
  options: ScanOptions,
): AsyncGenerator<ScanEvent> {
  const db = await SqliteReader.open(path, {
    ...optional('signal', options.signal),
  })
  function ref(id: string, value: unknown, storage: string): SessionRef {
    const v = object(value)
    return {
      id,
      provider: 'cursor',
      ...optional('title', string(v.name)),
      ...optional('createdAt', timestamp(v.createdAt)),
      source: { path, format: 'cursor_sqlite', locator: { id, storage } },
      metadata: {},
    }
  }
  try {
    let found = false
    for await (const row of db.rows('cursorDiskKV')) {
      if (typeof row.key === 'string' && row.key.startsWith('composerData:')) {
        found = true
        yield { type: 'ref', ref: ref(row.key.slice(13), payload(row), 'modern') }
      }
    }
    if (!found) {
      for await (const row of db.rows('ItemTable')) {
        if (row.key === 'composer.composerData') {
          for (const value of array(object(payload(row)).allComposers)) {
            const id = string(object(value).composerId)
            if (id !== undefined) {
              found = true
              yield { type: 'ref', ref: ref(id, value, 'legacy') }
            }
          }
        }
      }
    }
    if (!found && basename(path) === 'store.db' && !db.tables.has('ItemTable')) {
      throw new SessionError(
        'UnsupportedSchema',
        'Cursor CLI store.db protobuf is unsupported; use agent-transcripts JSONL',
      )
    }
  }
  finally {
    await db.close()
  }
}
async function openCursor(ref: SessionRef, options: ReadOptions = {}) {
  if (ref.provider !== 'cursor')
    throw new SessionError('ProviderNotFound', 'expected cursor reference')
  if (ref.source.format === 'jsonl')
    return cli.open(ref, options)
  if (ref.source.format !== 'cursor_sqlite')
    throw new SessionError('UnsupportedSchema', 'unknown Cursor source format')
  const id = string(ref.source.locator?.id)
  const storage = ref.source.locator?.storage
  if (id === undefined) {
    throw new SessionError(
      'SessionNotFound',
      'missing Cursor composer selector',
    )
  }
  if (storage !== 'modern' && storage !== 'legacy') {
    throw new SessionError(
      'UnsupportedSchema',
      'unknown Cursor storage generation',
    )
  }
  return openFrom(ref, async function* () {
    const db = await SqliteReader.open(ref.source.path, options)
    const ingest = new Ingestion('cursor')
    try {
      let row: Row | undefined
      for await (const candidate of db.rows(
        storage === 'modern' ? 'cursorDiskKV' : 'ItemTable',
      )) {
        if (
          candidate.key
          === (storage === 'modern'
            ? `composerData:${id}`
            : 'composer.composerData')
        ) {
          row = candidate
          break
        }
      }
      if (!row)
        throw new SessionError('SessionNotFound', 'composer no longer exists')
      const native = wrapped(row)
      const selected
        = storage === 'modern'
          ? native.value
          : array(object(native.value).allComposers).find(
              v => object(v).composerId === id,
            )
      if (selected === undefined)
        throw new SessionError('SessionNotFound', 'composer no longer exists')
      const facts = object(selected)
      const composer
        = storage === 'modern'
          ? { key: row.key, value: selected, native_row: binarySafe(row) }
          : { key: row.key, value: selected }
      ingest.record(
        { ...composer, native_row: binarySafe(row) },
        {
          path: ref.source.path,
          table: storage === 'modern' ? 'cursorDiskKV' : 'ItemTable',
          key: String(row.key),
          position: 0,
        },
      )
      ingest.patch({
        ...optional('title', string(facts.name)),
        ...optional('createdAt', timestamp(facts.createdAt)),
        ...optional(
          'workspace',
          typeof facts.cwd === 'string' ? { path: facts.cwd } : undefined,
        ),
      })
      ingest.emit(
        'system',
        { sourceType: 'composerData', payload: composer },
        composer,
      )
      yield* ingest.drain()
      const bubbles = new Map<string, Row>()
      for (const [key, value] of Object.entries(object(facts.conversationMap))) {
        bubbles.set(key, {
          id: key,
          value,
          native_field: 'conversationMap',
          ...optional('timestamp', object(value).createdAt),
        })
      }
      if (storage === 'modern') {
        for await (const item of db.rows('cursorDiskKV')) {
          if (
            typeof item.key === 'string'
            && item.key.startsWith(`bubbleId:${id}:`)
          ) {
            bubbles.set(
              item.key.slice(`bubbleId:${id}:`.length),
              wrapped(item, item.key.slice(`bubbleId:${id}:`.length)),
            )
          }
        }
      }
      else if (Array.isArray(facts.conversation)) {
        for (const [index, value] of facts.conversation.entries()) {
          ingest.record(value, { path: ref.source.path, position: index + 1 })
          bubble(ingest, value)
          yield* ingest.drain()
        }
        yield* ingest.finish()
        return
      }
      else if (!Object.keys(object(facts.conversationMap)).length) {
        ingest.diagnostic(
          'PartialParse',
          'legacy composer metadata has no inline conversation; bubbles may live in globalStorage',
        )
      }
      const ordered: Row[] = []
      for (const entry of array(facts.fullConversationHeadersOnly)) {
        const key = string(object(entry).bubbleId)
        if (key === undefined)
          continue
        const item = bubbles.get(key)
        if (item) {
          ordered.push(item)
          bubbles.delete(key)
        }
        else {
          ingest.diagnostic('PartialParse', `missing bubble ${key}`)
        }
      }
      if (bubbles.size) {
        ingest.diagnostic(
          'PartialParse',
          'bubbles absent from header ordering; appended in stable native key order',
        )
        for (const key of [...bubbles.keys()].sort())
          ordered.push(bubbles.get(key)!)
      }
      for (const [index, value] of ordered.entries()) {
        ingest.record(value, {
          path: ref.source.path,
          position: index + 1,
          table: 'cursorDiskKV',
          ...optional('key', string(object(value.native_row).key)),
        })
        bubble(ingest, value.value)
        yield* ingest.drain()
      }
      if (storage === 'modern') {
        for (const namespace of ['checkpointId', 'messageRequestContext']) {
          const rows: Row[] = []
          for await (const item of db.rows('cursorDiskKV')) {
            if (
              typeof item.key === 'string'
              && item.key.startsWith(`${namespace}:${id}:`)
            ) {
              rows.push(item)
            }
          }
          rows.sort((a, b) => String(a.key).localeCompare(String(b.key), 'en'))
          for (const item of rows) {
            const native = {
              type: namespace,
              key: item.key,
              value: payload(item),
              native_row: binarySafe(item),
            }
            ingest.record(native, {
              path: ref.source.path,
              table: 'cursorDiskKV',
              key: String(item.key),
              position: ingest.eventCount(),
            })
            ingest.unknown(namespace, native)
            yield* ingest.drain()
          }
        }
      }
      yield* ingest.finish()
    }
    finally {
      await db.close()
    }
  }, 'buffered')
}
export const cursorProvider = {
  id: 'cursor',
  detect: cli.detect,
  parse: cli.parse,
  stream: cli.stream,
  open: openCursor,
  async* scan(options: ScanOptions = {}): AsyncGenerator<ScanEvent> {
    for await (const path of files(roots(options), p => /\.(?:jsonl|db|vscdb)$/.test(p), options, 'cursor')) {
      if (typeof path !== 'string') {
        yield path
        continue
      }
      if (path.endsWith('.jsonl')) {
        for await (const event of cli.scan({ ...options, roots: { cursor: [path] } })) {
          if (event.type === 'ref' && event.ref.id.startsWith('source:')) {
            yield { type: 'ref', ref: { ...event.ref, id: `source:${basename(path)}`, metadata: { id_origin: 'source_filename' } } }
          }
          else {
            yield event
          }
        }
      }
      else {
        yield* scanSource('cursor', { path, format: 'cursor_sqlite' }, options, () => scanDatabase(path, options))
      }
    }
  },
  async read(ref: SessionRef, options?: ReadOptions) {
    return (await openCursor(ref, options)).snapshot()
  },
}
