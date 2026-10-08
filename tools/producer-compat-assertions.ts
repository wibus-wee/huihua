import assert from 'node:assert/strict'

export interface DriftSummary {
  unknown: Record<string, number>
  structured: number
  fieldPaths: string[]
  optionalFieldPaths?: string[]
  groupedFieldPaths?: string[]
  optionalGroupedFieldPaths?: string[]
}

export function assertNoProducerDrift(actual: DriftSummary, baseline: DriftSummary): void {
  for (const [kind, count] of Object.entries(actual.unknown))
    assert(count <= (baseline.unknown[kind] ?? 0), `unknown native record growth: ${kind}=${count}`)
  assert.equal(actual.structured, baseline.structured, 'new structured fallback content')
  if (actual.groupedFieldPaths !== undefined || baseline.groupedFieldPaths !== undefined) {
    assert(actual.groupedFieldPaths, 'missing independent per-record-type native observations')
    assert(baseline.groupedFieldPaths, 'missing reviewed per-record-type native baseline')
    const optionalGrouped = new Set(baseline.optionalGroupedFieldPaths ?? [])
    assert.deepEqual(actual.groupedFieldPaths.filter(path => !optionalGrouped.has(path)), baseline.groupedFieldPaths.filter(path => !optionalGrouped.has(path)), 'native per-record-type field/type drift')
  }
  const optional = new Set(baseline.optionalFieldPaths ?? [])
  assert.deepEqual(actual.fieldPaths.filter(path => !optional.has(path)), baseline.fieldPaths.filter(path => !optional.has(path)), 'native field/type drift; inspect report before updating baseline')
}
