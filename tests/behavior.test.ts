import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs, { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os, { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { it } from 'node:test'

import type { ScanEvent, Session, SessionEvent, SessionRef } from '../src/index.ts'
import {
  createSessionRegistry,
  defineProvider,
  jsonOf,
  SESSION_SCHEMA,
  SessionError,
  sessions,
} from '../src/index.ts'
import {
  conversationOf,
  eventsOf,
  fileChangesOf,
  subagentsOf,
  toolCallsOf,
  toolResultsOf,
} from '../src/observe/index.ts'
import { jsonlProvider } from '../src/shared/ingestion.ts'
import { files, pathMatcher } from '../src/shared/paths.ts'
import { scanSource } from '../src/shared/scan.ts'
import { assertSessionContract } from '../src/testing/index.ts'

async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'huihua-test-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  return root
}
async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}
void it('provider path globs preserve hidden directories, literal roots and native containment', () => {
  const root = resolve('test-[literal]')
  const matches = pathMatcher(['*/chats/*.jsonl', '*/chats/archive/*.jsonl'])
  assert.equal(matches(join(root, '.project/chats/id.jsonl'), root), true)
  assert.equal(matches(join(root, 'project/chats/archive/id.jsonl'), root), true)
  assert.equal(matches(join(root, 'project/backup/chats/id.jsonl'), root), false)
  assert.equal(matches(join(root, '../other/project/chats/id.jsonl'), root), false)
  assert.equal(matches(join(`${root}-sibling`, 'project/chats/id.jsonl'), root), false)
  const transcripts = pathMatcher('**/agent-transcripts/**/*.jsonl')
  assert.equal(transcripts(join(root, '.cursor/projects/.project/agent-transcripts/id/id.jsonl')), true)
  assert.equal(transcripts(join(root, '.cursor/projects/not-agent-transcripts/id.jsonl')), false)
  if (process.platform !== 'win32')
    assert.equal(transcripts(join(root, 'agent-transcripts\\id.jsonl')), false)
})
void it('Qwen directory discovery certifies exact chat layout and the first complete record identity', async (t) => {
  const root = await directory(t)
  const projects = join(root, '.qwen/projects')
  const id = '11111111-1111-1111-1111-111111111111'
  const record = `${JSON.stringify({ type: 'user', sessionId: id, message: { parts: [{ text: 'hello' }] } })}\n`
  for (const relative of [`p/chats/${id}.jsonl`, `p/chats/archive/${id}.jsonl`, `p/backup/chats/${id}.jsonl`, `p/debug.jsonl`, `p/subagents/${id}.jsonl`, 'p/chats/not-an-id.jsonl'])
    await put(join(projects, relative), record)
  const bad = '22222222-2222-2222-2222-222222222222'
  for (const prefix of [record, '{}\n', 'broken\n'])
    await put(join(projects, `bad-${prefix.length}/chats/${bad}.jsonl`), `${prefix}${JSON.stringify({ sessionId: bad })}\n`)
  const result = await sessions.scan({ providers: ['qwen'], homeDir: root })
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.refs.map(ref => ref.source.path).sort(), [join(projects, `p/chats/${id}.jsonl`), join(projects, `p/chats/archive/${id}.jsonl`)].sort())
  assert.ok(result.refs.every(ref => ref.id === id))
  assert.deepEqual(await sessions.scan({ providers: ['qwen'], homeDir: root, headerBytes: 10 }), { refs: [], failures: [] })
  assert.equal((await sessions.parse('qwen', { jsonl: record })).id, id)
  // A directly supplied backup remains a supported acquisition surface.
  assert.equal((await sessions.scan({ providers: ['qwen'], roots: { qwen: [resolve('fixtures/qwen/session.jsonl')] } })).refs.length, 1)
  await put(join(projects, `p/chats/${id}.jsonl`), `${record}{"sessionId":"later-conflict"}\n`)
  const ref = (await sessions.scan({ providers: ['qwen'], homeDir: root })).refs.find(ref => ref.source.path === join(projects, `p/chats/${id}.jsonl`))!
  assert.equal(ref.id, id)
  const parsed = await sessions.read(ref)
  assert.equal(parsed.id, id)
  assert.ok(parsed.diagnostics.some(diagnostic => diagnostic.message.includes('conflicting native')))
})
void it('Qwen falls back only when QWEN_HOME/projects is not a directory', async (t) => {
  const root = await directory(t)
  const id = '11111111-1111-1111-1111-111111111111'
  await put(join(root, `.qwen/projects/p/chats/${id}.jsonl`), `${JSON.stringify({ sessionId: id })}\n`)
  const original = process.env.QWEN_HOME
  process.env.QWEN_HOME = join(root, 'custom')
  t.mock.method(os, 'homedir', () => root)
  syncBuiltinESMExports()
  t.after(() => {
    if (original === undefined)
      delete process.env.QWEN_HOME
    else process.env.QWEN_HOME = original
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  assert.equal((await sessions.scan({ providers: ['qwen'] })).refs.length, 1)
  assert.deepEqual((await sessions.require('qwen').detect()).roots, [join(root, '.qwen/projects')])
  await put(join(root, 'custom/projects'), 'not a directory')
  assert.equal((await sessions.scan({ providers: ['qwen'] })).refs.length, 1)
  await rm(join(root, 'custom/projects'))
  await mkdir(join(root, 'custom/projects'))
  assert.equal((await sessions.scan({ providers: ['qwen'] })).refs.length, 0)
  assert.equal((await sessions.scan({ providers: ['qwen'], homeDir: root })).refs.length, 1)
  assert.deepEqual(await sessions.scan({ providers: ['qwen'], roots: { qwen: [] } }), { refs: [], failures: [] })
})
void it('Claude finds sibling configurations and Desktop transcripts without admitting Desktop journals', async (t) => {
  const root = await directory(t)
  const paths = ['.claude/projects/p/a.jsonl', '.claude-work/projects/p/b.jsonl', '.config/claude/projects/p/c.jsonl', 'Library/Application Support/Claude/local-agent-mode-sessions/account/task/local_1/.claude/projects/p/d.jsonl']
  for (const [i, path] of paths.entries())
    await put(join(root, path), `${JSON.stringify({ type: 'user', sessionId: String(i), message: { content: 'hello' } })}\n`)
  await put(join(root, 'Library/Application Support/Claude/local-agent-mode-sessions/account/task/journal.jsonl'), '{}\n')
  const result = await sessions.scan({ providers: ['claude'], homeDir: root })
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.refs.map(ref => ref.id).sort(), ['0', '1', '2', '3'])
})
void it('Claude combines CLAUDE_CONFIG_DIRS, single config and defaults and respects explicit overrides', async (t) => {
  const root = await directory(t)
  const keys = ['CLAUDE_CONFIG_DIRS', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME'] as const
  const previous = keys.map(key => process.env[key])
  process.env.CLAUDE_CONFIG_DIRS = [join(root, 'one'), join(root, 'two/projects')].join(process.platform === 'win32' ? ';' : ':')
  process.env.CLAUDE_CONFIG_DIR = join(root, 'single')
  process.env.XDG_CONFIG_HOME = join(root, 'xdg')
  t.mock.method(os, 'homedir', () => root)
  syncBuiltinESMExports()
  t.after(() => {
    for (const [i, key] of keys.entries()) {
      if (previous[i] === undefined)
        delete process.env[key]
      else process.env[key] = previous[i]
    }
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  for (const [i, path] of ['one/projects', 'two/projects', 'single/projects', '.claude/projects', 'xdg/claude/projects'].entries())
    await put(join(root, path, 'p/s.jsonl'), `${JSON.stringify({ type: 'system', sessionId: String(i) })}\n`)
  assert.deepEqual((await sessions.scan({ providers: ['claude'] })).refs.map(ref => ref.id).sort(), ['0', '1', '2', '3', '4'])
  assert.deepEqual((await sessions.scan({ providers: ['claude'], homeDir: root })).refs.map(ref => ref.id), ['3'])
  assert.deepEqual(await sessions.scan({ providers: ['claude'], roots: { claude: [] } }), { refs: [], failures: [] })
})
void it('Claude reports denied sibling discovery while retaining independently readable stores', async (t) => {
  const root = await directory(t)
  await put(join(root, '.claude/projects/p/s.jsonl'), '{"sessionId":"s"}\n')
  const original = fs.readdir
  t.mock.method(fs, 'readdir', async (path: string, options: { withFileTypes: true }) => {
    if (path === root)
      throw Object.assign(new Error('home listing denied'), { code: 'EACCES', syscall: 'scandir' })
    return original(path, options)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const result = await sessions.scan({ providers: ['claude'], homeDir: root })
  assert.deepEqual(result.refs.map(ref => ref.id), ['s'])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]?.source?.path, root)
  assert.equal(result.failures[0]?.code, 'PermissionDenied')
})
void it('JSONL identification sees bounded headers and separate companions and governs identity before parsing', async (t) => {
  const root = await directory(t)
  const paths = [join(root, 'valid.jsonl'), join(root, 'unrelated.jsonl')]
  await put(paths[0]!, '{"certified":true,"id":"native"}\n')
  await put(paths[1]!, '{}\n')
  await put(join(root, 'companion.json'), '{"kind":"companion"}')
  const provider = jsonlProvider({
    id: 'custom',
    roots: async () => [root],
    metadataFiles: () => [join(root, 'companion.json')],
    metadata: () => ({ id: 'provisional', metadata: { kept: true } }),
    identify({ header, companions }) {
      assert.deepEqual(companions, [{ kind: 'companion' }])
      return (header[0] as { certified?: boolean }).certified === true ? { id: 'native', metadata: { certified: true } } : false
    },
    parse() { throw new Error('scan must not parse transcript events') },
  })
  const result = await createSessionRegistry([provider]).scan()
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.refs.map(ref => [ref.id, ref.metadata]), [['native', { kept: true, certified: true }]])
})
void it('Cursor directory discovery limits JSONL to agent-transcripts and IDE databases to state stores', async (t) => {
  const root = await directory(t)
  const transcript = join(root, '.cursor/projects/p/agent-transcripts/s/s.jsonl')
  for (const path of [transcript, join(root, '.cursor/projects/p/debug.jsonl'), join(root, '.config/Cursor/User/debug.jsonl')])
    await put(path, '{"role":"user","message":{"content":"hello"}}\n')
  await put(join(root, '.config/Cursor/User/random.db'), 'not sqlite')
  const ide = join(root, '.config/Cursor/User/globalStorage/state.vscdb')
  await mkdir(dirname(ide), { recursive: true })
  await copyFile(resolve('fixtures/cursor/ide-current.db'), ide)
  const result = await sessions.scan({ providers: ['cursor'], homeDir: root })
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.refs.map(ref => ref.source.path).sort(), [transcript, ide].sort())
  assert.equal((await sessions.scan({ providers: ['cursor'], roots: { cursor: [root] } })).refs.length, 2)
})
void it('Cursor discovers chat and ACP stores, checks identity, retains blobs and ignores symlink children', async (t) => {
  const root = await directory(t)
  const id = '11111111-1111-1111-1111-111111111111'
  const fixture = resolve('fixtures/cursor/persisted/acp-sessions', id)
  const stores = [join(root, '.cursor/chats/workspace', id), join(root, '.cursor/acp-sessions', id)]
  for (const path of stores) {
    await mkdir(path, { recursive: true })
    await copyFile(join(fixture, 'store.db'), join(path, 'store.db'))
    await copyFile(join(fixture, 'meta.json'), join(path, 'meta.json'))
  }
  const mismatch = join(root, '.cursor/acp-sessions/22222222-2222-2222-2222-222222222222')
  await mkdir(mismatch)
  await copyFile(join(fixture, 'store.db'), join(mismatch, 'store.db'))
  await copyFile(join(fixture, 'meta.json'), join(mismatch, 'meta.json'))
  await symlink(stores[1]!, join(root, '.cursor/acp-sessions/33333333-3333-3333-3333-333333333333'))
  const nested = join(root, '.cursor/acp-sessions/backup/acp-sessions', id)
  await mkdir(nested, { recursive: true })
  await copyFile(join(fixture, 'store.db'), join(nested, 'store.db'))
  await copyFile(join(fixture, 'meta.json'), join(nested, 'meta.json'))
  const result = await sessions.scan({ providers: ['cursor'], homeDir: root })
  assert.deepEqual(result.failures, [])
  assert.equal(result.refs.length, 2)
  for (const ref of result.refs) {
    assert.equal(ref.id, id)
    assert.ok(['chat', 'acp'].includes(String(ref.source.locator?.storage)))
    const before = await readFile(ref.source.path)
    const session = await sessions.read(ref)
    assertSessionContract(session)
    assert.deepEqual(conversationOf(session).map(event => event.type), ['user_message', 'assistant_message', 'assistant_message'])
    const replies = conversationOf(session).filter(event => event.type === 'assistant_message')
    assert.equal(replies[0]?.record, replies[1]?.record)
    assert.ok(session.events.some(event => event.type === 'unknown'))
    assert.ok(jsonOf(session).includes('native_bytes'))
    assert.deepEqual(await readFile(ref.source.path), before)
    if (ref.source.locator?.storage === 'acp')
      assert.equal(session.workspace?.path, '/captured/cursor')
  }
  const acp = result.refs.find(ref => ref.source.locator?.storage === 'acp')!
  await writeFile(join(dirname(acp.source.path), 'meta.json'), '{"schemaVersion":2}')
  assert.equal((await sessions.scan({ providers: ['cursor'], homeDir: root })).refs.length, 1)
  await assert.rejects(sessions.read(acp), hasCode('UnsupportedSchema'))
})
void it('Cursor store discovery respects bounds and read rejects missing graph nodes without source writes', async (t) => {
  const root = await directory(t)
  const id = '11111111-1111-1111-1111-111111111111'
  const path = join(root, '.cursor/acp-sessions', id, 'store.db')
  const fixture = resolve('fixtures/cursor/persisted/acp-sessions', id)
  await mkdir(dirname(path), { recursive: true })
  await copyFile(join(fixture, 'store.db'), path)
  await copyFile(join(fixture, 'meta.json'), join(dirname(path), 'meta.json'))
  const limited = await sessions.scan({ providers: ['cursor'], homeDir: root, headerBytes: 64 })
  assert.equal(limited.refs.length, 0)
  assert.ok(limited.failures.length > 0)
  const ref = (await sessions.scan({ providers: ['cursor'], homeDir: root })).refs[0]!
  const controller = new AbortController()
  const reason = new Error('cancel persisted source')
  const opened = await sessions.open(ref, { signal: controller.signal })
  await assert.rejects(async () => {
    for await (const frame of opened.stream()) {
      assert.equal(frame.type, 'record')
      controller.abort(reason)
    }
  }, error => error === reason)
  // Mutate only the temporary test store, leaving its certified root intact.
  const db = new DatabaseSync(path)
  try {
    db.exec('DELETE FROM blobs WHERE data = X\'0a0f68656c6c6f2066726f6d2075736572\'')
  }
  finally { db.close() }
  const before = await readFile(path)
  await assert.rejects(sessions.read(ref), hasCode('CorruptedSession'))
  assert.deepEqual(await readFile(path), before)
})
void it('Cursor excludes an ACP symlink root before inspecting its stores', async (t) => {
  const root = await directory(t)
  const outside = join(root, 'outside')
  await put(join(outside, '11111111-1111-1111-1111-111111111111/store.db'), 'damaged outside database')
  await mkdir(join(root, '.cursor'))
  await symlink(outside, join(root, '.cursor/acp-sessions'))
  assert.deepEqual(await sessions.scan({ providers: ['cursor'], homeDir: root }), { refs: [], failures: [] })
})
void it('Cursor reports an ACP companion denial and continues independent chat stores', async (t) => {
  const root = await directory(t)
  const id = '11111111-1111-1111-1111-111111111111'
  const fixture = resolve('fixtures/cursor/persisted/acp-sessions', id)
  for (const relative of [`.cursor/chats/workspace/${id}`, `.cursor/acp-sessions/${id}`]) {
    const path = join(root, relative)
    await mkdir(path, { recursive: true })
    await copyFile(join(fixture, 'store.db'), join(path, 'store.db'))
  }
  const companion = join(root, '.cursor/acp-sessions', id, 'meta.json')
  const original = fs.stat
  t.mock.method(fs, 'stat', async (path: string) => {
    if (path === companion)
      throw Object.assign(new Error('companion denied'), { code: 'EACCES', syscall: 'stat' })
    return original(path)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const result = await sessions.scan({ providers: ['cursor'], homeDir: root })
  assert.equal(result.refs.length, 1)
  assert.equal(result.refs[0]?.source.locator?.storage, 'chat')
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]?.source?.path, companion)
  assert.equal(result.failures[0]?.code, 'PermissionDenied')
})
void it('OpenCode directory discovery rejects JSON lookalikes and validates native session metadata', async (t) => {
  const root = await directory(t)
  await put(join(root, 'storage/session/p/ses_good.json'), '{"id":"ses_good","title":"native"}')
  await put(join(root, 'storage/session/p/debug.json'), '{"id":"debug"}')
  await put(join(root, 'storage/session/p/ses_wrong.json'), '{"id":"ses_other"}')
  await put(join(root, 'storage/session/p/ses_empty.json'), '{}')
  await put(join(root, 'storage/message/s/ses_message.json'), '{"id":"ses_message"}')
  const result = await sessions.scan({ providers: ['opencode'], roots: { opencode: [root] } })
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.refs.map(ref => ref.id), ['ses_good'])
})
void it('Kimi physical refs expose native session identity and agent role without merging streams', async (t) => {
  const root = await directory(t)
  await put(join(root, 's/state.json'), '{"id":"native","createdAt":1,"agents":{}}')
  for (const agent of ['main', 'child'])
    await put(join(root, `s/agents/${agent}/wire.jsonl`), '{"type":"metadata","protocol_version":"1.5"}\n')
  await symlink(join(root, 's/agents/main'), join(root, 's/agents/link'))
  const result = await sessions.scan({ providers: ['kimi'], roots: { kimi: [root] } })
  assert.equal(result.refs.length, 2)
  for (const ref of result.refs) {
    const agentId = dirname(ref.source.path).split('/').at(-1)
    assert.equal(ref.metadata.nativeSessionId, 'native')
    assert.equal(ref.metadata.agentId, agentId)
    assert.equal(ref.metadata.agentRole, agentId === 'main' ? 'main' : 'subagent')
    const session = await sessions.read(ref)
    assert.equal(session.metadata.agentId, agentId)
    assertSessionContract(session)
  }
  const acquired = await sessions.parse('kimi', { jsonl: '{"type":"metadata","protocol_version":"1.5"}\n', source: join(root, 's/agents/main/wire.jsonl') })
  assert.equal(acquired.metadata.agentRole, undefined)
  assert.equal(acquired.metadata.agentId, undefined)
})
function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof SessionError && error.code === code
}
void it('scan preserves other providers when a database cannot be scanned', async (t) => {
  const damaged = join(await directory(t), 'damaged.db')
  await writeFile(damaged, Buffer.alloc(100))
  const result = await sessions.scan({
    providers: ['codex', 'cursor', 'pi'],
    roots: {
      codex: [resolve('fixtures/codex/simple.jsonl')],
      cursor: [damaged],
      pi: [resolve('fixtures/pi/simple.jsonl')],
    },
  })
  assert.deepEqual(result.refs.map(ref => ref.provider), ['codex', 'pi'])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]!.provider, 'cursor')
  assert.equal(result.failures[0]!.scope, 'source')
  assert.deepEqual(result.failures[0]!.source, { path: damaged, format: 'cursor_sqlite' })
  assert.equal(result.failures[0]!.code, 'UnsupportedSchema')
})
void it('scan continues Cursor sources after a damaged database', async (t) => {
  const damaged = join(await directory(t), 'damaged.db')
  await writeFile(damaged, Buffer.alloc(100))
  const result = await sessions.scan({
    providers: ['cursor'],
    roots: { cursor: [resolve('fixtures/cursor/ide-current.db'), damaged, resolve('fixtures/cursor/simple.jsonl')] },
  })
  assert.deepEqual(result.refs.map(ref => ref.source.format).sort(), ['cursor_sqlite', 'jsonl'])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]!.source?.path, damaged)
})
void it('scan reports a denied directory and continues its siblings and later roots', async (t) => {
  const root = await directory(t)
  const denied = join(root, 'a-denied')
  await mkdir(denied)
  await writeFile(join(root, 'b-readable.jsonl'), '{"type":"session_meta","payload":{"id":"sibling"}}\n')
  const original = fs.readdir
  const cause = Object.assign(new Error('denied'), { code: 'EACCES', syscall: 'scandir' })
  t.mock.method(fs, 'readdir', async (path: string, options: { withFileTypes: true }) => {
    if (path === denied)
      throw cause
    return original(path, options)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const result = await sessions.scan({ providers: ['codex'], roots: { codex: [root, resolve('fixtures/codex/simple.jsonl')] } })
  assert.equal(result.refs.length, 2)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]!.code, 'PermissionDenied')
  assert.deepEqual(result.failures[0]!.source, { path: denied })
  assert.equal((result.failures[0]!.cause as SessionError).cause, cause)
  await assert.rejects(async () => {
    for await (const path of files([root], () => true)) void path
  }, hasCode('PermissionDenied'))
})
void it('scan reports the failing companion path and continues independent JSONL sources', async (t) => {
  const root = await directory(t)
  const transcript = join(root, 'blocked/updates.jsonl')
  const companion = join(root, 'blocked/summary.json')
  await mkdir(join(root, 'blocked'))
  await writeFile(transcript, '{}\n')
  const original = fs.stat
  const cause = Object.assign(new Error('companion denied'), { code: 'EACCES', syscall: 'stat' })
  t.mock.method(fs, 'stat', async (path: string) => {
    if (path === companion)
      throw cause
    return original(path)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const result = await sessions.scan({ providers: ['grok'], roots: { grok: [transcript, resolve('fixtures/grok/session/updates.jsonl')] } })
  assert.equal(result.refs.length, 1)
  assert.equal(result.refs[0]!.source.path, resolve('fixtures/grok/session/updates.jsonl'))
  assert.equal(result.failures.length, 1)
  assert.deepEqual(result.failures[0]!.source, { path: companion })
  assert.equal(result.failures[0]!.code, 'PermissionDenied')
})
void it('scan isolates an unexpected provider exception and closes its yielded prefix', async () => {
  const cause = new Error('adapter invariant failed')
  const ref: SessionRef = { id: 'kept', provider: 'custom', source: { path: 'memory', format: 'custom' }, metadata: {} }
  let closed = false
  const provider = defineProvider({
    id: 'custom',
    async detect() { return { provider: 'custom', roots: [], available: true } },
    async* scan(): AsyncGenerator<ScanEvent> {
      try {
        yield { type: 'ref', ref }
        throw cause
      }
      finally { closed = true }
    },
    async read() { throw new Error('unexpected read') },
  })
  const registry = createSessionRegistry([provider, sessions.require('codex')])
  const result = await registry.scan({ roots: { codex: [resolve('fixtures/codex/simple.jsonl')] } })
  assert.equal(closed, true)
  assert.deepEqual(result.refs.map(ref => ref.provider), ['codex', 'custom'])
  assert.deepEqual(result.failures, [{ provider: 'custom', scope: 'provider', code: 'Unknown', message: cause.message, cause }])
})
void it('scanStream is lazy, retains discovery order and source identity, and closes on early return', async () => {
  let started = 0
  let closed = 0
  const first: SessionRef = { id: 'repeated', provider: 'custom', source: { path: 'z', format: 'custom', locator: { id: '1' } }, metadata: {} }
  const second: SessionRef = { ...first, source: { ...first.source, path: 'a' } }
  const failure = { provider: 'custom', scope: 'provider' as const, code: 'UnsupportedSchema' as const, message: 'explicit provider failure' }
  const provider = defineProvider({
    id: 'custom',
    async detect() { return { provider: 'custom', roots: [], available: true } },
    async* scan(): AsyncGenerator<ScanEvent> {
      started++
      try {
        yield { type: 'ref', ref: first }
        yield { type: 'ref', ref: { ...first, title: 'same source' } }
        yield { type: 'failure', failure }
        yield { type: 'ref', ref: second }
      }
      finally { closed++ }
    },
    async read() { throw new Error('unexpected read') },
  })
  const registry = createSessionRegistry([provider])
  const stream = registry.scanStream()
  assert.equal(started, 0)
  assert.deepEqual(await stream.next(), { done: false, value: { type: 'ref', ref: first } })
  await stream.return(undefined)
  assert.equal(started, 1)
  assert.equal(closed, 1)
  const events: ScanEvent[] = []
  for await (const event of registry.scanStream()) events.push(event)
  assert.deepEqual(events, [{ type: 'ref', ref: first }, { type: 'failure', failure }, { type: 'ref', ref: second }])
  assert.deepEqual(await registry.scan(), { refs: [second, first], failures: [failure] })
  assert.equal(closed, 3)
})
void it('scan rejects invalid requests before entering providers, including empty registries', async () => {
  let started = false
  const provider = defineProvider({
    id: 'custom',
    async detect() { return { provider: 'custom', roots: [], available: false } },
    async* scan(): AsyncGenerator<ScanEvent> {
      started = true
    },
    async read() { throw new Error('unexpected read') },
  })
  const registry = createSessionRegistry([provider])
  await assert.rejects(registry.scan({ providers: ['custom', 'missing'] }), hasCode('ProviderNotFound'))
  for (const headerBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(registry.scan({ headerBytes }), RangeError)
    await assert.rejects(createSessionRegistry().scan({ headerBytes }), RangeError)
  }
  const cause = new SessionError('IOError', 'caller cancelled')
  await assert.rejects(registry.scan({ signal: AbortSignal.abort(cause) }), error => error === cause)
  assert.equal(started, false)
})
void it('scan cancellation after a ref propagates its reason and stops later providers', async () => {
  const controller = new AbortController()
  const reason = new SessionError('IOError', 'caller cancelled')
  let closed = false
  let laterStarted = false
  const ref: SessionRef = { id: 's', provider: 'custom', source: { path: 'memory', format: 'custom' }, metadata: {} }
  const provider = defineProvider({
    id: 'custom',
    async detect() { return { provider: 'custom', roots: [], available: true } },
    async* scan(): AsyncGenerator<ScanEvent> {
      try {
        yield { type: 'ref', ref }
        controller.abort(reason)
        throw new Error('masked cancellation')
      }
      finally { closed = true }
    },
    async read() { throw new Error('unexpected read') },
  })
  const later = defineProvider({
    ...provider,
    id: 'later',
    async* scan(): AsyncGenerator<ScanEvent> {
      laterStarted = true
    },
  })
  const events: ScanEvent[] = []
  await assert.rejects(async () => {
    for await (const event of createSessionRegistry([provider, later]).scanStream({ signal: controller.signal })) events.push(event)
  }, error => error === reason)
  assert.deepEqual(events, [{ type: 'ref', ref }])
  assert.equal(closed, true)
  assert.equal(laterStarted, false)
})
void it('scan source boundaries distinguish native I/O, unknown adapter errors and cancellation', async () => {
  const source = { path: 'native.jsonl', format: 'jsonl' }
  const native = Object.assign(new Error('read denied'), { code: 'EACCES', syscall: 'read' })
  const errors: unknown[] = [native, new Error('adapter bug'), undefined]
  for (const cause of errors) {
    const stream = scanSource('custom', source, {}, async function* (): AsyncGenerator<ScanEvent> {
      throw cause
    })
    if (cause === native) {
      const events: ScanEvent[] = []
      for await (const event of stream) events.push(event)
      assert.equal(events.length, 1)
      assert.equal(events[0]?.type, 'failure')
      if (events[0]?.type === 'failure') {
        assert.equal(events[0].failure.code, 'PermissionDenied')
        assert.equal((events[0].failure.cause as SessionError).cause, native)
      }
    }
    else {
      await assert.rejects(async () => {
        for await (const event of stream) void event
      }, error => error === cause)
    }
  }
  const controller = new AbortController()
  const reason = new SessionError('CorruptedSession', 'cancel source')
  const stream = scanSource('custom', source, { signal: controller.signal }, async function* (): AsyncGenerator<ScanEvent> {
    controller.abort(reason)
    throw reason
  })
  await assert.rejects(async () => {
    for await (const event of stream) void event
  }, error => error === reason)
})
void it('scanStream propagates consumer throw and early-return cleanup errors without failure events', async () => {
  const reason = new SessionError('IOError', 'consumer stop')
  const ref: SessionRef = { id: 's', provider: 'custom', source: { path: 'memory', format: 'custom' }, metadata: {} }
  let closed = 0
  async function close() {
    closed++
    throw reason
  }
  const provider = defineProvider({
    id: 'custom',
    async detect() { return { provider: 'custom', roots: [], available: true } },
    scan: () => scanSource('custom', ref.source, {}, async function* (): AsyncGenerator<ScanEvent> {
      try {
        yield { type: 'ref', ref }
      }
      finally {
        await close()
      }
    }),
    async read() { throw new Error('unexpected read') },
  })
  const registry = createSessionRegistry([provider])
  const early = registry.scanStream()
  await early.next()
  await assert.rejects(early.return(undefined), error => error === reason)
  assert.equal(closed, 1)
  const thrown = registry.scanStream()
  await thrown.next()
  await assert.rejects(thrown.throw(reason), error => error === reason)
  assert.equal(closed, 2)
})
for (const [provider, header, message] of [
  [
    'codex',
    { type: 'session_meta', payload: { id: 'large' } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: 'text' },
    },
  ],
  [
    'claude',
    { type: 'system', sessionId: 'large' },
    { type: 'user', sessionId: 'large', message: { content: 'text' } },
  ],
  [
    'pi',
    { type: 'session', id: 'large', version: 3 },
    { type: 'message', message: { role: 'user', content: 'text' } },
  ],
  [
    'cursor',
    { role: 'user', message: { content: 'header' } },
    { role: 'assistant', message: { content: 'text' } },
  ],
] as const) {
  void it(`${provider}: cheap scan, lazy open, early return, full snapshot and cancellation`, async (t) => {
    const root = await directory(t)
    const path = join(root, 'large.jsonl')
    await writeFile(
      path,
      `${JSON.stringify(header)
      }\n${
        (`${JSON.stringify(message)}\n`).repeat(20000)
      }${JSON.stringify({ late: 'x'.repeat(2048) })
      }\n`,
    )
    const { refs } = await sessions.scan({
      providers: [provider],
      roots: { [provider]: [path] },
      homeDir: root,
      headerBytes: 128,
    })
    const ref = refs[0]!
    assert.equal(refs.length, 1)
    const opened = await sessions.open(ref, { maxRecordBytes: 1024 })
    assert.equal(opened.readMode, 'incremental')
    let count = 0
    for await (const event of opened.events()) {
      assert.equal(event.sequence, count++)
      if (count === 3)
        break
    }
    assert.equal(count, 3) // A late oversized record must not be read after early return.
    await assert.rejects(async () => opened.snapshot(), hasCode('CorruptedSession'))
    const snapshot = await sessions.read(ref)
    assert.equal(snapshot.records.length, 20002)
    assertSessionContract(snapshot)
    assert.equal(snapshot.events.at(-1)?.type, 'unknown')
    const controller = new AbortController()
    const cancelled = await sessions.open(ref, { signal: controller.signal })
    await assert.rejects(async () => {
      for await (const event of cancelled.events()) {
        assert.equal(event.sequence, 0)
        controller.abort(new Error('stop'))
      }
    }, /stop/)
  })
}
void it('malformed binary lines and blank lines retain physical positions and later events', async (t) => {
  const root = await directory(t)
  const path = join(root, 's.jsonl')
  await writeFile(
    path,
    Buffer.concat([
      Buffer.from('{"type":"session_meta","payload":{"id":"s"}}\n\n'),
      Buffer.from([255, 254, 10]),
      Buffer.from(
        '{"type":"response_item","payload":{"type":"message","role":"user","content":"later"}}\n',
      ),
    ]),
  )
  const ref = (await sessions.scan({ providers: ['codex'], roots: { codex: [path] } })).refs[0]!
  const snapshot = await sessions.read(ref)
  assert.deepEqual(
    snapshot.records.map(r => r.source.position),
    [1, 3, 4],
  )
  assert.deepEqual(snapshot.records[1]!.bytes, [255, 254, 10])
  assert.equal(snapshot.events.at(-1)?.type, 'user_message')
  assertSessionContract(snapshot)
})
void it('large JSON integer lexemes remain exact raw evidence', async (t) => {
  const root = await directory(t)
  const path = join(root, 's.jsonl')
  const line = '{"type":"future","integer":9007199254740993,"decimal":1.2300}'
  await writeFile(path, `${line}\n`)
  const ref = (await sessions.scan({ providers: ['codex'], roots: { codex: [path] } })).refs[0]!
  const snapshot = await sessions.read(ref)
  assert.equal(snapshot.records[0]!.text, `${line}\n`)
  assert.equal(snapshot.events[0]!.type, 'unknown')
  assert.ok(jsonOf(snapshot).includes('9007199254740993'))
})
void it('tool calls selection excludes native tool results', async () => {
  const ref = (await sessions.scan({
    providers: ['codex'],
    roots: { codex: [resolve('fixtures/codex/tool-call.jsonl')] },
  })).refs[0]!
  const session = await sessions.read(ref)
  assert.deepEqual(toolCallsOf(session).map(event => event.type), ['tool_call'])
})
void it('event selection retains evidence, repeated IDs and order with narrowed types', async () => {
  const native = await readFile(resolve('fixtures/codex/tool-call.jsonl'), 'utf8')
  const session = await sessions.parse('codex', { jsonl: native + native })
  const calls: readonly Extract<SessionEvent, { type: 'tool_call' }>[] = toolCallsOf(session)
  const results: readonly Extract<SessionEvent, { type: 'tool_result' }>[] = toolResultsOf(session)
  const selected: readonly Extract<SessionEvent, { type: 'tool_call' | 'tool_result' }>[] = eventsOf(session, 'tool_result', 'tool_call', 'tool_call')
  assert.deepEqual(calls.map(event => event.data.callId), ['call-1', 'call-1'])
  assert.deepEqual(results.map(event => event.data.callId), ['call-1', 'call-1'])
  assert.deepEqual(selected, [calls[0], results[0], calls[1], results[1]])
  for (const event of selected)
    assert.equal(event, session.events[event.sequence])
  assert.deepEqual(eventsOf(session, 'usage'), [])
  assert.deepEqual(conversationOf(session), [])
  assert.deepEqual(fileChangesOf(session), [])
  assert.throws(() => Reflect.apply(eventsOf, undefined, [session]), /at least one event type/)
})
void it('file changes selection returns explicit canonical changes', () => {
  const change: SessionEvent = {
    sequence: 0,
    record: 0,
    providerMetadata: {},
    type: 'file_change',
    data: { path: 'example.ts', operation: 'modify' },
  }
  const changes: readonly Extract<SessionEvent, { type: 'file_change' }>[] = fileChangesOf({ events: [change] })
  assert.equal(changes[0], change)
})
void it('opened handles expose buffering for each native source format', async () => {
  for (const [provider, path, mode] of [
    ['codex', 'codex/simple.jsonl.zst', 'incremental'],
    ['cursor', 'cursor/ide-current.db', 'buffered'],
    ['opencode', 'opencode/simple.db', 'buffered'],
    ['opencode', 'opencode/legacy-files', 'incremental'],
  ] as const) {
    const { refs } = await sessions.scan({ providers: [provider], roots: { [provider]: [resolve('fixtures', path)] } })
    assert.ok(refs.length > 0)
    for (const ref of refs)
      assert.equal((await sessions.open(ref)).readMode, mode)
  }
})
void it('evidence is stored once and projections keep repeated IDs, native tools and branches', async () => {
  for (const [provider, path] of [
    ['claude', 'fixtures/claude/schema-variation.jsonl'],
    ['pi', 'fixtures/pi/tree.jsonl'],
    ['codex', 'fixtures/codex/subagents.jsonl'],
  ]) {
    const ref = (await sessions.scan({
      providers: [provider!],
      roots: { [provider!]: [resolve(path!)] },
    })).refs[0]!
    const snapshot = await sessions.read(ref)
    assertSessionContract(snapshot)
    assert.deepEqual(
      conversationOf(snapshot),
      snapshot.events.filter(
        e => e.type === 'user_message' || e.type === 'assistant_message',
      ),
    )
    assert.ok(toolCallsOf(snapshot).every(e => snapshot.events.includes(e)))
    assert.ok(subagentsOf(snapshot).every(e => snapshot.events.includes(e)))
    assert.equal(snapshot.parentSessionId, undefined)
    if (provider === 'pi') {
      assert.equal(snapshot.metadata.parentSession, '/fixture/parent.jsonl')
      assert.ok(
        snapshot.events.some(e => e.providerMetadata.parentId === 'u1'),
      )
    }
  }
})
void it('unknown providers, duplicate registration, absent stores and custom eager SPI', async (t) => {
  const root = await directory(t)
  assert.deepEqual(await sessions.scan({ homeDir: root }), { refs: [], failures: [] })
  await assert.rejects(
    async () => sessions.scan({ providers: ['no-such-provider'] }),
    hasCode('ProviderNotFound'),
  )
  const ref: SessionRef = {
    id: 's',
    provider: 'internal',
    source: { path: 'memory', format: 'custom' },
    metadata: {},
  }
  const snapshot: Session = {
    ...ref,
    schema: SESSION_SCHEMA,
    events: [],
    records: [],
    diagnostics: [],
  }
  let reads = 0
  const provider = defineProvider({
    id: 'internal',
    async detect() {
      return { provider: 'internal', available: true, roots: [] }
    },
    async* scan() {
      yield { type: 'ref' as const, ref }
    },
    async read() {
      reads++
      return snapshot
    },
  })
  const registry = createSessionRegistry([provider])
  assert.deepEqual(await registry.scan(), { refs: [ref], failures: [] })
  const opened = await registry.open(ref)
  assert.equal(opened.readMode, 'buffered')
  assert.equal(reads, 0)
  assert.equal(await opened.snapshot(), snapshot)
  assert.equal(await registry.read(ref), snapshot)
  assert.equal(registry.require('internal'), provider)
  assert.equal(sessions.require('codex').id, 'codex')
  assert.throws(
    () => registry.require('no-such-provider'),
    hasCode('ProviderNotFound'),
  )
  assert.throws(() => createSessionRegistry([provider, provider]), /duplicate/)
  assert.throws(() => defineProvider({ ...provider, id: ' ' }), /nonempty/)
})
void it('explicit home isolates environment discovery and explicit empty roots disable a provider', async (t) => {
  const root = await directory(t)
  await mkdir(join(root, '.config/claude/projects'), { recursive: true })
  await writeFile(
    join(root, '.config/claude/projects/s.jsonl'),
    '{"type":"system","sessionId":"s"}',
  )
  const { refs } = await sessions.scan({ homeDir: root })
  assert.deepEqual(
    refs.map(r => r.provider),
    ['claude'],
  )
  assert.deepEqual(
    await sessions.scan({ homeDir: root, roots: { claude: [] } }),
    { refs: [], failures: [] },
  )
})
void it('unsafe filesystem session ID cannot traverse paths', async (t) => {
  const root = await directory(t)
  const path = join(root, 'storage/session/project/a.json')
  await mkdir(join(root, 'storage/session/project'), { recursive: true })
  await writeFile(path, '{"id":"../../outside"}')
  const ref = (await sessions.scan({
    providers: ['opencode'],
    roots: { opencode: [path] },
  })).refs[0]!
  await assert.rejects(async () => sessions.read(ref), hasCode('CorruptedSession'))
})
void it('malformed legacy message cannot hide later parts', async (t) => {
  const root = await directory(t)
  const storage = join(root, 'storage')
  for (const p of ['session/project', 'message/s', 'part/m'])
    await mkdir(join(storage, p), { recursive: true })
  await writeFile(join(storage, 'session/project/s.json'), '{"id":"s"}')
  await writeFile(join(storage, 'message/s/0.json'), Buffer.from([255, 10]))
  await writeFile(
    join(storage, 'message/s/1.json'),
    '{"id":"m","role":"user"}',
  )
  await writeFile(
    join(storage, 'part/m/p.json'),
    '{"id":"p","type":"text","text":"survives"}',
  )
  const ref = (await sessions.scan({
    providers: ['opencode'],
    roots: { opencode: [join(storage, 'session/project/s.json')] },
  })).refs[0]!
  const session = await sessions.read(ref)
  assert.ok(session.events.some(e => e.type === 'unknown'))
  assert.ok(jsonOf(session).includes('survives'))
  assertSessionContract(session)
})
void it('sQL record evidence keeps the full row beside its normalized projections', async () => {
  const ref = (await sessions.scan({
    providers: ['opencode'],
    roots: { opencode: [resolve('fixtures/opencode/schema-variation.db')] },
  })).refs[0]!
  const session = await sessions.read(ref)
  const record = session.records.find(
    r => r.source.table === 'session_message',
  )!
  assert.ok('native_row' in (record.native as object))
  assert.ok(record.text?.includes('"files"'))
  const path = resolve('fixtures/opencode/schema-variation.db')
  const before = await readFile(path)
  await sessions.read(ref)
  assert.deepEqual(await readFile(path), before)
})
void it('cursor retains whole legacy index row but does not guess workspace from store paths', async () => {
  const ref = (await sessions.scan({
    providers: ['cursor'],
    roots: { cursor: [resolve('fixtures/cursor/ide-index.db')] },
  })).refs[0]!
  const session = await sessions.read(ref)
  assert.ok(jsonOf(session.records[0]!.native).includes('allComposers'))
  assert.equal(session.workspace, undefined)
})

void it('invalid UTF-8 in a header does not fabricate a native session identity', async (t) => {
  const root = await directory(t)
  const path = join(root, 'invalid.jsonl')
  await writeFile(
    path,
    Buffer.concat([
      Buffer.from('{"type":"system","sessionId":"'),
      Buffer.from([255]),
      Buffer.from('"}\n{"type":"user","message":{"content":"later"}}\n'),
    ]),
  )
  const ref = (await sessions.scan({ providers: ['claude'], roots: { claude: [path] } })).refs[0]!
  assert.equal(ref.id, `source:${path}`)
  const session = await sessions.read(ref)
  assert.ok(session.records[0]!.bytes?.includes(255))
  assert.equal(session.events.at(-1)?.type, 'user_message')
})
