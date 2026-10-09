import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { Session } from '../src/index.ts'
import { sessions } from '../src/index.ts'
import { activeProviders, manifest, selectProviders } from '../tools/producer-compat/catalog.ts'
import { assertDiscovery, assertNativeRead, assertSubagentScenario, inventoryNativeStores } from '../tools/producer-compat/claude.ts'
import { assertCodexRead, assertCodexScenario } from '../tools/producer-compat/codex.ts'
import { assertKimiReplies } from '../tools/producer-compat/kimi.ts'
import { laneResult, renderCompatibilitySummary, renderDailyReport } from '../tools/producer-compat/report.ts'
import { assertNoProducerDrift, NativeDriftError, nativeFieldPaths } from '../tools/producer-compat/runtime.ts'

await test('independent native inventory detects omissions hidden by the old summary', async () => {
  const home = await mkdtemp(join(tmpdir(), 'huihua-audit-test-'))
  try {
    const directory = join(home, '.claude', 'projects', 'test')
    await mkdir(directory, { recursive: true })
    const row = { type: 'user', sessionId: 'one', uuid: 'repeated', timestamp: '2026-01-01T00:00:00Z', cwd: '/synthetic', message: { content: 'same' }, newField: { retained: 1 } }
    const path = join(directory, 'one.jsonl')
    // Repeated IDs and a blank physical line must not erase evidence or change line numbers.
    await writeFile(path, `${JSON.stringify(row)}\n\n${JSON.stringify(row)}\n`)
    const stores = await inventoryNativeStores(home)
    const scan = await sessions.scan({ providers: ['claude'], homeDir: home })
    assertDiscovery(stores, scan, ['one'])
    const session = await sessions.read(scan.refs[0]!)
    assertNativeRead(stores[0]!, session)
    const summary = { unknown: {}, structured: 0, fieldPaths: nativeFieldPaths(stores, false) }
    // Reproduction: deleting a same-shape row leaves the old verdict unchanged.
    const dropped = [{ ...stores[0]!, rows: stores[0]!.rows.slice(1) }]
    assertNoProducerDrift({ ...summary, fieldPaths: nativeFieldPaths(dropped, false) }, summary)
    const mutations: [string, (input: Session) => Session][] = [
      ['drop record', input => ({ ...input, records: input.records.slice(1) })],
      ['duplicate record', input => ({ ...input, records: [...input.records, input.records[0]!] })],
      ['drop field', input => ({ ...input, records: input.records.map((record, i) => i ? record : { ...record, native: { ...row, newField: undefined } }) })],
      ['raw text', input => ({ ...input, records: input.records.map(record => ({ ...record, text: '{}' })) })],
      ['wrong line', input => ({ ...input, records: input.records.map(record => ({ ...record, source: { ...record.source, position: 1 } })) })],
      ['drop event', input => ({ ...input, events: input.events.slice(1) })],
      ['wrong association', input => ({ ...input, events: input.events.map(event => ({ ...event, record: 0 })) })],
      ['wrong time', input => ({ ...input, events: input.events.map(event => ({ ...event, timestamp: { format: 'rfc3339' as const, value: 'wrong' } })) })],
      ['wrong identity', input => ({ ...input, id: 'other' })],
    ]
    for (const [name, mutate] of mutations)
      assert.throws(() => assertNativeRead(stores[0]!, mutate(session)), /./, name)
    assert.throws(() => assertDiscovery(stores, { ...scan, refs: [] }, ['one']), /discovery/)
    assert.throws(() => assertDiscovery(stores, { ...scan, refs: [...scan.refs, ...scan.refs] }, ['one']), /discovery/)
    assert.throws(() => assertDiscovery(stores, { ...scan, refs: scan.refs.map(ref => ({ ...ref, id: 'wrong' })) }, ['one']), /discovery/)
    assert.throws(() => assertDiscovery(stores, scan, ['one', 'missing']), /producer inventory/)
    await writeFile(join(directory, 'new.jsonl'), '{"new_private_store":true}\n')
    await assert.rejects(inventoryNativeStores(home), /unclassified/)
  }
  finally { await rm(home, { recursive: true, force: true }) }
})

await test('same-record semantic checks reject loss even when raw evidence is intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-audit-facts-'))
  try {
    const path = join(root, 'facts.jsonl')
    const native = [
      { type: 'assistant', sessionId: 'facts', uuid: 'call', message: { model: 'synthetic', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: '/synthetic' } }], usage: { input_tokens: 3, nested: { future: 7 } } } },
      { type: 'user', sessionId: 'facts', uuid: 'result', parentUuid: 'call', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'exact result', is_error: false }] } },
      { type: 'assistant', sessionId: 'facts', message: { content: [{ type: 'text', text: 'exact text' }], model: 'synthetic' } },
      { type: 'future_private', sessionId: 'facts', payload: { value: 1 } },
    ]
    await writeFile(path, native.map(row => JSON.stringify(row)).join('\n'))
    const stores = await inventoryNativeStores(root)
    const scan = await sessions.scan({ providers: ['claude'], roots: { claude: [root] } })
    const session = await sessions.read(scan.refs[0]!)
    assertNativeRead(stores[0]!, session)
    for (const type of ['tool_call', 'tool_result', 'assistant_message', 'usage', 'unknown']) {
      const modified = { ...session, events: session.events.map(event => event.type === type ? { ...event, data: {} } : event) } as Session
      assert.throws(() => assertNativeRead(stores[0]!, modified), /./, type)
    }
    const swapped = { ...session, records: [session.records[1]!, session.records[0]!, ...session.records.slice(2)] }
    assert.throws(() => assertNativeRead(stores[0]!, swapped))
    const altered = structuredClone(stores)
    altered[0]!.rows[0]!.native.extra = 1
    altered[0]!.rows[1]!.native.extra = 'one'
    const changed = structuredClone(altered)
    changed[0]!.rows[0]!.native.extra = 'one'
    changed[0]!.rows[1]!.native.extra = 1
    assert.deepEqual(nativeFieldPaths(altered, false), nativeFieldPaths(changed, false))
    assert.notDeepEqual(nativeFieldPaths(altered), nativeFieldPaths(changed))
    assert.throws(() => assertNoProducerDrift(
      { unknown: {}, structured: 0, fieldPaths: [], groupedFieldPaths: nativeFieldPaths(changed) },
      { unknown: {}, structured: 0, fieldPaths: [], groupedFieldPaths: nativeFieldPaths(altered) },
    ), /per-record-type/)
    assert.throws(() => assertNativeRead(stores[0]!, { ...session, diagnostics: [] }), /diagnostics/)
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

await test('Claude native audit distinguishes parent and child identity and checks companion evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-audit-subagents-'))
  try {
    const path = join(root, 'parent', 'subagents', 'agent-child.jsonl')
    const companion = path.replace('.jsonl', '.meta.json')
    await mkdir(join(root, 'parent', 'subagents'), { recursive: true })
    const metadata = { agentType: 'general-purpose', description: 'Synthetic child', toolUseId: 'spawn', spawnDepth: 1, requestShape: 'foreground', requestNonInteractive: true }
    await writeFile(companion, JSON.stringify(metadata))
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'child-user', sessionId: 'parent', agentId: 'child', isSidechain: true, message: { content: 'task' } })}\n`)
    const stores = await inventoryNativeStores(root)
    assert.equal(stores[0]!.id, 'child')
    const scan = await sessions.scan({ providers: ['claude'], roots: { claude: [root] } })
    assertDiscovery(stores, scan, ['child'])
    const session = await sessions.read(scan.refs[0]!)
    assertNativeRead(stores[0]!, session)
    assert.throws(() => assertNativeRead(stores[0]!, { ...session, id: 'parent' }), /session id/)
    assert.throws(() => assertNativeRead(stores[0]!, { ...session, parentSessionId: 'foreign' }), /parentSessionId/)
    assert.throws(() => assertNativeRead(stores[0]!, { ...session, metadata: { ...session.metadata, subagent: {} } }), /companion/)
    assert.throws(() => assertNativeRead(stores[0]!, { ...session, records: session.records.slice(1) }), /record count/)
    const wrongSource = { ...session, records: session.records.map((record, index) => index ? record : { ...record, source: { path: 'wrong' } }) }
    assert.throws(() => assertNativeRead(stores[0]!, wrongSource), /source/)
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

await test('Claude subagent journey rejects absent children and broken native spawn references', () => {
  type Stores = Awaited<ReturnType<typeof inventoryNativeStores>>
  const rows = (native: Record<string, unknown>[]) => native.map((value, index) => ({ native: value, text: JSON.stringify(value), position: index + 1 }))
  const stores: Stores = [{ path: '/synthetic/parent.jsonl', id: 'parent', rows: [] }]
  for (const [index, ordinal] of ['FIRST', 'SECOND'].entries()) {
    const id = `child-${index}`
    const callId = `huihua_spawn_${index + 1}`
    const description = `${index === 0 ? 'First' : 'Second'} synthetic compatibility child`
    const prompt = `HUIHUA_CHILD_${ordinal}`
    const reply = `${prompt}_REPLY`
    stores[0]!.rows.push(...rows([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: callId, name: 'Agent', input: { description, prompt, subagent_type: 'general-purpose', run_in_background: false } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: callId, content: reply }] }, toolUseResult: { agentId: id, status: 'completed' } },
    ]))
    stores.push({ path: `/synthetic/parent/subagents/agent-${id}.jsonl`, id, parentSessionId: 'parent', rows: rows([
      { type: 'user', message: { content: prompt } },
      { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } },
    ]), companion: { path: `/synthetic/parent/subagents/agent-${id}.meta.json`, text: '', native: { agentType: 'general-purpose', description, toolUseId: callId, spawnDepth: 1, requestShape: 'foreground', requestNonInteractive: true } } })
  }
  stores[0]!.rows.push(...rows([{ type: 'assistant', message: { content: 'HUIHUA_SUBAGENTS_COMPLETE' } }]))
  assert.deepEqual(assertSubagentScenario(stores, 'parent'), ['child-0', 'child-1'])
  const mutations: [string, (input: Stores) => void][] = [
    ['missing child', input => input.pop()],
    ['colliding identity', (input) => { input[1]!.id = 'parent' }],
    ['wrong parent', (input) => { input[1]!.parentSessionId = 'foreign' }],
    ['missing companion', (input) => { delete input[1]!.companion }],
    ['wrong spawn reference', (input) => { input[1]!.companion!.native.toolUseId = 'foreign' }],
    ['missing child reply', (input) => { input[1]!.rows.pop() }],
    ['missing parent call', (input) => { input[0]!.rows.shift() }],
    ['failed tool result', (input) => { input[0]!.rows[1]!.native.message = { content: [{ type: 'tool_result', tool_use_id: 'huihua_spawn_1', content: 'HUIHUA_CHILD_FIRST_REPLY', is_error: true }] } }],
    ['wrong result agent', (input) => { input[0]!.rows[1]!.native.toolUseResult = { agentId: 'foreign', status: 'completed' } }],
    ['swapped sibling results', (input) => {
      input[0]!.rows[1]!.native.toolUseResult = { agentId: 'child-1', status: 'completed' }
      input[0]!.rows[3]!.native.toolUseResult = { agentId: 'child-0', status: 'completed' }
    }],
    ['unfinished agent', (input) => { input[0]!.rows[1]!.native.toolUseResult = { agentId: 'child-0', status: 'running' } }],
  ]
  for (const [name, mutate] of mutations) {
    const copy = structuredClone(stores)
    mutate(copy)
    assert.throws(() => assertSubagentScenario(copy, 'parent'), /subagent scenario/, name)
  }
})

await test('Kimi native reply oracle rejects missing, duplicated and changed assistant content', async () => {
  const messages = ['HUIHUA_KIMI_REPLY', 'HUIHUA_KIMI_RESUMED'].map(text => ({ role: 'assistant', content: [{ type: 'text', text }] }))
  const rows = messages.map(message => ({ type: 'agent.message.appended', message: { message } }))
  // Obtain a valid output shape with the older supported record vocabulary.
  const session = await sessions.parse('kimi', { jsonl: messages.map(message => JSON.stringify({ type: 'context.append_message', message })).join('\n') })
  assertKimiReplies(rows, session.events)
  assert.throws(() => assertKimiReplies(rows, []), /assistant replies/)
  assert.throws(() => assertKimiReplies(rows, session.events.slice(1)), /assistant replies/)
  assert.throws(() => assertKimiReplies(rows, [...session.events, ...session.events]), /assistant replies/)
  assert.throws(() => assertKimiReplies(rows, [...session.events].reverse()), /assistant replies/)
  assert.throws(() => assertKimiReplies([], session.events), /must persist/)
})

await test('Codex audit catches raw loss, missing replies and tool association errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'huihua-codex-audit-'))
  try {
    const path = join(directory, 'rollout.jsonl')
    const timestamp = '2026-01-01T00:00:00Z'
    const native = [
      { type: 'session_meta', timestamp, payload: { id: 'codex-test', cwd: directory } },
      { type: 'response_item', timestamp, payload: { type: 'function_call', call_id: 'huihua_codex_read', name: 'exec_command', arguments: '{"cmd":"cat synthetic.txt"}' } },
      { type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: 'huihua_codex_read', output: 'HUIHUA_CODEX_TOOL_RESULT' } },
      ...['HUIHUA_CODEX_REPLY', 'HUIHUA_CODEX_RESUMED'].map(text => ({ type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })),
      { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1, output_tokens: 2 } } } },
    ]
    const rows = native.map((value, index) => ({ native: value, text: `${JSON.stringify(value)}\n`, position: index + 1 }))
    await writeFile(path, rows.map(row => row.text).join(''))
    const scan = await sessions.scan({ providers: ['codex'], roots: { codex: [directory] } })
    const session = await sessions.read(scan.refs[0]!)
    const store = { path, id: 'codex-test', rows }
    assertCodexRead(store, session)
    assertCodexScenario(store, session)
    assert.throws(() => assertCodexRead(store, { ...session, records: session.records.slice(1) }), /record count/)
    assert.throws(() => assertCodexRead(store, { ...session, events: session.events.filter(event => event.type !== 'assistant_message') }), /no event|text lost/)
    assert.throws(() => assertCodexRead(store, { ...session, events: session.events.map(event => event.type === 'tool_result' ? { ...event, data: { ...event.data, callId: 'wrong' } } : event) }))
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('reviewed optional paths accept new metadata without hiding type drift or required-field loss', () => {
  const baseline = { unknown: {}, structured: 0, fieldPaths: ['$.message:object'], optionalFieldPaths: ['$.permissionDecision:object', '$.permissionDecision.decision:string'] }
  assertNoProducerDrift(baseline, baseline)
  assertNoProducerDrift({ ...baseline, fieldPaths: [...baseline.fieldPaths, ...baseline.optionalFieldPaths] }, baseline)
  assert.throws(() => assertNoProducerDrift({ ...baseline, fieldPaths: ['$.message:object', '$.permissionDecision.decision:number'] }, baseline), (error: unknown) => {
    assert(error instanceof NativeDriftError)
    assert.deepEqual(error.drift, { added: ['$.permissionDecision.decision:number'], removed: [] })
    return true
  })
  assert.throws(() => assertNoProducerDrift({ ...baseline, fieldPaths: [] }, baseline), (error: unknown) => {
    assert(error instanceof NativeDriftError)
    assert.deepEqual(error.drift, { added: [], removed: ['$.message:object'] })
    return true
  })
})

await test('provider manifest covers the registry without turning blocked or partial journeys green', () => {
  assert.deepEqual(manifest.providers.map(provider => provider.id).sort(), sessions.providers().map(provider => provider.id).sort())
  assert.equal(new Set(manifest.providers.map(provider => provider.id)).size, manifest.providers.length)
  assert.match(manifest.simulator.commit, /^[a-f\d]{40}$/)
  for (const provider of manifest.providers) {
    if (provider.ci) {
      assert(provider.install !== undefined)
      assert(provider.checks.includes('read'))
      assert(provider.runner !== undefined)
    }
    else {
      assert(provider.reason !== undefined && provider.reason.length > 20)
      assert.deepEqual(provider.checks, [])
    }
  }
  const partial = { stage: 'passed', completed: ['scan', 'read', 'snapshot', 'records', 'events'], auditedSessions: 1, auditedRecords: 2 }
  assert.equal(laneResult('cline', 'pinned', '3.0.70', 'test', 'success', partial).verdict, 'incomplete')
  const complete = { ...partial, completed: [...partial.completed, 'scenario'] }
  const summary = renderCompatibilitySummary(complete, 'success', 'cline')
  assert.match(summary, /first-turn store only/)
  assert.doesNotMatch(summary, /Text \/ tool roundtrip \/ resume.*PASS/)
  assert.doesNotMatch(summary, /Native shape.*PASS/)
  const report = renderDailyReport([], '2026-10-08', 'https://github.com/wibus-wee/huihua/actions', 'test')
  assert.match(report, /cursor: NOT CERTIFIED|cursor\*\*: NOT CERTIFIED/)
  assert.match(report, new RegExp(`0/${activeProviders.length * 2} covered lanes passed`))
})

await test('path scopes and manual labels never shrink required provider coverage', () => {
  const all = activeProviders.map(provider => provider.id)
  assert.deepEqual(selectProviders(['docs/guide.md', 'README.md', 'src/providers/fx/RESEARCH.md']).providers, [])
  assert.deepEqual(selectProviders(['packages/usage/src/cli.ts']).providers, [])
  assert.deepEqual(selectProviders(['tests/provider-imports.test.ts', 'tools/policy.ts']).providers, [])
  assert.deepEqual(selectProviders(['src/providers/pi/index.ts']).providers, ['pi'])
  assert.deepEqual(selectProviders(['fixtures/compatibility/qwen/new.jsonl', 'tools/producer-compat/baselines/claude.json']).providers, ['claude', 'qwen'])
  assert.deepEqual(selectProviders(['src/providers/pi/index.ts', 'src/providers/qwen/index.ts']).providers, ['pi', 'qwen'])
  for (const path of ['src/shared/jsonl.ts', 'src/contracts/event.ts', 'src/registry.ts', 'tools/producer-compat/manifest.json', 'tools/producer-compat/live.ts', 'pnpm-lock.yaml', 'new-unknown-reader.ts']) {
    assert.deepEqual(selectProviders([path]).providers, all, path)
  }
  assert.deepEqual(selectProviders(['src/providers/pi/index.ts'], ['ci:provider:qwen', 'ci:none']).providers, ['pi', 'qwen'])
  assert.deepEqual(selectProviders(['docs/guide.md'], ['ci:all']).providers, all)
  assert.deepEqual(selectProviders(['docs/guide.md'], ['ci:provider:typo']).providers, all)
  assert.deepEqual(selectProviders([], [], true).providers, all)
  const blocked = selectProviders(['src/providers/cursor/index.ts'])
  assert.deepEqual(blocked.providers, [])
  assert.deepEqual(blocked.unavailable, ['cursor'])
  assert(blocked.scopeLabels.includes('scope:provider:cursor'))
})

await test('provider-local manifest differences select only affected native checks', () => {
  const path = 'tools/producer-compat/manifest.json'
  const changed = structuredClone(manifest)
  changed.providers.find(provider => provider.id === 'fx')!.gaps = ['resolved failure; tool coverage remains incomplete']
  const changes = { before: manifest, after: changed }
  const select = (delta: typeof changes) => selectProviders([path], [], false, delta)
  assert.deepEqual(select(changes).providers, ['fx'])
  assert.deepEqual(selectProviders([path], ['ci:provider:qwen'], false, changes).providers, ['fx', 'qwen'])
  assert.deepEqual(selectProviders(['src/providers/fx/index.ts', 'fixtures/fx/current/events.jsonl', 'tests/provider-imports.test.ts', 'tools/policy.ts', path], [], false, changes).providers, ['fx'])
  assert.deepEqual(select({ before: manifest, after: structuredClone(manifest) }).providers, [])
  const global = structuredClone(manifest)
  global.simulator.commit = '0'.repeat(40)
  assert.equal(select({ before: manifest, after: global }).full, true)
  const routing = structuredClone(manifest)
  routing.providers.find(provider => provider.id === 'fx')!.paths.prefixes.push('other/')
  assert.equal(select({ before: manifest, after: routing }).full, true)
  const inventory = structuredClone(manifest)
  inventory.providers.pop()
  assert.equal(select({ before: manifest, after: inventory }).full, true)
  assert.equal(selectProviders([path], [], false, { before: null, after: manifest }).full, true)
  const two = structuredClone(changed)
  two.providers.find(provider => provider.id === 'pi')!.install!.version = 'synthetic-version'
  assert.deepEqual(select({ before: manifest, after: two }).providers, ['fx', 'pi'])
  const blocked = structuredClone(manifest)
  blocked.providers.find(provider => provider.id === 'cursor')!.reason = 'synthetic changed blocker'
  assert.deepEqual(select({ before: manifest, after: blocked }).unavailable, ['cursor'])
})

await test('real git comparison handles doc-only changes, cross-provider renames and missing bases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'huihua-scope-test-'))
  const catalog = fileURLToPath(new URL('../tools/producer-compat/catalog.ts', import.meta.url))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = () => {
    git('add', '.')
    git('-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'synthetic change')
    return git('rev-parse', 'HEAD')
  }
  const selected = async (before: string, after: string, pr = false) => {
    const eventPath = join(directory, 'event.json')
    await writeFile(eventPath, JSON.stringify(pr ? { pull_request: { number: 1, base: { sha: before }, head: { sha: after }, labels: [] } } : { before, after }))
    const output = execFileSync(process.execPath, [catalog, 'matrix'], { cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GITHUB_EVENT_NAME: pr ? 'pull_request' : 'push', GITHUB_EVENT_PATH: eventPath } })
    return (JSON.parse(output) as { id: string }[]).map(provider => provider.id)
  }
  try {
    git('init', '-q')
    await mkdir(join(directory, 'tools/producer-compat'), { recursive: true })
    const manifestPath = join(directory, 'tools/producer-compat/manifest.json')
    await writeFile(manifestPath, JSON.stringify(manifest))
    await mkdir(join(directory, 'src/providers/pi'), { recursive: true })
    await writeFile(join(directory, 'src/providers/pi/index.ts'), '// synthetic\n')
    await writeFile(join(directory, 'README.md'), 'Before\n')
    const first = commit()
    await writeFile(join(directory, 'README.md'), 'After\n')
    const docs = commit()
    assert.deepEqual(await selected(first, docs), [])
    // event.json is test transport, not a repository change.
    await rm(join(directory, 'event.json'))
    await mkdir(join(directory, 'src/providers/qwen'), { recursive: true })
    await rename(join(directory, 'src/providers/pi/index.ts'), join(directory, 'src/providers/qwen/index.ts'))
    const renamed = commit()
    assert.deepEqual(await selected(docs, renamed), ['pi', 'qwen'])
    assert.deepEqual(await selected('0'.repeat(40), renamed), activeProviders.map(provider => provider.id))
    await rm(join(directory, 'event.json'))
    const fx = structuredClone(manifest)
    fx.providers.find(provider => provider.id === 'fx')!.gaps = ['remaining tool coverage gap']
    await writeFile(manifestPath, JSON.stringify(fx))
    await mkdir(join(directory, 'src/providers/fx'), { recursive: true })
    await mkdir(join(directory, 'tests'))
    await writeFile(join(directory, 'src/providers/fx/index.ts'), '// fx fix\n')
    await writeFile(join(directory, 'tests/provider-imports.test.ts'), '// fx regression\n')
    await writeFile(join(directory, 'tools/policy.ts'), '// fx policy\n')
    const fxCommit = commit()
    assert.deepEqual(await selected(renamed, fxCommit), ['fx'])
    await rm(join(directory, 'event.json'))
    fx.simulator.commit = '1'.repeat(40)
    await writeFile(manifestPath, JSON.stringify(fx))
    const global = commit()
    assert.deepEqual(await selected(fxCommit, global), activeProviders.map(provider => provider.id))
    await rm(join(directory, 'event.json'))
    await writeFile(manifestPath, '{broken')
    const malformed = commit()
    assert.deepEqual(await selected(global, malformed), activeProviders.map(provider => provider.id))
    await rm(join(directory, 'event.json'))
    git('checkout', '-qb', 'base-side', renamed)
    const advanced = structuredClone(manifest)
    advanced.providers.find(provider => provider.id === 'pi')!.install!.version = 'synthetic-new-base'
    await writeFile(manifestPath, JSON.stringify(advanced))
    const advancedBase = commit()
    // Main advanced independently; its Pi change is not part of the fx PR diff.
    assert.deepEqual(await selected(advancedBase, fxCommit, true), ['fx'])
  }
  finally { await rm(directory, { recursive: true, force: true }) }
})
