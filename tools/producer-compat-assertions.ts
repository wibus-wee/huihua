import assert from 'node:assert/strict'

export interface DriftSummary {
  unknown: Record<string, number>
  structured: number
  fieldPaths: string[]
}

export function assertNoProducerDrift(actual: DriftSummary, baseline: DriftSummary): void {
  for (const [kind, count] of Object.entries(actual.unknown))
    assert(count <= (baseline.unknown[kind] ?? 0), `unknown native record growth: ${kind}=${count}`)
  assert.equal(actual.structured, baseline.structured, 'new structured fallback content')
  assert.deepEqual(actual.fieldPaths, baseline.fieldPaths, 'native field/type drift; inspect report before updating baseline')
}
