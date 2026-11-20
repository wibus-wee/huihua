import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { sessions } from '../src/index.ts'
import { assertCodexBaseline } from '../tools/producer-compat/codex.ts'
import type { DriftSummary } from '../tools/producer-compat/runtime.ts'
import { assertNoProducerDrift, NativeDriftError } from '../tools/producer-compat/runtime.ts'

for (const [provider, paths] of [
  ['codex', ['$.metadata.model_search_state:string']],
  ['oar', ['$.record.body.events[].usage.cacheWriteByTtl:object', '$.record.body.events[].usage.cacheWriteByTtl.1h:number']],
] as const) {
  await test(`${provider} November 20 reviewed additive fields retain strict type checks`, async () => {
    const baseline = JSON.parse(await readFile(new URL(`../tools/producer-compat/baselines/${provider}.json`, import.meta.url), 'utf8')) as DriftSummary
    const check = provider === 'codex' ? assertCodexBaseline : assertNoProducerDrift
    const actual = { ...baseline, fieldPaths: [...new Set([...baseline.fieldPaths, ...paths])], groupedFieldPaths: [...new Set([...baseline.groupedFieldPaths!, ...paths.map(path => `${provider === 'codex' ? '"response_item"' : '["record",null,null,null,"frame",null,null,null]'}:${path}`)])] }
    check(actual, baseline)
    assert.throws(() => check({ ...actual, groupedFieldPaths: [...actual.groupedFieldPaths, `"wrong_record":${paths[0]}`] }, baseline), NativeDriftError)
    assert.throws(() => check({ ...actual, groupedFieldPaths: [...actual.groupedFieldPaths, '"response_item":$.future:string'] }, baseline), NativeDriftError)
    const required = baseline.groupedFieldPaths!.find(path => !(baseline.optionalGroupedFieldPaths ?? []).includes(path))!
    assert.throws(() => check({ ...actual, groupedFieldPaths: actual.groupedFieldPaths.filter(path => path !== required) }, baseline), NativeDriftError)
    assert.throws(() => check({ ...actual, groupedFieldPaths: [...actual.groupedFieldPaths, `${provider === 'codex' ? '"response_item"' : '["record",null,null,null,"frame",null,null,null]'}:${paths[0].replace(/:[^:]+$/, ':boolean')}`] }, baseline), NativeDriftError)
  })
}

await test('OAR projected TTL usage survives public parse without native duplication', async () => {
  const usage = { tokens: { input: 3, output: 7, cacheRead: 2, cacheWrite: 11 }, cacheWriteByTtl: { '1h': 5 } }
  const nativeUsage = { input: 3, output: 7, cacheWrite: 11, cacheWrite1h: 5 }
  for (const projected of [true, false]) {
    const row = { kind: 'record', record: { kind: 'frame', body: { native: { message: { usage: nativeUsage } }, events: projected ? [{ kind: 'usage', usage }] : [] } } }
    const session = await sessions.parse('oar', { jsonl: JSON.stringify(row) })
    assert.deepEqual(session.records[0]?.native, row)
    const events = session.events.filter(event => event.type === 'usage')
    assert.equal(events.length, projected ? 1 : 0)
    if (projected) {
      assert.deepEqual(events[0]!.data.usage, usage)
      assert.equal((events[0]!.data.usage).tokens.cacheWrite, 11)
    }
  }
})
