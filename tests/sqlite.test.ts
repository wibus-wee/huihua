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
for (const fixture of (await cases()).filter(c => /\.(?:db|sqlite)$/.test(c.path))) {
  void it(`${fixture.path}: rows agree with independent SQLite engine and SQL source`, async () => {
    const path = resolve('fixtures', fixture.path)
    const sqlPath = path.replace(/\.(?:db|sqlite)$/, '.sql')
    const oracle = new DatabaseSync(':memory:')
    oracle.exec(await readFile(sqlPath, 'utf8'))
    const reader = await SqliteReader.open(path)
    try {
      for (const name of reader.tables.keys()) {
        const statement = oracle.prepare(
          `SELECT * FROM "${name.replaceAll('"', '""')}"`,
        )
        statement.setReadBigInts(true)
        const expected = statement
          .all()
          .map(row =>
            Object.fromEntries(
              Object.entries(row).map(([k, v]) => [
                k,
                typeof v === 'bigint' && Number.isSafeInteger(Number(v))
                  ? Number(v)
                  : v instanceof Uint8Array
                    ? Buffer.from(v)
                    : v,
              ]),
            ))
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
  const refs = await sessions.scan({
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
    [],
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
