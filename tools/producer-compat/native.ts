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
  evidence?: { path: string, position?: number, text: string }[]
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
function physicalEvidence(path: string, source: string) {
  return (source.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((text, index) => ({ path, position: index + 1, text })).filter(row => row.text.trim())
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
export async function inventoryStore(provider: string, home: string): Promise<Inventory> {
  const inventory = await readInventory(provider, home)
  const assertRecords = inventory.assertRecords
  inventory.assertRecords = (session) => {
    assertRecords(session)
    assertNativeFacts(provider, inventory, session)
  }
  return inventory
}

async function readInventory(provider: string, home: string): Promise<Inventory> {
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
  let evidence: Inventory['evidence']
  if (provider === 'cline') {
    const stateText = await readFile(path, 'utf8')
    const messagesPath = path.replace(/\.json$/, '.messages.json')
    const messagesText = await readFile(messagesPath, 'utf8')
    const state = object(JSON.parse(stateText))
    const messages = object(JSON.parse(messagesText))
    evidence = [{ path, text: stateText }, { path: messagesPath, text: messagesText }]
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
    const physical = physicalEvidence(path, source)
    rows = physical.map(row => object(JSON.parse(row.text)))
    evidence = physical
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
  return { path, id, rows, texts, ...(evidence === undefined ? {} : { evidence }), assertRecords(session) {
    assert.deepEqual(session.records.map(record => record.native), rows, 'native records were changed or lost')
  } }
}

// Independent assertions for the existing text journeys, not a second provider mapper.
// Only facts explicitly present in the inventoried format are required.
function assertNativeFacts(provider: string, inventory: Inventory, session: Session): void {
  assert.equal(session.id, inventory.id, 'native session identity')
  assert.equal(session.provider, provider, 'native session provider')
  assert.equal(session.source.path, inventory.path, 'native session source')
  const format = provider === 'deepseek' ? 'jsonl_zstd' : ['cline', 'fx'].includes(provider) ? `${provider}_json` : ['opencode', 'openclaw', 'hermes'].includes(provider) ? `${provider}_sqlite` : 'jsonl'
  assert.equal(session.source.format, format, 'native source format')
  for (const [index, record] of session.records.entries()) {
    assert.equal(record.sequence, index, 'native record sequence')
    assert.equal(record.provider, provider, 'native record provider')
    const evidence = inventory.evidence?.[index]
    if (evidence) {
      assert.deepEqual(record.source, { path: evidence.path, ...(evidence.position === undefined ? {} : { position: evidence.position }) }, 'native physical source')
      assert.equal(record.text, evidence.text, 'native raw text')
    }
  }
  for (const [index, event] of session.events.entries()) {
    assert.equal(event.sequence, index, 'native event sequence')
    assert(Number.isInteger(event.record) && event.record >= 0 && event.record < inventory.rows.length, 'native event association')
  }
  assert(session.diagnostics.every(diagnostic => diagnostic.code === 'PartialParse'), 'unexpected producer-read diagnostics')
  assert.equal(session.diagnostics.length, session.events.filter(event => event.type === 'unknown').length, 'missing/extra native unknown diagnostics')
  const header = inventory.rows[0]!
  if (['pi', 'droid', 'deepseek'].includes(provider)) {
    assert.equal(session.workspace?.path, header.cwd, 'native workspace')
    const created = provider === 'deepseek' ? header.createdAt : header.timestamp
    assert.deepEqual(session.createdAt, created === undefined ? undefined : { format: typeof created === 'number' ? 'unix_millis' : 'rfc3339', value: created }, 'native createdAt')
    assert.equal(session.parentSessionId, provider === 'deepseek' ? header.parentSessionId ?? header.parentSession : undefined, 'native parent lineage')
  }
  const messages: { record: number, role: string, text: string[], model?: string }[] = []
  const usages: { record: number, usage: unknown }[] = []
  const message = (record: number, native: Row, content = native.content, model = native.model) => {
    if (native.role !== 'user' && native.role !== 'assistant')
      return
    if (content !== undefined)
      messages.push({ record, role: native.role, text: typeof content === 'string' ? [content] : textParts(content), ...(typeof model === 'string' && native.role === 'assistant' ? { model } : {}) })
    if ('usage' in native)
      usages.push({ record, usage: native.usage })
    else if ('metrics' in native)
      usages.push({ record, usage: native.metrics })
  }
  const time = (record: number, value: unknown) => {
    const expected = value === undefined || value === null ? undefined : { format: typeof value === 'number' ? 'unix_millis' : 'rfc3339', value }
    for (const event of session.events.filter(event => event.record === record))
      assert.deepEqual(event.timestamp, expected, `native timestamp at record ${record}`)
  }
  const infos = new Map<string, Row>()
  for (const [record, row] of inventory.rows.entries()) {
    if (['pi', 'droid'].includes(provider)) {
      time(record, row.timestamp)
      if (row.type === 'message')
        message(record, object(row.message))
    }
    else if (provider === 'qwen') {
      time(record, row.timestamp)
      if (row.type === 'user' || row.type === 'assistant') {
        const parts = object(row.message).parts
        assert(Array.isArray(parts))
        message(record, { role: row.type }, parts.map(part => ({ type: 'text', text: object(part).text })), row.model)
        if ('usageMetadata' in row)
          usages.push({ record, usage: row.usageMetadata })
      }
    }
    else if (provider === 'copilot') {
      time(record, row.timestamp)
      const data = object(row.data)
      if (row.type === 'user.message' || row.type === 'assistant.message')
        message(record, { role: row.type === 'user.message' ? 'user' : 'assistant' }, data.content, data.model)
      if (row.type === 'assistant.usage' || row.type === 'session.usage_checkpoint' || (row.type === 'session.shutdown' && ('modelMetrics' in data || 'tokenDetails' in data)))
        usages.push({ record, usage: data })
    }
    else if (provider === 'deepseek') {
      time(record, row.time ?? row.time0)
      const data = row.data === undefined ? {} : object(row.data)
      if (row.type === 'user/message' || row.type === 'assistant/message') {
        const native = row.type === 'user/message' ? data : object(data.message)
        message(record, { role: row.type === 'user/message' ? 'user' : 'assistant' }, native.content, native.source === undefined ? undefined : object(native.source).model)
        if ('usage' in data)
          usages.push({ record, usage: data.usage })
      }
    }
    else if (provider === 'cline' && Array.isArray(row.messages)) {
      for (const native of row.messages)
        message(record, object(native), object(native).content, object(native).model ?? (object(native).modelInfo === undefined ? undefined : object(object(native).modelInfo).id))
    }
    else if (provider === 'hermes' && row.role !== undefined) {
      const content = typeof row.content === 'string' && row.content.startsWith('\0json:') ? JSON.parse(row.content.slice(6)) as unknown : row.content
      message(record, row, content)
      time(record, typeof row.timestamp === 'number' ? Math.round(row.timestamp * 1000) : row.timestamp)
    }
    else if (provider === 'openclaw' && record > 0) {
      const text = typeof row.event_json === 'string' ? row.event_json : execFileSync('zstd', ['-d', '-c'], { input: row.event_zstd as Uint8Array, encoding: 'utf8' })
      const native = object(JSON.parse(text))
      time(record, native.type === 'message' ? native.timestamp ?? object(native.message).timestamp : row.timestamp)
      if (native.type === 'message')
        message(record, object(native.message))
    }
    else if (provider === 'opencode' && record > 0) {
      const native = object(JSON.parse(String(row.data)))
      time(record, row.time_created ?? object(native.time).created)
      if (typeof row.message_id !== 'string') {
        infos.set(String(row.id), native)
        if ('tokens' in native)
          usages.push({ record, usage: { tokens: native.tokens, cost: native.cost ?? null } })
      }
      else if (native.type === 'text') {
        const info = infos.get(row.message_id)
        assert(info, 'native part has no message metadata')
        message(record, { role: info.role }, native.text, info.modelID)
      }
      else if (native.type === 'step-finish') {
        usages.push({ record, usage: native })
      }
    }
    else if (provider === 'fx' && row.event !== undefined) {
      const event = object(row.event)
      const kind = Object.keys(event)[0]!
      const data = object(event[kind])
      time(record, row.timestamp_ms)
      if (['user', 'assistant', 'steering'].includes(kind))
        message(record, { role: kind === 'assistant' ? 'assistant' : 'user' }, data.text)
    }
    else if (['grok', 'acp'].includes(provider)) {
      const params = row.params === undefined ? {} : object(row.params)
      if (row.method === 'session/update') {
        const update = object(params.update)
        if (['user_message_chunk', 'agent_message_chunk'].includes(String(update.sessionUpdate)))
          message(record, { role: update.sessionUpdate === 'agent_message_chunk' ? 'assistant' : 'user' }, [object(update.content)])
        if (update.sessionUpdate === 'usage_update')
          usages.push({ record, usage: update })
      }
      if (row.method === 'session/prompt' && Array.isArray(params.prompt))
        message(record, { role: 'user' }, params.prompt)
    }
    else if (provider === 'oar' && row.kind === 'record') {
      const native = object(row.record)
      const body = object(native.body)
      time(record, native.receivedAt)
      if (native.kind === 'request' && native.direction === 'toRuntime' && ['prompt', 'steer', 'queue'].includes(String(body.kind)))
        message(record, { role: 'user' }, body.input)
      if (Array.isArray(body.events)) {
        for (const event of body.events) {
          const item = object(event)
          if (item.kind === 'text_delta')
            message(record, { role: 'assistant' }, item.text)
          if (item.kind === 'user_message')
            message(record, { role: 'user' }, item.input)
          if (item.kind === 'usage')
            usages.push({ record, usage: item.usage })
        }
      }
    }
  }
  for (const role of ['user', 'assistant']) {
    const expected = messages.filter(message => message.role === role).flatMap(({ record, text, model }) => text.map(text => ({ record, text, ...(model === undefined ? {} : { model }) })))
    const actual = session.events.flatMap(event => event.type === `${role}_message` && (event.type === 'user_message' || event.type === 'assistant_message')
      ? event.data.content.map((block) => {
          assert.equal(block.type, 'text', 'unreviewed live message content')
          return { record: event.record, text: block.data, ...('model' in event.data ? { model: event.data.model } : {}) }
        })
      : [])
    assert.deepEqual(actual, expected, `native ${role} text/model/record association`)
  }
  assert.deepEqual(session.events.flatMap(event => event.type === 'usage' ? [{ record: event.record, usage: event.data.usage }] : []), usages, 'native usage payload/record association')
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
  const statePath = provider === 'fx' ? path : join(dirname(path), 'summary.json')
  const stateText = await readFile(statePath, 'utf8')
  const state = object(JSON.parse(stateText))
  const content = await readFile(provider === 'fx' ? join(dirname(path), 'events.jsonl') : path, 'utf8')
  const physical = physicalEvidence(provider === 'fx' ? join(dirname(path), 'events.jsonl') : path, content)
  const rows = [state, ...physical.map(row => object(JSON.parse(row.text)))]
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
  return { path, id, rows, texts, evidence: [{ path: statePath, text: stateText }, ...physical], assertRecords(session) {
    assert.deepEqual(session.records.map(record => record.native), rows)
  } }
}

async function recordingInventory(provider: string, root: string): Promise<Inventory> {
  const path = join(root, provider === 'acp' ? 'session.acp.jsonl' : 'session.voyage.jsonl')
  const content = await readFile(path, 'utf8')
  const evidence = physicalEvidence(path, content)
  const rows = evidence.map(row => object(JSON.parse(row.text)))
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
  return { path, id, rows, texts, evidence, assertRecords(session) {
    assert.deepEqual(session.records.map(record => record.native), rows)
  } }
}
