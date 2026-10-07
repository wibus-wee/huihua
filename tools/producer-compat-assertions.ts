import assert from 'node:assert/strict'

export interface DriftSummary {
  unknown: Record<string, number>
  structured: number
  fieldPaths: string[]
  optionalFieldPaths?: string[]
}

export function assertNoProducerDrift(actual: DriftSummary, baseline: DriftSummary): void {
  for (const [kind, count] of Object.entries(actual.unknown))
    assert(count <= (baseline.unknown[kind] ?? 0), `unknown native record growth: ${kind}=${count}`)
  assert.equal(actual.structured, baseline.structured, 'new structured fallback content')
  const optional = new Set(baseline.optionalFieldPaths ?? [])
  assert.deepEqual(actual.fieldPaths.filter(path => !optional.has(path)), baseline.fieldPaths.filter(path => !optional.has(path)), 'native field/type drift; inspect report before updating baseline')
}
