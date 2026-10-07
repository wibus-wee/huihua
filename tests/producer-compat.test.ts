import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assertNoProducerDrift } from '../tools/producer-compat-assertions.ts'

const baseline = { unknown: { attachment: 2 }, structured: 0, fieldPaths: ['$.type:string'] }

await test('producer drift accepts known unknown evidence but rejects growth', () => {
  assertNoProducerDrift(baseline, baseline)
  assertNoProducerDrift({ ...baseline, unknown: { attachment: 1 } }, baseline)
  assert.throws(() => assertNoProducerDrift({ ...baseline, unknown: { attachment: 3 } }, baseline), /unknown native record growth/)
  assert.throws(() => assertNoProducerDrift({ ...baseline, unknown: { new_record: 1 } }, baseline), /unknown native record growth/)
})

await test('producer drift detects silent structural fallback and native field changes', () => {
  assert.throws(() => assertNoProducerDrift({ ...baseline, structured: 1 }, baseline), /structured fallback/)
  assert.throws(() => assertNoProducerDrift({ ...baseline, fieldPaths: ['$.type:string', '$.new:string'] }, baseline), /field\/type drift/)
  assert.throws(() => assertNoProducerDrift({ ...baseline, fieldPaths: [] }, baseline), /field\/type drift/)
})

await test('reviewed environment-only fields may be absent without ignoring new fields', () => {
  const expected = { ...baseline, fieldPaths: ['$.optional:string', '$.type:string'], optionalFieldPaths: ['$.optional:string'] }
  assertNoProducerDrift(baseline, expected)
  assert.throws(() => assertNoProducerDrift({ ...baseline, fieldPaths: ['$.new:string', '$.type:string'] }, expected), /field\/type drift/)
})
