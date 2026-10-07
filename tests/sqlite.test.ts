import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { it } from 'node:test'

import { SessionError, sessions } from '../src/index.ts'
import { binarySafe, SqliteReader } from '../src/shared/sqlite.ts'
import { cases } from './oracle.ts'

async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'huihua-sqlite-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  return root
}

void it('preserves columns named __proto__ as evidence', async (t) => {
  const path = join(await directory(t), 'names.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE names ("__proto__" TEXT); INSERT INTO names VALUES (\'evidence\')')
  db.close()
  const reader = await SqliteReader.open(path)
  try {
    const rows = []
    for await (const row of reader.rows('names')) rows.push(row)
    assert.ok(rows[0])
    assert.equal(Object.getOwnPropertyDescriptor(rows[0], '__proto__')?.value as unknown, 'evidence')
    assert.ok(Object.hasOwn(rows[0], '__proto__'))
  }
  finally { await reader.close() }
})
function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof SessionError && error.code === code
}
void it('OpenCode reads the part table once per selected session while preserving ordered parts and orphans', async (t) => {
  const rows = t.mock.method(SqliteReader.prototype, 'rows')
  const path = join(await directory(t), 'parts.db')
  const producer = new DatabaseSync(path)
  producer.exec(await readFile(resolve('fixtures/opencode/simple.sql'), 'utf8'))
  producer.exec(`INSERT INTO message VALUES ('m2','session-1',1767225601000,'{"role":"assistant"}'), ('foreign','other',0,'{}');
    INSERT INTO part VALUES ('p2','m2','session-1',0,'{"type":"text","text":"second"}'), ('orphan','missing','session-1',0,'{}'), ('foreign','foreign','other',0,'{}');`)
  producer.close()
  const session = await sessions.parse('opencode', { path, format: 'opencode_sqlite', id: 'session-1', locator: { id: 'session-1' } })
  assert.deepEqual(session.records.filter(r => r.source.table === 'part').map(r => (r.native as { id: string }).id), ['p0', 'p2', 'orphan'])
  assert.ok(session.diagnostics.some(d => d.message.includes('orphan part')))
  assert.equal(rows.mock.calls.filter(call => call.arguments[0] === 'part').length, 1)
  assert.equal(rows.mock.calls.filter(call => call.arguments[0] === 'message').length, 1)
})
void it('scan preserves database rows yielded before an invalid session identity', async (t) => {
  const path = join(await directory(t), 'partial.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE session(id); INSERT INTO session VALUES (\'retained\'), (42), (\'unread\');')
  db.close()
  const before = await readFile(path)
  const result = await sessions.scan({ providers: ['opencode'], roots: { opencode: [path] } })
  assert.deepEqual(result.refs.map(ref => ref.id), ['retained'])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]!.code, 'UnsupportedSchema')
  assert.equal(result.failures[0]!.scope, 'source')
  assert.deepEqual(result.failures[0]!.source, { path, format: 'opencode_sqlite' })
  assert.deepEqual(await readFile(path), before)
})
void it('shared SQLite scans preserve rows before a bad identity and continue other stores', async (t) => {
  const path = join(await directory(t), 'partial.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE sessions(id); CREATE TABLE messages(id, session_id, role, content); INSERT INTO sessions VALUES (\'retained\'), (42);')
  db.close()
  const result = await sessions.scan({ providers: ['hermes'], roots: { hermes: [path, resolve('fixtures/hermes/sessions.db')] } })
  assert.ok(result.refs.some(ref => ref.id === 'retained'))
  assert.ok(result.refs.some(ref => ref.source.path === resolve('fixtures/hermes/sessions.db')))
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]!.source?.path, path)
  assert.equal(result.failures[0]!.code, 'UnsupportedSchema')
})
void it('scanStream closes database readers on early return and cancellation', async (t) => {
  const close = t.mock.method(SqliteReader.prototype, 'close')
  const options = { providers: ['opencode'], roots: { opencode: [resolve('fixtures/opencode/simple.db')] } }
  const early = sessions.scanStream(options)
  assert.equal((await early.next()).value?.type, 'ref')
  assert.equal(close.mock.callCount(), 0)
  await early.return(undefined)
  assert.equal(close.mock.callCount(), 1)
  const controller = new AbortController()
  const cancelled = sessions.scanStream({ ...options, signal: controller.signal })
  assert.equal((await cancelled.next()).value?.type, 'ref')
  const reason = new Error('stop database scan')
  controller.abort(reason)
  await assert.rejects(cancelled.next(), error => error === reason)
  assert.equal(close.mock.callCount(), 2)
})
void it('Cursor scan retains its prefix when changed-store validation fails on close', async (t) => {
  const path = join(await directory(t), 'state.vscdb')
  const db = new DatabaseSync(path)
  t.after(() => db.close())
  db.exec('CREATE TABLE cursorDiskKV(key TEXT, value TEXT); INSERT INTO cursorDiskKV VALUES (\'composerData:retained\', \'{}\');')
  const events = []
  for await (const event of sessions.scanStream({ providers: ['cursor'], roots: { cursor: [path, resolve('fixtures/cursor/simple.jsonl')] } })) {
    events.push(event)
    if (event.type === 'ref' && event.ref.source.path === path)
      db.exec('UPDATE cursorDiskKV SET value = \'{"name":"changed"}\'')
  }
  assert.equal(events.filter(event => event.type === 'ref').length, 2)
  const failures = events.flatMap(event => event.type === 'failure' ? [event.failure] : [])
  assert.equal(failures.length, 1)
  assert.equal(failures[0]!.code, 'PartialParse')
  assert.deepEqual(failures[0]!.source, { path, format: 'cursor_sqlite' })
})
function oracleRows(db: DatabaseSync, table: string) {
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
  const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => String(row.name))
  // Node 22.18's SQLite binding truncates TEXT at NUL; JSON quoting preserves it across the binding.
  const selected = columns.map((name, i) => {
    const column = quote(name)
    return `typeof(${column}) AS "type${i}", CASE WHEN typeof(${column}) = 'text' THEN json_quote(${column}) ELSE ${column} END AS "value${i}"`
  })
  const statement = db.prepare(`SELECT ${selected.join(', ')} FROM ${quote(table)}`)
  statement.setReadBigInts(true)
  return statement.all().map(row => Object.fromEntries(columns.map((name, i) => {
    const value = row[`value${i}`]
    return [name, row[`type${i}`] === 'text'
      ? JSON.parse(String(value)) as unknown
      : typeof value === 'bigint' && Number.isSafeInteger(Number(value))
        ? Number(value)
        : value instanceof Uint8Array
          ? Buffer.from(value)
          : value]
  })))
}
void it('SQLite native DDL comments cannot change columns, defaults or decoded rows', async (t) => {
  const path = join(await directory(t), 'commented.db')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE nodes (
    row_id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    node_id INTEGER NOT NULL, -- node_id within this session's forest (, GENERATED
    parent_node_id INTEGER, /* commas, quotes ' ) WITHOUT ROWID */
    chat_message TEXT,
    created_at REAL,
    "literal--/*()*/" TEXT DEFAULT 'text--/*()*/ WITHOUT ROWID GENERATED'
  ); INSERT INTO nodes VALUES (1, 'native', 7, 3, '{"role":"user"}', 1000, 'unchanged');
  ALTER TABLE nodes ADD COLUMN extra TEXT /* DEFAULT 42 */ DEFAULT 'kept--/*value*/';`)
  const expected = oracleRows(db, 'nodes')
  const columns = Object.keys(expected[0]!)
  db.close()
  const before = await readFile(path)
  const reader = await SqliteReader.open(path)
  try {
    assert.deepEqual(reader.columns('nodes'), columns)
    const rows = []
    for await (const row of reader.rows('nodes')) rows.push(row)
    assert.deepEqual(rows, expected)
  }
  finally { await reader.close() }
  assert.deepEqual(await readFile(path), before)
})
void it('SQLite oracle preserves NUL text and distinguishes blobs, integers and null', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE "quoted""table" ("__proto__" TEXT, empty TEXT, b BLOB, n INTEGER, missing TEXT)')
    db.prepare('INSERT INTO "quoted""table" VALUES (?, ?, ?, ?, ?)').run('\0json:before\0after😀', '', Buffer.from([0, 255]), 9007199254740993n, null)
    assert.deepEqual(oracleRows(db, 'quoted"table'), [{
      ['__proto__']: '\0json:before\0after😀',
      empty: '',
      b: Buffer.from([0, 255]),
      n: 9007199254740993n,
      missing: null,
    }])
  }
  finally {
    db.close()
  }
})
for (const fixture of (await cases()).filter(c => /\.(?:db|sqlite)$/.test(c.path))) {
  void it(`${fixture.path}: rows agree with independent SQLite engine and SQL source`, async () => {
    const path = resolve('fixtures', fixture.path)
    const sqlPath = path.replace(/\.(?:db|sqlite)$/, '.sql')
    const oracle = new DatabaseSync(':memory:')
    oracle.exec(await readFile(sqlPath, 'utf8'))
    const reader = await SqliteReader.open(path)
    try {
      for (const name of reader.tables.keys()) {
        const expected = oracleRows(oracle, name)
        const actual = []
        for await (const row of reader.rows(name)) actual.push(row)
        assert.deepEqual(actual, expected, name)
      }
    }
    finally {
      await reader.close()
      oracle.close()
    }
  })
}
void it('committed WAL overlays are visible, uncommitted transactions are excluded, source files unchanged', async (t) => {
  const root = await directory(t)
  const path = join(root, 'state.vscdb')
  const db = new DatabaseSync(path)
  t.after(() => {
    db.close()
  })
  db.exec(
    `PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT); INSERT INTO cursorDiskKV VALUES('composerData:wal-session','{"name":"WAL-only","fullConversationHeadersOnly":[{"bubbleId":"b"}]}'); INSERT INTO cursorDiskKV VALUES('bubbleId:wal-session:b','{"type":1,"text":"committed in WAL"}'); BEGIN; INSERT INTO cursorDiskKV VALUES('composerData:uncommitted','{}');`,
  )
  const names = await readdir(root)
  const before = new Map(
    await Promise.all(
      names.map(
        async name => [name, await readFile(join(root, name))] as const,
      ),
    ),
  )
  const { refs } = await sessions.scan({
    providers: ['cursor'],
    roots: { cursor: [path] },
  })
  assert.deepEqual(
    refs.map(r => r.id),
    ['wal-session'],
  )
  const session = await sessions.read(refs[0]!)
  assert.ok(JSON.stringify(session).includes('committed in WAL'))
  assert.deepEqual(await readdir(root), names)
  for (const [name, data] of before)
    assert.deepEqual(await readFile(join(root, name)), data)
  db.exec('ROLLBACK')
})
void it('SQLite changed-store detection and nonempty rollback journal fail explicitly', async (t) => {
  const root = await directory(t)
  const path = join(root, 's.db')
  const db = new DatabaseSync(path)
  db.exec(
    'CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT); INSERT INTO t VALUES(1,\'before\');',
  )
  const reader = await SqliteReader.open(path)
  db.exec('UPDATE t SET v=\'after\'')
  await assert.rejects(async () => reader.close(), hasCode('PartialParse'))
  db.close()
  await writeFile(`${path}-journal`, 'unresolved transaction')
  await assert.rejects(async () => SqliteReader.open(path), hasCode('PartialParse'))
})
for (const pageSize of [512, 4096, 65536]) {
  void it(`SQLite ${pageSize}-byte pages: interior trees, overflow chains, UTF-16 and 64-bit integers`, async (t) => {
    const root = await directory(t)
    const path = join(root, 's.db')
    const db = new DatabaseSync(path)
    db.exec(
      `PRAGMA page_size=${pageSize}; PRAGMA encoding='UTF-16be'; CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT,n INTEGER,b BLOB);`,
    )
    const stmt = db.prepare('INSERT INTO t VALUES(?,?,?,?)')
    const text = 'evidence😀'.repeat(300)
    db.exec('BEGIN')
    for (let i = 0; i < 100; i++)
      stmt.run(i, text, 9007199254740993n, Buffer.from([255, 0, 128]))
    db.exec('COMMIT')
    db.close()
    const reader = await SqliteReader.open(path)
    try {
      const rows = []
      for await (const row of reader.rows('t')) rows.push(row)
      assert.equal(rows.length, 100)
      assert.equal(rows[99]!.id, 99)
      assert.equal(rows[0]!.v, text)
      assert.equal(rows[0]!.n, 9007199254740993n)
      assert.deepEqual(rows[0]!.b, Buffer.from([255, 0, 128]))
      assert.deepEqual(binarySafe(rows[0]!.n), {
        native_integer: '9007199254740993',
      })
    }
    finally {
      await reader.close()
    }
  })
}
void it('unsupported table structures and record limits never produce a silent empty history', async (t) => {
  const root = await directory(t)
  const path = join(root, 's.db')
  const db = new DatabaseSync(path)
  db.exec(
    `CREATE TABLE t(id TEXT PRIMARY KEY,v TEXT) WITHOUT ROWID; INSERT INTO t VALUES('s','data'); CREATE TABLE big(id INTEGER PRIMARY KEY,v TEXT); INSERT INTO big VALUES(1,'${
      'x'.repeat(3000)
    }');`,
  )
  db.close()
  const reader = await SqliteReader.open(path, { maxRecordBytes: 1024 })
  try {
    await assert.rejects(async () => {
      for await (const row of reader.rows('t')) void row
    }, hasCode('UnsupportedSchema'))
    await assert.rejects(async () => {
      for await (const row of reader.rows('big')) void row
    }, hasCode('CorruptedSession'))
  }
  finally {
    await reader.close()
  }
})
void it('empty databases are empty and invalid headers are reported', async (t) => {
  const root = await directory(t)
  const path = join(root, 's.db')
  const db = new DatabaseSync(path)
  db.exec('PRAGMA user_version=1')
  db.close()
  assert.deepEqual(
    await sessions.scan({
      providers: ['cursor', 'opencode'],
      roots: { cursor: [path], opencode: [path] },
    }),
    { refs: [], failures: [] },
  )
  await writeFile(path, Buffer.alloc(100))
  await assert.rejects(
    async () => SqliteReader.open(path),
    hasCode('UnsupportedSchema'),
  )
})

void it('added columns retain native defaults in pre-migration rows', async (t) => {
  const root = await directory(t)
  const path = join(root, 'defaults.db')
  const db = new DatabaseSync(path)
  db.exec(
    'CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO t VALUES(1,\'old\'); ALTER TABLE t ADD COLUMN count INTEGER DEFAULT 7; ALTER TABLE t ADD COLUMN label TEXT DEFAULT \'native\';',
  )
  const expected = db
    .prepare('SELECT * FROM t')
    .all()
    .map(row => ({ ...row }))
  db.close()
  const reader = await SqliteReader.open(path)
  try {
    const actual = []
    for await (const row of reader.rows('t')) actual.push(row)
    assert.deepEqual(actual, expected)
  }
  finally {
    await reader.close()
  }
})
