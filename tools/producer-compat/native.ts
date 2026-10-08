import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { Session } from '../../src/index.ts'
import { sessions } from '../../src/index.ts'
import type { CompatibilityProgress } from './report.ts'
import { writeFailedReviewPacket, writeReviewPacket } from './review.ts'

type Row = Record<string, unknown>
interface Inventory {
  id: string
  path: string
  rows: Row[]
  texts: {
    record: number
    text: string
  }[]
  assertRecords: (session: Session) => void
}
function object(value: unknown): Row {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'unreviewed native object shape')
  return value as Row
}
function textParts(value: unknown): string[] {
  assert(Array.isArray(value), 'unreviewed native content shape')
  return value.map((part) => {
    const row = object(part)
    assert.equal(row.type, 'text', 'scenario unexpectedly generated non-text content')
    assert.equal(typeof row.text, 'string')
    return row.text as string
  })
}
export async function auditNativeStore(provider: string, home: string, root: string, progress: CompatibilityProgress): Promise<void> {
  progress.stage = 'native-inventory'
  const inventory = await inventoryStore(provider, home)
  await writeFile(join(root, 'native-inventory.json'), JSON.stringify({ ...inventory, assertRecords: undefined }, null, 2))
  const expected = [`HUIHUA_${provider.toUpperCase()}_REPLY`, ...(['cline', 'acp', 'oar'].includes(provider) ? [] : [`HUIHUA_${provider.toUpperCase()}_RESUMED`])]
  assert.deepEqual(inventory.texts.map(item => item.text).filter(text => text !== ''), expected, 'independent native replies differ from the scenario')
  progress.auditedSessions = 1
  progress.auditedRecords = inventory.rows.length
  progress.stage = 'scan'
  const scan = await sessions.scan({ providers: [provider], homeDir: home, ...['acp', 'oar'].includes(provider) ? { roots: { [provider]: [inventory.path] } } : {} })
  assert.deepEqual(scan.failures, [])
  assert.deepEqual(scan.refs.map(ref => [ref.id, ref.provider, ref.source.path]), [[inventory.id, provider, inventory.path]], 'native discovery omission or unexpected session')
  progress.completed.push('scan')
  const ref = scan.refs[0]!
  const handle = await sessions.open(ref)
  for (const kind of ['read', 'snapshot', 'records', 'events']) {
    progress.stage = kind
    let session: Session
    try {
      session = kind === 'snapshot' ? await handle.snapshot() : await sessions.read(ref)
    }
    catch (error) {
      await writeFailedReviewPacket(provider, root, error)
      throw error
    }
    if (kind === 'records') {
      const records = []
      for await (const record of handle.records())
        records.push(record)
      session = { ...session, records }
    }
    if (kind === 'events') {
      const events = []
      for await (const event of handle.events())
        events.push(event)
      session = { ...session, events }
    }
    await writeFile(join(root, `${kind}.json`), JSON.stringify(session, null, 2))
    inventory.assertRecords(session)
    assert.deepEqual(session.events.flatMap(event => event.type === 'assistant_message'
      ? event.data.content.map((block) => {
          assert.equal(block.type, 'text')
          return { record: event.record, text: block.data }
        })
      : []), inventory.texts, 'assistant text or its native-record association was dropped, duplicated or changed')
    for (const event of session.events)
      assert(event.record >= 0 && event.record < session.records.length, 'event points outside native evidence')
    if (kind === 'read')
      await writeReviewPacket(provider, root, session)
    progress.completed.push(kind)
  }
}
async function inventoryStore(provider: string, home: string): Promise<Inventory> {
  if (['acp', 'oar'].includes(provider))
    return recordingInventory(provider, dirname(home))
  const files = await walk(home)
  if (provider === 'grok' || provider === 'fx')
    return companionInventory(provider, files)
  if (['opencode', 'openclaw', 'hermes'].includes(provider))
    return sqliteInventory(provider, files)
  const matches = files.filter(path => provider === 'pi'
    ? path.includes('/.pi/agent/sessions/') && path.endsWith('.jsonl')
    : provider === 'qwen'
      ? /\/.qwen\/projects\/[^/]+\/chats\/[^/]+\.jsonl$/.test(path)
      : provider === 'copilot'
        ? path.endsWith('/events.jsonl') && path.includes('/.copilot/session-state/')
        : provider === 'deepseek'
          ? /\/session\.v4\.jsonl\.zstd$/.test(path)
          : provider === 'droid'
            ? path.includes('/.factory/sessions/') && path.endsWith('.jsonl')
            : provider === 'cline' ? /\/.cline\/data\/sessions\/([^/]+)\/\1\.json$/.test(path) : false)
  assert.equal(matches.length, 1, 'expected one independently discovered native conversation')
  const path = matches[0]!
  let rows: Row[]
  let id: string
  const texts: Inventory['texts'] = []
  if (provider === 'cline') {
    const state = object(JSON.parse(await readFile(path, 'utf8')))
    const messages = object(JSON.parse(await readFile(path.replace(/\.json$/, '.messages.json'), 'utf8')))
    rows = [state, messages]
    assert.equal(state.messages_path, path.replace(/\.json$/, '.messages.json'))
    assert.equal(typeof state.session_id, 'string')
    id = state.session_id as string
    assert(Array.isArray(messages.messages))
    for (const message of messages.messages) {
      if (object(message).role === 'assistant') {
        texts.push(...textParts(object(message).content).map(text => ({ record: 1, text })))
      }
    }
  }
  else {
    // Independent native decoder: not Huihua's JSONL/zstd implementation.
    const source = provider === 'deepseek' ? execFileSync('zstd', ['-d', '-c', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }) : await readFile(path, 'utf8')
    rows = source.split('\n').filter(line => line.trim()).map(line => object(JSON.parse(line)))
    const first = rows[0]!
    const nativeId = provider === 'qwen' ? first.sessionId : provider === 'copilot' ? object(first.data).sessionId : first.id
    assert.equal(typeof nativeId, 'string')
    id = nativeId as string
    rows.forEach((row, record) => {
      let content: string[] = []
      if (['pi', 'droid'].includes(provider) && row.type === 'message' && object(row.message).role === 'assistant')
        content = textParts(object(row.message).content)
      if (provider === 'qwen' && row.type === 'assistant') {
        const parts = object(row.message).parts
        assert(Array.isArray(parts))
        content = parts.map((part) => {
          assert.equal(typeof object(part).text, 'string')
          return object(part).text as string
        })
      }
      if (provider === 'copilot' && row.type === 'assistant.message') {
        assert.equal(typeof object(row.data).content, 'string')
        content = [object(row.data).content as string]
      }
      if (provider === 'deepseek' && row.type === 'assistant/message')
        content = textParts(object(object(row.data).message).content)
      texts.push(...content.map(text => ({ record, text })))
    })
  }
  return { path, id, rows, texts, assertRecords(session) {
    assert.deepEqual(session.records.map(record => record.native), rows, 'native records were changed or lost')
  } }
}
function sqliteInventory(provider: string, files: string[]): Inventory {
  const matches = files.filter(path => basename(path) === (provider === 'openclaw' ? 'openclaw-agent.sqlite' : provider === 'hermes' ? 'state.db' : 'opencode.db'))
  assert.equal(matches.length, 1)
  const path = matches[0]!
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const sessionTable = provider === 'openclaw' ? 'session_windows' : provider === 'hermes' ? 'sessions' : 'session'
    const sessions = db.prepare(`SELECT * FROM ${sessionTable}`).all().map(object)
    assert.equal(sessions.length, 1)
    const state = sessions[0]!
    const id = String(provider === 'openclaw' ? state.session_id : state.id)
    const rows = [state]
    const texts: Inventory['texts'] = []
    if (provider === 'hermes') {
      const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, id').all(id).map(object)
      for (const message of messages) {
        rows.push(message)
        if (message.role === 'assistant') {
          assert.equal(typeof message.content, 'string')
          texts.push({ record: rows.length - 1, text: message.content as string })
        }
      }
      return { path, id, rows, texts, assertRecords(session) {
        assert.deepEqual(session.records.map(record => record.native), safe(rows))
      } }
    }
    if (provider === 'openclaw') {
      const events = db.prepare('SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq').all(id).map(object)
      for (const event of events) {
        rows.push(event)
        const text = typeof event.event_json === 'string' ? event.event_json : execFileSync('zstd', ['-d', '-c'], { input: event.event_zstd as Uint8Array, encoding: 'utf8' })
        const native = object(JSON.parse(text))
        if (native.type === 'message' && object(native.message).role === 'assistant')
          texts.push(...textParts(object(native.message).content).map(text => ({ record: rows.length - 1, text })))
      }
      return { path, id, rows, texts, assertRecords(session) {
        assert.deepEqual(session.records.map(record => record.native), safe(rows))
      } }
    }
    const messages = db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id').all(id).map(object)
    for (const message of messages) {
      rows.push(message)
      const data = object(JSON.parse(String(message.data)))
      const parts = db.prepare('SELECT * FROM part WHERE message_id = ? ORDER BY time_created, id').all(String(message.id)).map(object)
      for (const part of parts) {
        rows.push(part)
        const content = object(JSON.parse(String(part.data)))
        if (data.role === 'assistant' && content.type === 'text') {
          assert.equal(typeof content.text, 'string')
          texts.push({ record: rows.length - 1, text: content.text as string })
        }
      }
    }
    return { path, id, rows, texts, assertRecords(session) {
      assert.deepEqual(session.records.map((record, index) => index === 0 ? record.native : object(record.native).native_row), safe(rows), 'SQLite native rows changed or lost')
      for (const record of session.records.slice(1))
        assert.deepEqual(object(record.native).data, JSON.parse(String(object(object(record.native).native_row).data)))
    } }
  }
  finally {
    db.close()
  }
}
function safe(value: unknown): unknown {
  if (value instanceof Uint8Array)
    return { native_bytes: [...value] }
  if (Array.isArray(value))
    return value.map(safe)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safe(item)]))
  return value
}
async function walk(directory: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      result.push(...await walk(path))
    else if (entry.isFile())
      result.push(path)
  }
  return result.sort()
}
async function companionInventory(provider: string, files: string[]): Promise<Inventory> {
  const matches = files.filter(path => provider === 'fx' ? path.includes('/.fx/sessions/') && path.endsWith('/session.json') : path.includes('/.grok/sessions/') && path.endsWith('/updates.jsonl'))
  assert.equal(matches.length, 1)
  const path = matches[0]!
  const state = object(JSON.parse(await readFile(provider === 'fx' ? path : join(dirname(path), 'summary.json'), 'utf8')))
  const content = await readFile(provider === 'fx' ? join(dirname(path), 'events.jsonl') : path, 'utf8')
  const rows = [state, ...content.split('\n').filter(line => line.trim()).map(line => object(JSON.parse(line)))]
  const id = String(provider === 'fx' ? state.id : object(state.info).id)
  const texts: Inventory['texts'] = []
  rows.slice(1).forEach((row, index) => {
    if (provider === 'fx') {
      const event = object(row.event)
      if (event.assistant !== undefined) {
        const text = object(event.assistant).text
        assert.equal(typeof text, 'string')
        texts.push({ record: index + 1, text: text as string })
      }
    }
    else if (row.method === 'session/update') {
      const update = object(object(row.params).update)
      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = object(update.content)
        assert.equal(content.type, 'text')
        assert.equal(typeof content.text, 'string')
        texts.push({ record: index + 1, text: content.text as string })
      }
    }
  })
  return { path, id, rows, texts, assertRecords(session) {
    assert.deepEqual(session.records.map(record => record.native), rows)
  } }
}

async function recordingInventory(provider: string, root: string): Promise<Inventory> {
  const path = join(root, provider === 'acp' ? 'session.acp.jsonl' : 'session.voyage.jsonl')
  const content = await readFile(path, 'utf8')
  const rows = content.split('\n').filter(line => line.trim()).map(line => object(JSON.parse(line)))
  let id: string | undefined
  const texts: Inventory['texts'] = []
  rows.forEach((row, record) => {
    if (provider === 'acp' && row.method === 'session/update') {
      const params = object(row.params)
      assert.equal(typeof params.sessionId, 'string')
      id ??= params.sessionId as string
      assert.equal(id, params.sessionId)
      const update = object(params.update)
      if (update.sessionUpdate === 'agent_message_chunk') {
        const part = object(update.content)
        assert.equal(part.type, 'text')
        assert.equal(typeof part.text, 'string')
        texts.push({ record, text: part.text as string })
      }
    }
    if (provider === 'oar') {
      if (row.kind === 'header') {
        assert.equal(row.format, 'oar-voyage/3')
        assert.equal(typeof row.sessionId, 'string')
        id = row.sessionId as string
      }
      else if (row.kind === 'record') {
        const native = object(row.record)
        assert.equal(native.sessionId, id)
        const body = object(native.body)
        if (Array.isArray(body.events)) {
          for (const event of body.events) {
            const item = object(event)
            if (item.kind === 'text_delta') {
              assert.equal(typeof item.text, 'string')
              texts.push({ record, text: item.text as string })
            }
          }
        }
      }
    }
  })
  assert(id !== undefined)
  return { path, id, rows, texts, assertRecords(session) {
    assert.deepEqual(session.records.map(record => record.native), rows)
  } }
}
