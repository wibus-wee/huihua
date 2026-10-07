import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { SessionError } from '../../contracts/diagnostic.ts'
import type { ReadOptions, ScanEvent, ScanOptions } from '../../contracts/provider.ts'
import type { SessionRef } from '../../contracts/session.ts'
import {
  Ingestion,
  jsonlProvider,
  messageEvents,
  openFrom,
} from '../../shared/ingestion.ts'
import { canonicalPath, files, pathMatcher } from '../../shared/paths.ts'
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
import { openPersisted, persistedIdentity, persistedSidecar } from './persisted.ts'

function roots(options: ScanOptions): readonly string[] {
  const home = options.homeDir ?? homedir()
  return (
    options.roots?.cursor ?? [
      ...['Library/Application Support', '.config', 'AppData/Roaming']
        .flatMap(base => ['globalStorage', 'workspaceStorage'].map(store => join(home, base, 'Cursor/User', store))),
      join(home, '.cursor/projects'),
      join(home, '.cursor/chats'),
      join(home, '.cursor/acp-sessions'),
    ]
  )
}
const transcriptPath = pathMatcher('**/agent-transcripts/**/*.jsonl')
const ideDatabasePath = pathMatcher('**/{globalStorage,workspaceStorage}/**/state.vscdb')
const cli = jsonlProvider({
  id: 'cursor',
  roots,
  accepts: (path, candidate) => path.endsWith('.jsonl') && (candidate.explicitFile || transcriptPath(path)),
  identify({ header, explicitFile }) {
    return explicitFile || header.some((native) => {
      const v = object(native)
      return (['user', 'assistant'].includes(String(v.role)) && 'content' in object(v.message))
        || (v.type === 'turn_ended' && v.status === 'error' && typeof v.error === 'string' && v.error !== '')
    })
      ? {}
      : false
  },
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
    if ((role === 'user' || role === 'assistant') && 'content' in message) {
      for (const part of Array.isArray(message.content) ? message.content : [message.content]) {
        const block = object(part)
        const type = string(block.type)
        if (['tool_use', 'tool-use', 'tool_call', 'tool-call'].includes(type ?? '') && typeof (block.name ?? block.tool) === 'string')
          ingest.emit('tool_call', { ...optional('callId', string(block.id) ?? string(block.call_id)), toolName: String(block.name ?? block.tool), arguments: block.input ?? block.arguments ?? null })
        else if (type === 'tool_result' || type === 'tool-result')
          ingest.emit('tool_result', { ...optional('callId', string(block.tool_use_id) ?? string(block.tool_call_id)), ...optional('toolName', string(block.name)), result: block.content ?? null, isError: block.is_error === true })
        else
          messageEvents(ingest, role, part)
      }
    }
    else if ((role === undefined || role === '') && v.type === 'turn_ended' && v.status === 'error' && error !== undefined && error !== '') {
      ingest.emit('error', { message: error, details: native })
    }
    else {
      ingest.unknown(string(v.type) ?? 'untyped', native)
    }
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
  storage?: 'chat' | 'acp',
): AsyncGenerator<ScanEvent> {
  const db = await SqliteReader.open(path, {
    ...optional('signal', options.signal),
    maxRecordBytes: options.headerBytes ?? 65536,
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
    if (storage !== undefined || (basename(path) === 'store.db' && db.tables.has('meta'))) {
      const kind = storage ?? 'chat'
      const limits = { ...optional('signal', options.signal), maxRecordBytes: options.headerBytes ?? 65536 }
      let sidecar
      if (kind === 'acp') {
        const companion = join(dirname(path), 'meta.json')
        let failed = false
        for await (const event of scanSource('cursor', { path: companion }, options, async function* () {
          sidecar = await persistedSidecar(companion, limits)
        })) {
          failed = true
          yield event
        }
        if (failed || sidecar === undefined)
          return
      }
      const identity = await persistedIdentity(db, path, kind, limits, sidecar)
      if (identity) {
        yield { type: 'ref', ref: {
          ...identity.facts,
          provider: 'cursor',
          source: { path, format: 'cursor_sqlite', locator: { id: identity.facts.id, storage: kind } },
        } }
      }
      return
    }
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
  if (storage === 'chat' || storage === 'acp')
    return openPersisted(ref, storage, options)
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
    const explicit = new Set(options.roots?.cursor?.map(path => resolve(path)))
    const jsonRoots = options.roots?.cursor ?? [join(options.homeDir ?? homedir(), '.cursor/projects')]
    for await (const event of cli.scan({ ...options, roots: { cursor: jsonRoots } })) {
      if (event.type === 'ref' && event.ref.id.startsWith('source:')) {
        yield { type: 'ref', ref: { ...event.ref, id: `source:${basename(event.ref.source.path)}`, metadata: { ...event.ref.metadata, id_origin: 'source_filename' } } }
      }
      else {
        yield event
      }
    }
    function persistedFamily(path: string): 'chat' | 'acp' | undefined {
      if (basename(path) !== 'store.db' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(basename(dirname(path))))
        return
      const parent = dirname(dirname(path))
      const family = basename(parent) === 'acp-sessions' ? 'acp' : basename(dirname(parent)) === 'chats' ? 'chat' : undefined
      if (family === undefined)
        return
      const name = family === 'acp' ? 'acp-sessions' : 'chats'
      const storeRoot = family === 'acp' ? parent : dirname(parent)
      const authorities = roots(options).filter(root => basename(root) === name).map(root => resolve(root))
      if (authorities.length === 0 || authorities.includes(storeRoot))
        return family
    }
    function accepts(path: string): boolean {
      if (explicit.has(path))
        return /\.(?:db|vscdb)$/.test(path)
      return persistedFamily(path) !== undefined
        || ideDatabasePath(path)
    }
    const databaseRoots = options.roots?.cursor ?? roots(options).filter(root => basename(root) !== 'projects')
    const admittedRoots: string[] = []
    for (const root of databaseRoots) {
      yield* scanSource('cursor', { path: root }, options, async function* () {
        if (basename(root) !== 'acp-sessions' || await canonicalPath(root))
          admittedRoots.push(root)
      })
    }
    for await (const path of files(admittedRoots, accepts, options, 'cursor')) {
      if (typeof path !== 'string') {
        yield path
        continue
      }
      yield* scanSource('cursor', { path, format: 'cursor_sqlite' }, options, () => scanDatabase(path, options, persistedFamily(path)))
    }
  },
  async read(ref: SessionRef, options?: ReadOptions) {
    return (await openCursor(ref, options)).snapshot()
  },
}
