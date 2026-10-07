import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { it } from 'node:test'
import { pathToFileURL } from 'node:url'

import { parseUsageArgs } from '../packages/usage/src/options.ts'
import { createUsageReport, formatUsageReport, UsageReportBuilder } from '../packages/usage/src/report.ts'
import type { SessionFrame, Timestamp } from '../src/index.ts'
import { sessions } from '../src/index.ts'
import { acpProvider } from '../src/providers/acp/index.ts'
import { claudeProvider } from '../src/providers/claude/index.ts'
import { codexProvider } from '../src/providers/codex/index.ts'
import { piProvider } from '../src/providers/pi/index.ts'
import { cases, fixtureRoot } from './oracle.ts'

function framesOf(session: { records: readonly import('../src/index.ts').RawRecord[], events: readonly import('../src/index.ts').SessionEvent[] }): SessionFrame[] {
  return session.records.flatMap(record => [
    { type: 'record' as const, record },
    ...session.events.filter(event => event.record === record.sequence).map(event => ({ type: 'event' as const, event })),
  ])
}

void it('usage CLI report is a daily token and model report rather than native observations', () => {
  const report = createUsageReport([], new Map(), { providerIds: ['claude'] })
  assert.equal(report.schema, 'huihua-usage/v2')
  assert.ok('daily' in report)
  assert.ok('totals' in report)
  assert.ok(!('nativeTokenFields' in report.providers[0]!))
})

void it('usage CLI accepts the leading argument separator forwarded by pinned pnpm start', () => {
  const argv = ['--', '--workers', '4', '--help']
  assert.equal(parseUsageArgs(argv).workers, 4)
  const output = execFileSync(process.execPath, ['packages/usage/dist/cli.js', ...argv], { encoding: 'utf8' })
  assert.ok(output.includes('--workers 1|2|4'))
})

function key(ref: { provider: string, source: unknown }): string {
  return JSON.stringify([ref.provider, ref.source])
}

void it('usage CLI rejects incomplete discovery instead of printing totals for only readable sources', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-usage-scan-failure-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const projects = join(root, '.claude/projects/test')
  await mkdir(projects, { recursive: true })
  await writeFile(join(projects, 'valid.jsonl'), await readFile(resolve('fixtures/claude/usage-only.jsonl')))
  const store = join(root, '.local/share/opencode')
  await mkdir(store, { recursive: true })
  await writeFile(join(store, 'opencode.db'), Buffer.from([0xFF, 0x0A]))
  const discovery = await sessions.scan({ providers: ['claude', 'opencode'], homeDir: root })
  assert.equal(discovery.refs.length, 1)
  assert.equal(discovery.failures.length, 1)
  const env = { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: join(root, '.claude'), XDG_CONFIG_HOME: join(root, '.config'), XDG_DATA_HOME: join(root, '.local/share'), CLAUDE_CONFIG_DIRS: '' }
  for (const workers of ['1', '4']) {
    const result = spawnSync(process.execPath, ['packages/usage/dist/cli.js', '--provider', 'claude', '--provider', 'opencode', '--json', '--workers', workers], { env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /incomplete usage discovery.*opencode.*opencode\.db/i)
  }
})

void it('all usage tuning paths retain timezone/undated/duplicate/late-parent facts and buffered fallback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-usage-tuning-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const projects = join(root, '.claude/projects/test')
  await mkdir(projects, { recursive: true })
  const base = JSON.parse((await readFile(resolve('fixtures/claude/usage-only.jsonl'), 'utf8')).split('\n')[0]!) as {
    message: { model?: string }
  }
  for (let file = 0; file < 6; file++) {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      ...base,
      sessionId: `session-${file}`,
      uuid: `row-${file}-${index}`,
      requestId: `request-${index}`,
      timestamp: index === 3 ? null : index % 2 === 0 ? '2026-01-01T17:00:00Z' : '2026-01-02T17:00:00Z',
      ...(index === 9 ? { parentSessionId: 'native-parent' } : {}),
      message: { ...base.message, id: `message-${index}`, model: file === 0 ? null : `model-${file}` },
    }))
    await writeFile(join(projects, `${file}.jsonl`), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
  }
  const store = join(root, 'data/opencode')
  await mkdir(store, { recursive: true })
  await writeFile(join(store, 'opencode.db'), await readFile(resolve('fixtures/opencode/simple.db')))
  const env = { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: join(root, '.claude'), XDG_CONFIG_HOME: join(root, '.config'), XDG_DATA_HOME: join(root, 'data') }
  const argv = ['--provider', 'claude', '--provider', 'opencode', '--since', '2026-01-02', '--until', '2026-01-02', '--timezone', 'Asia/Shanghai', '--json']
  const expected = execFileSync(process.execPath, ['packages/usage/dist/cli.js', ...argv], { env, encoding: 'utf8' })
  for (const count of ['2', '4'])
    assert.equal(execFileSync(process.execPath, ['packages/usage/dist/cli.js', ...argv, '--workers', count], { env, encoding: 'utf8' }), expected)
  const cli = pathToFileURL(resolve('packages/usage/dist/cli.js')).href
  const options = [
    { facts: false, batchDecode: false, pushdown: false, concurrency: 1 },
    { facts: true, pushdown: false },
    { batchDecode: true },
    { facts: true, pushdown: true },
    { concurrency: 2 },
    { concurrency: 4 },
    { facts: true, pushdown: true, batchDecode: true, concurrency: 4 },
    { workers: 2 },
    { workers: 4, facts: true, pushdown: true },
  ]
  for (const [index, execution] of options.entries()) {
    const wrapper = join(root, `run-${index}.mjs`)
    await writeFile(wrapper, `import {run} from ${JSON.stringify(cli)};\nawait run(process.argv.slice(2),true,${JSON.stringify(execution)});\n`)
    assert.equal(execFileSync(process.execPath, [wrapper, ...argv], { env, encoding: 'utf8' }), expected)
  }
  const report = JSON.parse(expected) as { undatedUsageEventCount: number, providers: { provider: string, diagnostics: string[] }[] }
  assert.ok(report.undatedUsageEventCount >= 6)
  assert.ok(report.providers.find(provider => provider.provider === 'claude')?.diagnostics.some(message => message.startsWith('Repeated response identity')))
})

void it('concurrent usage aborts and closes every started source before reporting a failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-usage-concurrent-error-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const projects = join(root, '.claude/projects/test')
  await mkdir(projects, { recursive: true })
  const native = await readFile(resolve('fixtures/claude/usage-only.jsonl'), 'utf8')
  for (let index = 0; index < 8; index++)
    await writeFile(join(projects, `${index}.jsonl`), native + (index === 2 ? `${JSON.stringify({ padding: 'x'.repeat(1024) })}\n` : native))
  const wrapper = join(root, 'failure.mjs')
  await writeFile(wrapper, `
    import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer';
    import {readdir,readlink} from 'node:fs/promises';
    import {run} from ${JSON.stringify(pathToFileURL(resolve('packages/usage/dist/cli.js')).href)};
    await assert.rejects(run(process.argv.slice(2),true,{facts:true,pushdown:true,batchDecode:true,concurrency:4,maxRecordBytes:512}),/exceeds 512 bytes/);
    if(process.platform==='linux'){
      const paths=await Promise.all((await readdir('/proc/self/fd')).map(fd=>readlink('/proc/self/fd/'+fd).catch(()=>'')));
      assert.ok(paths.every(path=>!path.startsWith(${JSON.stringify(projects)})));
    }
    process.stdout.write('closed\\n');
  `)
  const env = { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: join(root, '.claude'), XDG_CONFIG_HOME: join(root, '.config') }
  assert.equal(execFileSync(process.execPath, [wrapper, '--provider', 'claude', '--json'], { env, encoding: 'utf8' }), 'closed\n')
  const threaded = join(root, 'worker-failure.mjs')
  await writeFile(threaded, `
    import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer';
    import {run} from ${JSON.stringify(pathToFileURL(resolve('packages/usage/dist/cli.js')).href)};
    await assert.rejects(run(process.argv.slice(2),true,{workers:4,maxRecordBytes:512}),/exceeds 512 bytes|sibling failed/);
    process.stdout.write('closed\\n');
  `)
  assert.equal(execFileSync(process.execPath, [threaded, '--provider', 'claude', '--json'], { env, encoding: 'utf8', timeout: 10_000 }), 'closed\n')
})

void it('compact partitions retain fixture arithmetic, overflow and cross-partition identities', async () => {
  const refs = []
  const sources = new Map<string, SessionFrame[]>()
  for (const fixture of await cases()) {
    const provider = fixture.provider === 'claude_code' ? 'claude' : fixture.provider
    const { refs: found } = await sessions.scan({ providers: [provider], roots: { [provider]: [resolve(fixtureRoot, fixture.path)] }, homeDir: fixtureRoot })
    for (const ref of found) {
      if (sources.has(key(ref)))
        continue
      refs.push(ref)
      const frames: SessionFrame[] = []
      for await (const frame of (await sessions.open(ref)).stream()) frames.push(frame)
      sources.set(key(ref), frames)
    }
  }
  const options = { providerIds: [...new Set(refs.map(ref => ref.provider))], timeZone: 'Asia/Shanghai' }
  const expected = createUsageReport(refs, sources, options)
  for (const size of [1, 7]) {
    const builder: UsageReportBuilder = new UsageReportBuilder(refs, options)
    for (let index = 0; index < refs.length; index += size) {
      const selected = refs.slice(index, index + size)
      const child = new UsageReportBuilder(selected, options)
      for (const ref of selected) {
        for (const frame of sources.get(key(ref))!) child.add(ref, frame)
        child.end(ref)
      }
      const partition = structuredClone(child.partition())
      assert.ok(partition.sessions.every(session => !('records' in session) && !('current' in session) && !('events' in session)))
      builder.importPartition(partition)
      assert.throws(() => builder.importPartition(partition), /repeated usage partition/)
    }
    assert.deepEqual(builder.finish(), expected)
  }
})

void it('partition transport preserves sticky overflow and validates session/identity references', () => {
  const refs = ['one', 'two', 'three'].map(id => ({ id, provider: 'claude', source: { path: id, format: 'jsonl' as const }, metadata: {} }))
  const frames = new Map(refs.map((ref, index) => [key(ref), [1, 2, 3].map((_, sequence): SessionFrame => ({
    type: 'event',
    event: { sequence, record: sequence, type: 'usage', timestamp: { format: 'rfc3339', value: '2026-01-01T00:00:00Z' }, providerMetadata: { native_usage_context: { model: 'fixture', message_id: 'same', request_id: 'same' } }, data: { usage: { input_tokens: index === 0 ? Number.MAX_SAFE_INTEGER : 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
  }))]))
  const expected = createUsageReport(refs, frames)
  const builder = new UsageReportBuilder(refs)
  for (const ref of refs) {
    const child = new UsageReportBuilder([ref])
    for (const frame of frames.get(key(ref))!) child.add(ref, frame)
    const partition = structuredClone(child.partition())
    assert.throws(() => builder.importPartition({ ...partition, identities: [['opaque', 'unknown']] }), /outside its usage partition/)
    builder.importPartition(partition)
  }
  assert.deepEqual(builder.finish(), expected)
  assert.equal(expected.totals.inputTokens, null)
  assert.ok(expected.sessions.every(session => session.diagnostics.some(message => message.startsWith('Repeated response identity'))))
})

void it('CPU workers preserve compressed Codex and malformed/unknown/interrupted Claude fixture reports', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-usage-worker-fixtures-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const claude = join(root, '.claude/projects/test')
  const codex = join(root, '.codex/sessions')
  await mkdir(claude, { recursive: true })
  await mkdir(codex, { recursive: true })
  for (const name of ['usage-only.jsonl', 'malformed.jsonl', 'unknown.jsonl', 'interrupted.jsonl', 'subagent.jsonl'])
    await writeFile(join(claude, name), await readFile(resolve(fixtureRoot, 'claude', name)))
  for (const name of ['simple.jsonl.zst', 'usage-records.jsonl', 'subagents.jsonl'])
    await writeFile(join(codex, name), await readFile(resolve(fixtureRoot, 'codex', name)))
  const env = { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: join(root, '.claude'), CODEX_HOME: join(root, '.codex'), XDG_CONFIG_HOME: join(root, '.config') }
  const cli = pathToFileURL(resolve('packages/usage/dist/cli.js')).href
  for (const bounds of [[], ['--since', '2026-01-01', '--until', '2026-01-01']]) {
    const argv = ['--provider', 'claude', '--provider', 'codex', '--timezone', 'America/Los_Angeles', '--json', ...bounds]
    const expected = execFileSync(process.execPath, ['packages/usage/dist/cli.js', ...argv], { env, encoding: 'utf8' })
    for (const [index, options] of [{ workers: 2 }, { workers: 4, facts: true, pushdown: true }].entries()) {
      const wrapper = join(root, `fixtures-${index}.mjs`)
      await writeFile(wrapper, `import {run} from ${JSON.stringify(cli)};\nawait run(process.argv.slice(2),true,${JSON.stringify(options)});\n`)
      assert.equal(execFileSync(process.execPath, [wrapper, ...argv], { env, encoding: 'utf8', timeout: 10_000 }), expected)
    }
  }
})

for (const fixture of await cases()) {
  const provider = fixture.provider === 'claude_code' ? 'claude' : fixture.provider
  if (provider !== 'claude' && provider !== 'codex')
    continue
  void it(`${fixture.path}: evidence-free usage and complete evidence produce identical daily/model reports`, async () => {
    const { refs } = await sessions.scan({ providers: [provider], roots: { [provider]: [resolve(fixtureRoot, fixture.path)] }, homeDir: fixtureRoot })
    for (const options of [{ timeZone: 'UTC' }, { timeZone: 'Asia/Shanghai', since: '2026-01-01', until: '2026-01-03' }]) {
      const full: UsageReportBuilder = new UsageReportBuilder(refs, { ...options, providerIds: [provider] })
      const light: UsageReportBuilder = new UsageReportBuilder(refs, { ...options, providerIds: [provider] })
      const direct: { pushdown: boolean, builder: UsageReportBuilder }[] = [false, true].map(pushdown => ({ pushdown, builder: new UsageReportBuilder(refs, { ...options, providerIds: [provider] }) }))
      for (const ref of refs) {
        const open = await sessions.open(ref)
        assert.ok(open.consumeUsage)
        for await (const frame of open.stream()) full.add(ref, frame)
        full.end(ref)
        await open.consumeUsage((frame) => {
          assert.notEqual(frame.type, 'record')
          light.add(ref, frame)
        })
        light.end(ref)
        assert.ok(open.consumeUsageFacts)
        for (const { pushdown, builder } of direct) {
          await open.consumeUsageFacts(item => builder.addFact(ref, item), pushdown
            ? { acceptTimestamp: timestamp => builder.acceptTimestamp(ref, timestamp) }
            : {})
          builder.end(ref)
        }
      }
      const expected = full.finish()
      assert.deepEqual(light.finish(), expected)
      for (const { builder } of direct)
        assert.deepEqual(builder.finish(), expected)
    }
  })
}

void it('recordless usage retains cross-store duplicate identity and absent model/time facts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-usage-identities-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const base = JSON.parse((await readFile(resolve('fixtures/claude/usage-only.jsonl'), 'utf8')).split('\n')[0]!) as {
    sessionId: string
    uuid: string
    timestamp?: string
    message: { model?: string }
  }
  const second = { ...base, sessionId: 'second-store-session', uuid: 'distinct-row', message: { ...base.message } }
  delete second.timestamp
  delete second.message.model
  await writeFile(join(root, 'first.jsonl'), `${JSON.stringify(base)}\n`)
  await writeFile(join(root, 'second.jsonl'), `${JSON.stringify(second)}\n`)
  const { refs } = await sessions.scan({ providers: ['claude'], roots: { claude: [root] } })
  assert.equal(refs.length, 2)
  const full = new UsageReportBuilder(refs, { providerIds: ['claude'] })
  const light = new UsageReportBuilder(refs, { providerIds: ['claude'] })
  for (const ref of refs) {
    const open = await sessions.open(ref)
    assert.ok(open.consumeUsage)
    for await (const frame of open.stream()) full.add(ref, frame)
    full.end(ref)
    await open.consumeUsage(frame => light.add(ref, frame))
    light.end(ref)
  }
  const report = light.finish()
  assert.deepEqual(report, full.finish())
  assert.equal(report.usageEventCount, 2)
  assert.equal(report.totals.outputTokens, 22, 'duplicate outer/advisor native counters remain in the sum')
  assert.ok(report.sessions.every(session => session.diagnostics.some(message => message.startsWith('Repeated response identity'))))
  assert.ok(report.daily.some(day => day.date === null && day.modelBreakdowns.some(model => model.model === null)))
})

void it('usage report sums Claude counters and explicit advisor models with date filters', async () => {
  const path = resolve('fixtures/claude/usage-only.jsonl')
  const parsed = await claudeProvider.parse({ jsonl: await readFile(path), source: path })
  const frames = new Map([[key(parsed), framesOf(parsed)]])
  const report = createUsageReport([parsed], frames, {
    since: '2026-01-01',
    until: '2026-01-01',
    timeZone: 'UTC',
  })
  assert.equal(report.usageEventCount, 1)
  assert.equal(report.undatedUsageEventCount, 1)
  assert.equal(report.sessions[0]?.usageEventCount, 1)
  assert.equal(report.sessions[0]?.source.path, path)
  assert.equal(report.providers[0]?.availability, 'partial')
  assert.equal(report.daily[0]?.outputTokens, 11)
  assert.equal(report.daily[0]?.totalTokens, 11)
  assert.equal(report.daily[0]?.inputTokens, null)
  assert.deepEqual(report.daily[0]?.modelsUsed, ['advisor-model', 'example-model'])
  assert.equal(report.daily[0]?.modelBreakdowns.find(model => model.model === 'example-model')?.outputTokens, 4)
  assert.equal(report.daily[0]?.modelBreakdowns.find(model => model.model === 'advisor-model')?.outputTokens, 7)
  const shiftedDay = createUsageReport([parsed], frames, {
    since: '2025-12-31',
    until: '2025-12-31',
    timeZone: 'America/Los_Angeles',
  })
  assert.equal(shiftedDay.usageEventCount, 1)
})

void it('usage report marks Pi branches and invalid counters partial without cost estimates', async () => {
  const path = resolve('fixtures/pi/usage-variants.jsonl')
  const parsed = await piProvider.parse({ jsonl: await readFile(path), source: path })
  const frames = new Map([[key(parsed), framesOf(parsed)]])
  const report = createUsageReport([parsed], frames)
  const pi = report.providers[0]!
  assert.equal(pi.usageEventCount, 2)
  assert.equal(report.sessions[0]?.usageEventCount, 2)
  assert.equal(pi.inputTokens, null)
  assert.equal(pi.outputTokens, null)
  assert.equal(pi.totalTokens, 0)
  assert.equal(pi.availability, 'partial')
  assert.ok(pi.diagnostics.some(message => message.includes('Invalid or unsafe')))
  assert.ok(pi.diagnostics.some(message => message.includes('branches')))
  assert.ok(!('nativeCostFields' in pi))
})

void it('timezone filtering uses local calendar days and undated events remain explicit', async () => {
  const path = resolve('fixtures/codex/usage-records.jsonl')
  const parsed = await codexProvider.parse({ jsonl: await readFile(path), source: path })
  const frames = new Map([[key(parsed), framesOf(parsed)]])
  const report = createUsageReport([parsed], frames, {
    since: '2025-12-31',
    until: '2025-12-31',
    timeZone: 'America/Los_Angeles',
  })
  assert.equal(report.usageEventCount, 0)
  assert.equal(report.undatedUsageEventCount, 3)
  assert.throws(() => createUsageReport([parsed], frames, { timeZone: 'not/a-zone' }))
})

void it('reused timezone formatting retains inclusive DST boundaries and invalid timestamps', async () => {
  const parsed = await claudeProvider.parse({ jsonl: await readFile(resolve('fixtures/claude/usage-only.jsonl')) })
  const usage = parsed.events.find(event => event.type === 'usage')!
  const times: Timestamp[] = [
    { format: 'rfc3339', value: '2026-03-08T07:59:59.999Z' },
    { format: 'rfc3339', value: '2026-03-08T08:00:00Z' },
    { format: 'unix_millis', value: Date.parse('2026-03-08T10:00:00Z') },
    { format: 'unix_millis', value: Date.parse('2026-03-09T06:59:59.999Z') },
    { format: 'rfc3339', value: '2026-03-09T07:00:00Z' },
    { format: 'rfc3339', value: 'invalid timestamp' },
    { format: 'unix_millis', value: 8_640_000_000_000_001 },
  ]
  const frames = new Map([[key(parsed), times.map((timestamp, sequence) => ({ type: 'event' as const, event: { ...usage, timestamp, sequence } }))]])
  const bounded = createUsageReport([parsed], frames, { timeZone: 'America/Los_Angeles', since: '2026-03-08', until: '2026-03-08' })
  assert.equal(bounded.usageEventCount, 3)
  assert.equal(bounded.undatedUsageEventCount, 2)
  assert.equal(bounded.daily[0]?.date, '2026-03-08')
  const unbounded = createUsageReport([parsed], frames, { timeZone: 'America/Los_Angeles' })
  assert.equal(unbounded.usageEventCount, times.length)
  assert.equal(unbounded.undatedUsageEventCount, 2)
  assert.deepEqual(unbounded.daily.map(day => day.date), ['2026-03-07', '2026-03-08', '2026-03-09', null])
})

void it('provider without a Huihua usage mapping is explicitly unavailable', async () => {
  const report = createUsageReport([], new Map(), { providerIds: ['cursor'] })
  assert.equal(report.providers[0]?.availability, 'unavailable')
  assert.equal(report.providers[0]?.usageEventCount, 0)
  assert.ok(report.providers[0]?.diagnostics.some(value => value.includes('no native usage mapping')))
})

void it('provider-native context capacity counters are unavailable as token totals', async () => {
  const path = resolve('fixtures/acp/updates.jsonl')
  const parsed = await acpProvider.parse({ jsonl: await readFile(path), source: path })
  const frames = new Map([[key(parsed), framesOf(parsed)]])
  const acp = createUsageReport([parsed], frames).providers[0]!
  assert.equal(acp.totalTokens, null)
  assert.equal(acp.inputTokens, null)
  assert.equal(acp.availability, 'unavailable')
})

void it('CLI selective reads produce the same complete report as full-stream aggregation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-usage-cli-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const projects = join(root, 'projects', 'fixture')
  await mkdir(projects, { recursive: true })
  const path = join(projects, 'usage.jsonl')
  const input = await Promise.all(['interrupted', 'usage-only', 'malformed'].map(async name => readFile(resolve(`fixtures/claude/${name}.jsonl`), 'utf8')))
  await writeFile(path, input.join('\n'))
  const { refs } = await sessions.scan({ providers: ['claude'], roots: { claude: [path] } })
  const opened = await sessions.open(refs[0]!)
  const frames: SessionFrame[] = []
  for await (const frame of opened.stream()) frames.push(frame)
  const expected = createUsageReport(refs, new Map([[key(refs[0]!), frames]]), {
    providers: ['claude'],
    providerIds: sessions.providers().map(provider => provider.id),
    since: '2026-01-01',
    until: '2026-01-01',
    timeZone: 'UTC',
  })
  const output = execFileSync(process.execPath, [
    'packages/usage/dist/cli.js',
    '--provider',
    'claude',
    '--since',
    '2026-01-01',
    '--until',
    '2026-01-01',
    '--timezone',
    'UTC',
    '--json',
  ], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: root } })
  assert.deepEqual(JSON.parse(output), expected)
  assert.equal(expected.undatedUsageEventCount, 1)
  assert.ok(expected.providers[0]?.diagnostics.includes('corrupted JSONL record'))
})

void it('CLI retains full-stream fallback for a buffered provider without selection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-usage-cli-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const store = join(root, 'opencode')
  await mkdir(store, { recursive: true })
  const path = join(store, 'opencode.db')
  await writeFile(path, await readFile(resolve('fixtures/opencode/simple.db')))
  const { refs } = await sessions.scan({ providers: ['opencode'], roots: { opencode: [path] } })
  const opened = await sessions.open(refs[0]!)
  assert.equal(opened.select, undefined)
  const frames: SessionFrame[] = []
  for await (const frame of opened.stream()) frames.push(frame)
  const expected = createUsageReport(refs, new Map([[key(refs[0]!), frames]]), {
    providers: ['opencode'],
    providerIds: sessions.providers().map(provider => provider.id),
  })
  const output = execFileSync(process.execPath, ['packages/usage/dist/cli.js', '--provider', 'opencode', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: root },
  })
  assert.deepEqual(JSON.parse(output), expected)
  assert.ok(expected.usageEventCount > 0)
})

void it('CLI options accept repeated providers, date filters, timezone and JSON output', () => {
  assert.deepEqual(parseUsageArgs([
    '--provider',
    'claude',
    '--provider',
    'codex',
    '--since',
    '2026-01-01',
    '--until',
    '2026-01-31',
    '--timezone',
    'Asia/Shanghai',
    '--json',
  ]), {
    providers: ['claude', 'codex'],
    since: '2026-01-01',
    until: '2026-01-31',
    timeZone: 'Asia/Shanghai',
    json: true,
    help: false,
    workers: 1,
  })
  assert.throws(() => parseUsageArgs(['--since']))
  assert.throws(() => parseUsageArgs(['--unknown']))
  assert.equal(parseUsageArgs(['--help']).help, true)
  assert.equal(parseUsageArgs(['--workers', '4']).workers, 4)
  for (const value of ['0', '3', '16', '2.0', '2x', '-1'])
    assert.throws(() => parseUsageArgs(['--workers', value]), /--workers must/)
  assert.throws(() => parseUsageArgs(['--workers']), /requires a value/)
})

void it('explicit CLI provider filters load only selected public provider modules and preserve errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'huihua-usage-imports-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const hook = join(root, 'selected.mjs')
  await writeFile(hook, `
    import {registerHooks} from 'node:module';
    registerHooks({resolve(specifier,context,next){
      if(specifier==='huihua')throw new Error('eager root import');
      if(['xxhashjs','fzstd'].includes(specifier))throw new Error('eager unused binary dependency');
      const result=next(specifier,context);
      const provider=result.url.match(/\\/providers\\/([^/]+)\\//)?.[1];
      if(provider!==undefined&&!['claude','codex'].includes(provider))throw new Error('unselected provider '+provider);
      return result;
    }});
  `)
  const env = { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, '.config'), XDG_DATA_HOME: join(root, '.local/share') }
  const output = execFileSync(process.execPath, ['--import', hook, 'packages/usage/dist/cli.js', '--provider', 'claude', '--provider', 'codex', '--provider', 'claude', '--json'], { encoding: 'utf8', env })
  const report = JSON.parse(output) as { sessionsScanned: number, providers: { provider: string }[] }
  assert.equal(report.sessionsScanned, 0)
  assert.deepEqual(report.providers.map(provider => provider.provider), ['claude', 'codex'])
  for (const id of ['not-a-provider', 'constructor', '__proto__']) {
    assert.throws(() => execFileSync(process.execPath, ['--import', hook, 'packages/usage/dist/cli.js', '--provider', id], { encoding: 'utf8', env, stdio: 'pipe' }), (error: unknown) => {
      assert.equal(String((error as { stderr: string }).stderr).trim(), `unregistered provider ${id}`)
      return true
    })
  }
  const complete = JSON.parse(execFileSync(process.execPath, ['packages/usage/dist/cli.js', '--json'], { encoding: 'utf8', env })) as { sessionsScanned: number, providers: { provider: string }[] }
  assert.equal(complete.sessionsScanned, 0)
  assert.deepEqual(complete.providers.map(provider => provider.provider), sessions.providers().map(provider => provider.id).sort())
})

void it('UTC grouping handles alternating days, models and negative epoch boundaries without stale groups', async () => {
  const report = await claudeRows([
    { model: 'a', timestamp: '1969-12-31T23:59:59.999Z', usage: { input_tokens: 1, output_tokens: 0 } },
    { model: 'a', timestamp: '1970-01-01T00:00:00Z', usage: { input_tokens: 2, output_tokens: 0 } },
    { model: 'b', timestamp: '1970-01-01T23:59:59.999Z', usage: { input_tokens: 4, output_tokens: 0 } },
    { model: 'a', timestamp: '1969-12-31T00:00:00Z', usage: { input_tokens: 8, output_tokens: 0 } },
    { model: 'a', timestamp: '1970-01-01T12:00:00Z', usage: { input_tokens: 16, output_tokens: 0 } },
  ])
  assert.deepEqual(report.daily.map(day => [day.date, day.totalTokens]), [['1969-12-31', 9], ['1970-01-01', 22]])
  assert.deepEqual(report.daily[1]?.modelBreakdowns.map(model => [model.model, model.totalTokens]), [['a', 18], ['b', 4]])
})

async function claudeRows(rows: readonly { model?: string | null, timestamp?: string | null, usage: Record<string, unknown>, requestId?: string }[]) {
  const line = (await readFile(resolve('fixtures/claude/usage-only.jsonl'), 'utf8')).split('\n')[0]!
  const base = JSON.parse(line) as { message: Record<string, unknown> }
  const jsonl = rows.map((row, index) => ({
    ...base,
    uuid: `fixture-${index}`,
    timestamp: row.timestamp === null ? undefined : row.timestamp ?? '2026-01-01T00:00:00Z',
    requestId: row.requestId ?? `fixture-request-${index}`,
    message: { ...base.message, id: `fixture-message-${index}`, model: row.model === null ? undefined : row.model ?? 'fixture-model', usage: row.usage },
  })).map(row => JSON.stringify(row)).join('\n')
  const parsed = await claudeProvider.parse({ jsonl, source: 'fixture:daily-totals' })
  return createUsageReport([parsed], new Map([[key(parsed), framesOf(parsed)]]))
}

void it('daily, model and session totals add distinct Claude input/output/cache counters', async () => {
  const report = await claudeRows([
    { model: 'model-a', usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 5 } },
    { model: 'model-b', usage: { input_tokens: 20, output_tokens: 4, cache_creation_input_tokens: 6, cache_read_input_tokens: 10 } },
    { model: 'model-a', timestamp: '2026-01-02T00:00:00Z', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  ])
  assert.deepEqual(report.daily.map(day => [day.date, day.totalTokens, day.availability]), [['2026-01-01', 60, 'complete'], ['2026-01-02', 2, 'complete']])
  assert.deepEqual(report.daily[0]?.modelBreakdowns.map(model => [model.model, model.totalTokens]), [['model-a', 20], ['model-b', 40]])
  assert.equal(report.totals.totalTokens, 62)
  assert.equal(report.totals.inputTokens, 31)
  assert.equal(report.totals.outputTokens, 7)
  assert.equal(report.totals.cacheCreationTokens, 9)
  assert.equal(report.totals.cacheReadTokens, 15)
  assert.equal(report.sessions[0]?.totalTokens, 62)
  assert.equal(report.providers[0]?.totalTokens, 62)
  assert.ok(formatUsageReport(report).includes('model-b'))
  assert.ok(formatUsageReport(report).includes('CACHE WRITE'))
  assert.ok(!formatUsageReport(report).includes('NATIVE FIELD'))
})

void it('missing counters are null with numeric partial totals and unknown model does not inherit the previous model', async () => {
  const report = await claudeRows([
    { model: 'known', usage: { output_tokens: 4 } },
    { model: null, usage: { output_tokens: 5 } },
  ])
  assert.equal(report.totals.totalTokens, 9)
  assert.equal(report.totals.inputTokens, null)
  assert.equal(report.totals.cacheReadTokens, null)
  assert.equal(report.totals.availability, 'partial')
  assert.deepEqual(report.daily[0]?.modelBreakdowns.map(model => [model.model, model.outputTokens]).sort(), [[null, 5], ['known', 4]].sort())
})

void it('Claude cache creation tier totals are used only when the top-level counter is absent', async () => {
  const report = await claudeRows([
    { usage: { input_tokens: 1, output_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 6 }, cache_read_input_tokens: 4 } },
    { usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 6 }, cache_read_input_tokens: 4 } },
  ])
  assert.equal(report.totals.cacheCreationTokens, 14)
  assert.equal(report.totals.totalTokens, 28)
  assert.equal(report.totals.availability, 'partial')
  assert.ok(report.providers[0]?.diagnostics.some(message => message.includes('tiers disagree')))
})

void it('Codex cache/reasoning subsets are not added twice and cumulative snapshots are diagnosed', async () => {
  const lines = (await readFile(resolve('fixtures/codex/usage-records.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  const request = lines[1]!
  const payload = request.payload as Record<string, unknown>
  const row = { ...request, timestamp: '2026-01-01T00:00:00Z', payload: { ...payload, usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 80, reasoning_output_tokens: 7, total_tokens: 110 } } }
  const snapshot = { ...lines[3], timestamp: '2026-01-01T00:00:01Z' }
  const parsed = await codexProvider.parse({ jsonl: [lines[0], row, row, snapshot].map(value => JSON.stringify(value)).join('\n'), source: 'fixture:codex-totals' })
  const report = createUsageReport([parsed], new Map([[key(parsed), framesOf(parsed)]]))
  assert.equal(report.totals.inputTokens, 200)
  assert.equal(report.totals.outputTokens, 20)
  assert.equal(report.totals.cacheReadTokens, 160)
  assert.equal(report.totals.totalTokens, 220)
  assert.equal(report.totals.availability, 'partial')
  assert.equal(report.usageEventCount, 3)
  assert.ok(report.providers[0]?.diagnostics.some(message => message.includes('snapshots')))
  assert.ok(report.providers[0]?.diagnostics.some(message => message.includes('Repeated response')))
  assert.equal(parsed.records.length, 4)
})

void it('daily model attribution reads OpenCode decoded public record facts and Cline same-record normalized models', async () => {
  const opencode = await sessions.parse('opencode', { path: resolve('fixtures/opencode/simple.db'), format: 'opencode_sqlite', id: 'session-1' })
  const openReport = createUsageReport([opencode], new Map([[key(opencode), framesOf(opencode)]]))
  assert.equal(openReport.daily[0]?.modelBreakdowns[0]?.model, 'fixture-model')
  assert.equal(openReport.totals.totalTokens, 3)
  const cline = await sessions.parse('cline', { path: resolve('fixtures/cline/session/session.json'), format: 'cline_json' })
  const clineReport = createUsageReport([cline], new Map([[key(cline), framesOf(cline)]]))
  assert.equal(clineReport.daily[0]?.modelBreakdowns[0]?.model, 'fixture-model')
  assert.equal(clineReport.totals.inputTokens, 2)
  assert.equal(clineReport.totals.totalTokens, 2)
})

void it('unsafe counters and aggregate overflow are unavailable rather than rounded', async () => {
  const report = await claudeRows([
    { usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    { usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  ])
  assert.equal(report.totals.inputTokens, null)
  assert.equal(report.totals.totalTokens, null)
  assert.equal(report.totals.availability, 'unavailable')
  assert.ok(report.providers[0]?.diagnostics.some(message => message.includes('safe integer')))
  const invalid = await claudeRows([{ usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: -1, cache_creation_input_tokens: '7', cache_read_input_tokens: null } }])
  assert.equal(invalid.totals.totalTokens, null)
  assert.equal(invalid.totals.inputTokens, null)
})

void it('unknown dates get their own bucket and missing native costs do not become estimated bills', async () => {
  const report = await claudeRows([{ timestamp: null, usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost: 0.01 } }])
  assert.equal(report.daily[0]?.date, null)
  assert.equal(report.daily[0]?.totalTokens, 3)
  assert.equal(report.totals.availability, 'partial')
  assert.equal(report.undatedUsageEventCount, 1)
  assert.ok(!('totalCost' in report.totals))
})

void it('native fork lineage and repeated response identities mark totals partial without deleting records', async () => {
  const base = await claudeProvider.parse({ jsonl: await readFile(resolve('fixtures/claude/usage-only.jsonl')) })
  const first = base.events.find(event => event.type === 'usage')!
  const frames = framesOf(base)
  frames.unshift({ type: 'metadata', patch: { parentSessionId: 'parent-fixture' } })
  frames.push({ type: 'event', event: { ...first, sequence: 99 } })
  const report = createUsageReport([base], new Map([[key(base), frames]]))
  assert.equal(report.usageEventCount, 3)
  assert.equal(report.totals.outputTokens, 33)
  assert.equal(report.totals.availability, 'partial')
  assert.ok(report.providers[0]?.diagnostics.some(message => message.includes('lineage')))
  assert.ok(report.providers[0]?.diagnostics.some(message => message.includes('Repeated response')))
  assert.equal(base.records.length, 2)
})

void it('Qwen native total includes undisplayed thought usage while cached input is not added twice', async () => {
  const parsed = await sessions.parse('qwen', { path: resolve('fixtures/qwen/session.jsonl') })
  const frames = framesOf(parsed).map((frame): SessionFrame => frame.type === 'event' && frame.event.type === 'usage'
    ? { type: 'event', event: { ...frame.event, timestamp: { format: 'rfc3339', value: '2026-01-01T00:00:00Z' }, data: { usage: { promptTokenCount: 10, candidatesTokenCount: 5, cachedContentTokenCount: 8, thoughtsTokenCount: 3, totalTokenCount: 18 } } } }
    : frame)
  const report = createUsageReport([parsed], new Map([[key(parsed), frames]]))
  assert.equal(report.totals.totalTokens, 18)
  assert.equal(report.totals.inputTokens, 10)
  assert.equal(report.totals.outputTokens, 5)
  assert.equal(report.totals.cacheReadTokens, 8)
  assert.equal(report.daily[0]?.modelBreakdowns[0]?.model, 'fixture-model')
})

void it('Cline cache counters are displayed without assuming unverified input/cache additivity', async () => {
  const parsed = await sessions.parse('cline', { path: resolve('fixtures/compatibility/cline/cline-cli-tool.json'), format: 'cline_json' })
  const report = createUsageReport([parsed], new Map([[key(parsed), framesOf(parsed)]]))
  assert.equal(report.totals.inputTokens, 5930)
  assert.equal(report.totals.outputTokens, 3757)
  assert.equal(report.totals.cacheReadTokens, 192)
  assert.equal(report.totals.totalTokens, 9687)
  assert.equal(report.totals.availability, 'partial')
})

void it('completed buffered sources release native record/model scratch without losing totals', async () => {
  const parsed = await sessions.parse('cline', { path: resolve('fixtures/cline/session/session.json'), format: 'cline_json' })
  const builder = new UsageReportBuilder([parsed])
  for (const frame of framesOf(parsed)) builder.add(parsed, frame)
  assert.ok('end' in builder, 'completed sources need an explicit native-state release boundary')
  builder.end(parsed)
  const usage = parsed.events.find(event => event.type === 'usage')!
  builder.add(parsed, { type: 'event', event: { ...usage, sequence: 999 } })
  const report = builder.finish()
  assert.equal(report.totals.inputTokens, 4)
  assert.equal(report.daily[0]?.modelBreakdowns.find(model => model.model === 'fixture-model')?.inputTokens, 2)
  assert.equal(report.daily[0]?.modelBreakdowns.find(model => model.model === null)?.inputTokens, 2)
})
