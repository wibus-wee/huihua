import { Buffer } from 'node:buffer'
import type { FileHandle } from 'node:fs/promises'
import { open, stat } from 'node:fs/promises'

import { SessionError } from '../contracts/diagnostic.ts'
import type { ReadOptions } from '../contracts/provider.ts'
import { ioError, positiveLimit } from './paths.ts'

export type Row = Record<string, unknown>
interface Table {
  root: number
  columns: string[]
  defaults: ({ value: unknown } | { unsupported: string })[]
  integerKey?: number
  unsupported?: string
}
async function fingerprint(path: string): Promise<string> {
  try {
    const s = await stat(path, { bigint: true })
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return 'absent'
    ioError(error, path)
  }
}
function fail(message: string): never {
  throw new SessionError('DatabaseError', message)
}
function varint(data: Buffer, offset: number): [bigint, number] {
  let value = 0n
  for (let i = 0; i < 9; i++) {
    const b = data[offset + i]
    if (b === undefined)
      fail('truncated SQLite varint')
    value = (value << BigInt(i === 8 ? 8 : 7)) | BigInt(i === 8 ? b : b & 127)
    if (b < 128 || i === 8)
      return [value, offset + i + 1]
  }
  return fail('invalid SQLite varint')
}
function safe(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER)
    && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value
}
function unsigned(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    fail('oversized SQLite value')
  return Number(value)
}
function definitions(sql: string): string[] {
  const start = sql.indexOf('(')
  const end = sql.lastIndexOf(')')
  if (start < 0 || end < start)
    fail('invalid SQLite table definition')
  const out: string[] = []
  let begin = start + 1
  let depth = 0
  let quote = ''
  for (let i = begin; i < end; i++) {
    const c = sql[i]!
    if (quote) {
      if (c === quote) {
        if (sql[i + 1] === quote)
          i++
        else quote = ''
      }
      continue
    }
    if (c === '"' || c === '\'' || c === '`' || c === '[') {
      quote = c === '[' ? ']' : c
    }
    else if (c === '(') {
      depth++
    }
    else if (c === ')') {
      depth--
    }
    else if (c === ',' && depth === 0) {
      out.push(sql.slice(begin, i).trim())
      begin = i + 1
    }
  }
  out.push(sql.slice(begin, end).trim())
  return out
}
function columnDefault(
  definition: string,
): { value: unknown } | { unsupported: string } {
  let depth = 0
  let quote = ''
  let tail: string | undefined
  for (let i = 0; i < definition.length; i++) {
    const c = definition[i]!
    if (quote) {
      if (c === quote) {
        if (definition[i + 1] === quote)
          i++
        else quote = ''
      }
      continue
    }
    if (c === '\'' || c === '"' || c === '`' || c === '[') {
      quote = c === '[' ? ']' : c
    }
    else if (c === '(') {
      depth++
    }
    else if (c === ')') {
      depth--
    }
    else if (
      depth === 0
      && /^DEFAULT\b/i.test(definition.slice(i))
      && (i === 0 || /\s/.test(definition[i - 1]!))
    ) {
      tail = definition.slice(i + 7).trim()
      break
    }
  }
  if (tail === undefined)
    return { value: null }
  const literal
    = /^(?:'((?:''|[^'])*)'|"((?:""|[^"])*)"|x'([\da-f]*)'|(NULL|TRUE|FALSE)\b|([+-]?(?:0x[\da-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?))(?=\s|$))/i.exec(
      tail,
    )
  if (!literal)
    return { unsupported: 'nonliteral default for an absent SQLite column' }
  let value: unknown
  if (literal[1] !== undefined) {
    value = literal[1].replaceAll('\'\'', '\'')
  }
  else if (literal[2] !== undefined) {
    value = literal[2].replaceAll('""', '"')
  }
  else if (literal[3] !== undefined) {
    if (literal[3].length % 2)
      return { unsupported: 'invalid blob default' }
    value = Buffer.from(literal[3], 'hex')
  }
  else if (literal[4] !== undefined) {
    value
      = literal[4].toUpperCase() === 'NULL'
        ? null
        : literal[4].toUpperCase() === 'TRUE'
          ? 1
          : 0
  }
  else {
    const lexeme = literal[5]!
    value = /^[+-]?\d+$|^0x[\da-f]+$/i.test(lexeme)
      ? safe(BigInt(lexeme))
      : Number(lexeme)
  }
  const declared = definition.split(
    /\b(?:PRIMARY|NOT|UNIQUE|CHECK|DEFAULT|COLLATE|REFERENCES|GENERATED|AS)\b/i,
  )[0]!
  if (
    /CHAR|CLOB|TEXT/i.test(declared)
    && (typeof value === 'number' || typeof value === 'bigint')
  ) {
    value = String(value)
  }
  else if (
    !/BLOB/i.test(declared)
    && declared.trim()
    && typeof value === 'string'
    && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
  ) {
    value = /^[+-]?\d+$/.test(value.trim())
      ? safe(BigInt(value.trim()))
      : Number(value)
  }
  return { value }
}
/** Read a single SQLite identifier without a backtracking regex over persisted SQL. */
function columnDefinition(part: string): { name: string, rest: string } {
  const first = part[0]!
  const close = first === '[' ? ']' : first
  if (['"', '\'', '`', '['].includes(first)) {
    let name = ''
    for (let i = 1; i < part.length; i++) {
      const c = part[i]!
      if (c === close) {
        if (first !== '[' && part[i + 1] === close) {
          name += close
          i++
        }
        else {
          return { name, rest: part.slice(i + 1).trimStart() }
        }
      }
      else {
        name += c
      }
    }
    fail('unterminated SQLite column identifier')
  }
  const name = /^\S+/.exec(part)?.[0]
  if (name === undefined)
    fail('missing SQLite column identifier')
  return { name, rest: part.slice(name.length).trimStart() }
}
function schema(sql: string, root: number): Table {
  const columns: string[] = []
  const defaults: ({ value: unknown } | { unsupported: string })[] = []
  let integerKey: number | undefined
  const parts = definitions(sql)
  for (const part of parts) {
    if (/^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(part))
      continue
    const { name, rest } = columnDefinition(part)
    if (/^INTEGER\s+PRIMARY\s+KEY(?!\s+DESC)/i.test(rest))
      integerKey = columns.length
    columns.push(name)
    defaults.push(columnDefault(rest))
  }
  // A table-level single INTEGER PRIMARY KEY is also a rowid alias.
  for (const part of parts) {
    const match = /^PRIMARY\s+KEY\s*\(\s*["`[]?(\w+)["`\]]?\s*\)$/i.exec(
      part,
    )
    if (match) {
      const index = columns.indexOf(match[1]!)
      const definition = parts.find(p => p.startsWith(match[1]!))
      if (index >= 0 && definition !== undefined && /^\S+\s+INTEGER\b/i.test(definition))
        integerKey = index
    }
  }
  return {
    root,
    columns,
    defaults,
    ...(integerKey === undefined ? {} : { integerKey }),
    ...(/WITHOUT\s+ROWID|\bVIRTUAL\b|\bGENERATED\b|\bAS\s*\(/i.test(sql)
      ? { unsupported: 'virtual, generated-column or WITHOUT ROWID table' }
      : {}),
  }
}
/** Read-only rowid-table reader. No SQL execution, source writes, migrations or database index. */
export class SqliteReader {
  readonly tables = new Map<string, Table>()
  readonly #db: FileHandle
  #wal: FileHandle | undefined
  readonly #path: string
  readonly #options: ReadOptions
  #fingerprints: string[] = []
  #pageSize = 0
  #usable = 0
  #pages = 0
  #encoding = 1
  #overlay = new Map<number, number>()
  #cache = new Map<number, Buffer>()
  #closed = false
  private constructor(db: FileHandle, path: string, options: ReadOptions) {
    this.#db = db
    this.#path = path
    this.#options = options
  }

  static async open(
    path: string,
    options: ReadOptions = {},
  ): Promise<SqliteReader> {
    options.signal?.throwIfAborted()
    let reader: SqliteReader
    try {
      reader = new SqliteReader(await open(path, 'r'), path, options)
    }
    catch (error) {
      ioError(error, path)
    }
    try {
      await reader.#initialize()
      return reader
    }
    catch (error) {
      await reader.close(false)
      if (error instanceof SessionError)
        throw error
      throw new SessionError('DatabaseError', `${path}: ${String(error)}`, {
        cause: error,
      })
    }
  }

  async #read(file: FileHandle, offset: number, size: number): Promise<Buffer> {
    this.#options.signal?.throwIfAborted()
    const data = Buffer.alloc(size)
    let done = 0
    while (done < size) {
      const { bytesRead } = await file.read(
        data,
        done,
        size - done,
        offset + done,
      )
      if (!bytesRead)
        fail('truncated SQLite page')
      done += bytesRead
    }
    return data
  }

  async #initialize(): Promise<void> {
    const paths = [this.#path, `${this.#path}-wal`, `${this.#path}-journal`]
    this.#fingerprints = await Promise.all(paths.map(fingerprint))
    if (this.#fingerprints[2] !== 'absent' && (await stat(paths[2]!)).size > 0) {
      throw new SessionError(
        'PartialParse',
        'nonempty SQLite rollback journal; read a quiescent backup',
      )
    }
    const size = (await this.#db.stat()).size
    if (size === 0 && this.#fingerprints[1] === 'absent')
      return
    const head = await this.#read(this.#db, 0, 100)
    if (head.toString('ascii', 0, 16) !== 'SQLite format 3\0') {
      throw new SessionError(
        'UnsupportedSchema',
        'not an unencrypted SQLite 3 database',
      )
    }
    const ps = head.readUInt16BE(16)
    this.#pageSize = ps === 1 ? 65536 : ps
    if (
      this.#pageSize < 512
      || this.#pageSize > 65536
      || (this.#pageSize & (this.#pageSize - 1)) !== 0
    ) {
      fail('invalid SQLite page size')
    }
    if (head[19]! > 2) {
      throw new SessionError(
        'UnsupportedSchema',
        'unsupported SQLite read version',
      )
    }
    this.#usable = this.#pageSize - head[20]!
    if (this.#usable < 480)
      fail('invalid usable page size')
    if (size % this.#pageSize !== 0)
      fail('truncated SQLite database')
    this.#pages = size / this.#pageSize
    if (this.#fingerprints[1] !== 'absent') {
      this.#wal = await open(paths[1]!, 'r')
      await this.#loadWal()
    }
    const effective = await this.#page(1)
    this.#encoding = effective.readUInt32BE(56) || 1
    if (![1, 2, 3].includes(this.#encoding))
      fail('unsupported SQLite text encoding')
    for await (const record of this.#tree(1)) {
      const values = this.#decode(record.payload)
      if (
        values[0] === 'table'
        && typeof values[1] === 'string'
        && typeof values[3] === 'number'
        && typeof values[4] === 'string'
      ) {
        this.tables.set(values[1], schema(values[4], values[3]))
      }
    }
  }

  async #loadWal(): Promise<void> {
    const file = this.#wal!
    const size = (await file.stat()).size
    if (size === 0)
      return
    if (size < 32)
      throw new SessionError('PartialParse', 'incomplete SQLite WAL header')
    const head = await this.#read(file, 0, 32)
    const magic = head.readUInt32BE(0)
    if (
      (magic !== 0x377F0682 && magic !== 0x377F0683)
      || head.readUInt32BE(4) !== 3007000
      || head.readUInt32BE(8) !== this.#pageSize
    ) {
      fail('unsupported SQLite WAL header')
    }
    const little = magic === 0x377F0682
    let s0 = 0
    let s1 = 0
    const checksum = (data: Buffer): void => {
      for (let i = 0; i < data.length; i += 8) {
        const a = little ? data.readUInt32LE(i) : data.readUInt32BE(i)
        const b = little ? data.readUInt32LE(i + 4) : data.readUInt32BE(i + 4)
        s0 = (s0 + a + s1) >>> 0
        s1 = (s1 + b + s0) >>> 0
      }
    }
    checksum(head.subarray(0, 24))
    if (s0 !== head.readUInt32BE(24) || s1 !== head.readUInt32BE(28))
      fail('SQLite WAL header checksum mismatch')
    const pending = new Map<number, number>()
    for (
      let offset = 32;
      offset + 24 + this.#pageSize <= size;
      offset += 24 + this.#pageSize
    ) {
      const frame = await this.#read(file, offset, 24 + this.#pageSize)
      if (!frame.subarray(8, 16).equals(head.subarray(16, 24)))
        break // Stale frames after a WAL reset are not part of this transaction.
      checksum(frame.subarray(0, 8))
      checksum(frame.subarray(24))
      if (s0 !== frame.readUInt32BE(16) || s1 !== frame.readUInt32BE(20))
        break // Stop at the first incomplete/invalid transaction.
      const page = frame.readUInt32BE(0)
      if (page === 0)
        fail('invalid WAL page number')
      pending.set(page, offset + 24)
      const commitSize = frame.readUInt32BE(4)
      if (commitSize) {
        for (const [key, value] of pending) this.#overlay.set(key, value)
        pending.clear()
        this.#pages = commitSize
      }
    }
    for (const page of this.#overlay.keys()) {
      if (page > this.#pages)
        this.#overlay.delete(page)
    }
  }

  async #page(number: number): Promise<Buffer> {
    this.#options.signal?.throwIfAborted()
    if (!Number.isSafeInteger(number) || number <= 0 || number > this.#pages)
      fail('SQLite page out of bounds')
    const cached = this.#cache.get(number)
    if (cached)
      return cached
    const offset = this.#overlay.get(number)
    const page = await this.#read(
      offset === undefined ? this.#db : this.#wal!,
      offset ?? (number - 1) * this.#pageSize,
      this.#pageSize,
    )
    if (
      this.#cache.size
      >= Math.max(1, Math.floor((1024 * 1024) / this.#pageSize))
    ) {
      this.#cache.delete(this.#cache.keys().next().value!)
    }
    this.#cache.set(number, page)
    return page
  }

  async* #tree(
    root: number,
    visited = new Set<number>(),
    depth = 0,
  ): AsyncGenerator<{ rowid: number | bigint, payload: Buffer }> {
    if (visited.has(root) || depth > 64)
      fail('cyclic or excessive SQLite btree')
    visited.add(root)
    const page = await this.#page(root)
    const h = root === 1 ? 100 : 0
    const kind = page[h]
    if (kind !== 5 && kind !== 13) {
      throw new SessionError(
        'UnsupportedSchema',
        'expected SQLite rowid table btree',
      )
    }
    const count = page.readUInt16BE(h + 3)
    const interior = kind === 5
    const pointerStart = h + (interior ? 12 : 8)
    if (pointerStart + count * 2 > this.#usable)
      fail('invalid btree cell count')
    for (let i = 0; i < count; i++) {
      this.#options.signal?.throwIfAborted()
      let cell = page.readUInt16BE(pointerStart + i * 2)
      if (cell < pointerStart + count * 2 || cell >= this.#usable)
        fail('invalid btree cell pointer')
      if (interior) {
        yield* this.#tree(page.readUInt32BE(cell), visited, depth + 1)
        continue
      }
      const [length, next] = varint(page, cell)
      cell = next
      const [id, body] = varint(page, cell)
      const total = unsigned(length)
      if (total > positiveLimit(this.#options.maxRecordBytes, 16 * 1024 * 1024)) {
        throw new SessionError(
          'CorruptedSession',
          'SQLite record exceeds maxRecordBytes',
        )
      }
      const maxLocal = this.#usable - 35
      const minLocal = Math.floor(((this.#usable - 12) * 32) / 255) - 23
      let local = total
      if (total > maxLocal) {
        local = minLocal + ((total - minLocal) % (this.#usable - 4))
        if (local > maxLocal)
          local = minLocal
      }
      if (body + local + (local < total ? 4 : 0) > this.#usable)
        fail('truncated btree payload')
      const parts = [page.subarray(body, body + local)]
      let remaining = total - local
      if (remaining) {
        let overflow = page.readUInt32BE(body + local)
        const seen = new Set<number>()
        while (remaining) {
          if (seen.has(overflow))
            fail('cyclic SQLite overflow chain')
          seen.add(overflow)
          const data = await this.#page(overflow)
          overflow = data.readUInt32BE(0)
          const take = Math.min(remaining, this.#usable - 4)
          parts.push(data.subarray(4, 4 + take))
          remaining -= take
        }
        if (overflow)
          fail('excess SQLite overflow chain')
      }
      yield {
        rowid: safe(BigInt.asIntN(64, id)),
        payload: Buffer.concat(parts, total),
      }
    }
    if (interior)
      yield* this.#tree(page.readUInt32BE(h + 8), visited, depth + 1)
  }

  #decode(payload: Buffer): unknown[] {
    const [headerLength, start] = varint(payload, 0)
    const end = unsigned(headerLength)
    if (end > payload.length || end < start)
      fail('invalid SQLite record header')
    const types: number[] = []
    for (let cursor = start; cursor < end;) {
      const [type, next] = varint(payload, cursor)
      if (next > end)
        fail('invalid serial type')
      types.push(unsigned(type))
      cursor = next
    }
    const values: unknown[] = []
    let cursor = end
    for (const type of types) {
      const length
        = type <= 4
          ? type
          : type === 5
            ? 6
            : type === 6 || type === 7
              ? 8
              : type < 12
                ? 0
                : Math.floor((type - 12) / 2)
      if (cursor + length > payload.length)
        fail('truncated SQLite record value')
      const data = payload.subarray(cursor, cursor + length)
      cursor += length
      if (type === 0) {
        values.push(null)
      }
      else if (type <= 6) {
        let integer = 0n
        for (const b of data) integer = (integer << 8n) | BigInt(b)
        if (data[0]! & 128)
          integer -= 1n << BigInt(length * 8)
        values.push(safe(integer))
      }
      else if (type === 7) {
        values.push(data.readDoubleBE(0))
      }
      else if (type === 8 || type === 9) {
        values.push(type - 8)
      }
      else if (type === 10 || type === 11) {
        fail('reserved SQLite serial type')
      }
      else if (type % 2 === 0) {
        values.push(Buffer.from(data))
      }
      else {
        const encoding
          = this.#encoding === 1
            ? 'utf-8'
            : this.#encoding === 2
              ? 'utf-16le'
              : 'utf-16be'
        try {
          values.push(new TextDecoder(encoding, { fatal: true }).decode(data))
        }
        catch {
          values.push(Buffer.from(data))
        }
      }
    }
    return values
  }

  columns(table: string): readonly string[] {
    return this.tables.get(table)?.columns ?? []
  }

  async* rows(name: string): AsyncGenerator<Row> {
    const table = this.tables.get(name)
    if (!table)
      return
    if (table.unsupported !== undefined || !table.root) {
      throw new SessionError(
        'UnsupportedSchema',
        `${name}: ${table.unsupported ?? 'table has no btree'}`,
      )
    }
    for await (const record of this.#tree(table.root)) {
      const values = this.#decode(record.payload)
      const row: Row = {}
      for (let i = 0; i < table.columns.length; i++) {
        let value = values[i]
        if (i >= values.length) {
          const fallback = table.defaults[i]!
          if ('unsupported' in fallback)
            throw new SessionError('UnsupportedSchema', fallback.unsupported)
          value = fallback.value
        }
        Object.defineProperty(row, table.columns[i]!, {
          value: i === table.integerKey && value === null ? record.rowid : value,
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }
      yield row
    }
  }

  async close(verify = true): Promise<void> {
    if (this.#closed)
      return
    this.#closed = true
    try {
      if (verify) {
        const now = await Promise.all(
          [this.#path, `${this.#path}-wal`, `${this.#path}-journal`].map(
            fingerprint,
          ),
        )
        if (now.some((value, i) => value !== this.#fingerprints[i])) {
          throw new SessionError(
            'PartialParse',
            'SQLite store changed during reading; retry a quiescent source',
          )
        }
      }
    }
    finally {
      await Promise.all([this.#db.close(), this.#wal?.close()])
      this.#cache.clear()
    }
  }
}
export function binarySafe(value: unknown): unknown {
  if (Buffer.isBuffer(value))
    return { native_bytes: [...value] }
  if (typeof value === 'bigint')
    return { native_integer: value.toString() }
  if (Array.isArray(value))
    return value.map(binarySafe)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, binarySafe(item)]),
    )
  }
  return value
}
export function decodeValue(value: unknown): {
  native: unknown
  text?: string
  bytes?: readonly number[]
  malformed?: boolean
} {
  if (typeof value !== 'string' && !Buffer.isBuffer(value))
    return { native: binarySafe(value) }
  let text: string
  try {
    text
      = typeof value === 'string'
        ? value
        : new TextDecoder('utf8', { fatal: true }).decode(value)
  }
  catch {
    return {
      native: { native_bytes: [...(value as Buffer)] },
      bytes: [...(value as Buffer)],
      malformed: true,
    }
  }
  try {
    return { native: JSON.parse(text) as unknown, text }
  }
  catch {
    return { native: text, text, malformed: true }
  }
}
