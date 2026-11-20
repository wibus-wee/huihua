import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import type { DriftSummary } from '../tools/producer-compat/runtime.ts'
import { assertNoProducerDrift, NativeDriftError } from '../tools/producer-compat/runtime.ts'

for (const provider of ['claude', 'claude-subagents', 'copilot']) {
  const baseline = JSON.parse(await readFile(new URL(`../tools/producer-compat/baselines/${provider}.json`, import.meta.url), 'utf8')) as DriftSummary
  await test(`${provider}: November 19 reviewed drift stays narrowly scoped`, () => {
    const actual = structuredClone(baseline)
    if (provider === 'claude-subagents')
      actual.fieldPaths = [...new Set([...actual.fieldPaths, '$.model:string'])]
    if (provider.startsWith('claude'))
      actual.groupedFieldPaths = [...new Set([...actual.groupedFieldPaths!, 'null:$.model:string'])]
    else
      actual.fieldPaths = actual.fieldPaths.filter(path => path !== '$.data.reasoningEffort:string')
    assertNoProducerDrift(actual, baseline)
    for (const path of provider.startsWith('claude')
      ? ['null:$.model:number', '"future":$.model:string', 'null:$.future:string']
      : ['$.data.reasoningEffort:number', '$.data.future:string']) {
      const changed = structuredClone(actual)
      if (provider.startsWith('claude'))
        changed.groupedFieldPaths!.push(path)
      else changed.fieldPaths.push(path)
      assert.throws(() => assertNoProducerDrift(changed, baseline), NativeDriftError)
    }
    if (provider === 'copilot') {
      const wrongKind = structuredClone(actual)
      wrongKind.groupedFieldPaths!.push('["future.record",null,null,null,null,null,null,null]:$.data.reasoningEffort:string')
      assert.throws(() => assertNoProducerDrift(wrongKind, baseline), NativeDriftError)
    }
    const lost = structuredClone(actual)
    lost.fieldPaths = lost.fieldPaths.filter(path => path !== '$:object')
    assert.throws(() => assertNoProducerDrift(lost, baseline), NativeDriftError)
  })
}
