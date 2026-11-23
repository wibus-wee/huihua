import type { RawRecord, SessionFrame, SessionRef } from 'huihua'

type CostSource = 'providerReported' | 'estimated' | 'nativeUnclassified'

export interface CostObservation {
  amount: number
  source: CostSource
}

export interface SessionCost extends CostObservation {
  currency: 'USD'
  scope: 'session'
  partial: boolean
  models?: Record<string, number>
}

export interface CostAccumulator {
  observed: number
  covered: number
  overflow: boolean
  amounts: Record<CostSource, number | null>
}

export function emptyCost(): CostAccumulator {
  return { observed: 0, covered: 0, overflow: false, amounts: { providerReported: null, estimated: null, nativeUnclassified: null } }
}

const sources = ['providerReported', 'estimated', 'nativeUnclassified'] as const
const labels: Record<CostSource, string> = { providerReported: 'reported', estimated: 'estimated', nativeUnclassified: 'native, source unknown' }

function addAmount(target: CostAccumulator, source: CostSource, amount: number) {
  const sum = (target.amounts[source] ?? 0) + amount
  if (Number.isFinite(sum))
    target.amounts[source] = sum
  else
    target.overflow = true
}

export function addCost(target: CostAccumulator, observation: CostObservation | undefined) {
  target.observed++
  if (observation !== undefined) {
    target.covered++
    addAmount(target, observation.source, observation.amount)
  }
}

export function mergeCost(target: CostAccumulator, next: CostAccumulator) {
  target.observed += next.observed
  target.covered += next.covered
  target.overflow ||= next.overflow
  for (const source of sources) {
    const amount = next.amounts[source]
    if (amount !== null)
      addAmount(target, source, amount)
  }
}

export function summarizeCost(cost: CostAccumulator, partial: boolean) {
  return {
    currency: 'USD' as const,
    scope: 'message' as const,
    amounts: cost.overflow ? emptyCost().amounts : { ...cost.amounts },
    availability: cost.covered === 0 || cost.overflow ? 'unavailable' as const : partial || cost.covered !== cost.observed ? 'partial' as const : 'complete' as const,
    coveredUsageEventCount: cost.covered,
    observedUsageEventCount: cost.observed,
  }
}

function dollars(value: number) {
  return `$${value.toLocaleString('en-US', { maximumSignificantDigits: 12 })}`
}

export function formatCost(cost: ReturnType<typeof summarizeCost>): string {
  if (cost.availability === 'unavailable')
    return '—'
  const fields = sources.flatMap(source => cost.amounts[source] === null ? [] : [`${dollars(cost.amounts[source])} ${labels[source]}`])
  return `${fields.join(' / ')} (${cost.coveredUsageEventCount}/${cost.observedUsageEventCount}${cost.availability === 'partial' ? ', partial' : ''})`
}

export function formatSessionCost(cost: SessionCost): string {
  return `${dollars(cost.amount)} ${labels[cost.source]}${cost.partial ? ' (partial)' : ''}`
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function amount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function messageCost(provider: string, usage: unknown, record: RawRecord | undefined, clineMetrics: WeakSet<object> | undefined, assistantRecord: boolean): CostObservation | undefined {
  const v = object(usage)
  const native = object(record?.native)
  let value: number | undefined
  let source: CostSource = 'nativeUnclassified'
  if (provider === 'opencode' && (native.type === 'assistant' || (record?.source.table === 'message' && object(native.data).role === 'assistant'))) {
    value = amount(v.cost)
  }
  else if ((provider === 'pi' || provider === 'openclaw') && (object(native.message).role === 'assistant' || (provider === 'openclaw' && record?.source.table === 'transcript_events' && assistantRecord))) {
    const cost = object(v.cost)
    value = amount(cost.total)
    if (provider === 'pi' && (cost.totalFromProvider === undefined || typeof cost.totalFromProvider === 'boolean'))
      source = cost.totalFromProvider === true ? 'providerReported' : 'estimated'
  }
  else if (provider === 'cline' && clineMetrics?.has(v)) {
    value = amount(v.cost)
  }
  return value === undefined ? undefined : { amount: value, source }
}

/** Undefined is not a snapshot; null is a newer snapshot whose cost is unknown. */
export function sessionCost(ref: SessionRef, record: RawRecord, claudeSessionId: string | undefined): SessionCost | null | undefined {
  const row = object(record.native)
  if (ref.provider === 'claude' && row.type === 'cost-state' && row.isSidechain !== true && typeof row.agentId !== 'string' && (row.sessionId === undefined || row.sessionId === (claudeSessionId ?? ref.id))) {
    const value = amount(row.totalCostUSD)
    if (value === undefined)
      return null
    const models = Object.fromEntries(Object.entries(object(row.modelUsage)).flatMap(([model, counters]) => {
      const modelCost = amount(object(counters).costUSD)
      return modelCost === undefined ? [] : [[model, modelCost]]
    }))
    return { amount: value, currency: 'USD', scope: 'session', source: 'nativeUnclassified', partial: row.hasUnknownModelCost === true, models }
  }
  if (ref.provider === 'hermes' && record.source.table === 'sessions') {
    const status = row.cost_status
    if (row.cost_source === 'none' || row.cost_source === null || row.cost_source === undefined)
      return null
    const value = status === 'actual' ? amount(row.actual_cost_usd) : status === 'estimated' ? amount(row.estimated_cost_usd) : undefined
    if (value === undefined)
      return null
    return { amount: value, currency: 'USD', scope: 'session', source: status === 'actual' ? 'providerReported' : 'estimated', partial: false }
  }
}

/** Keep only the report's attribution and cost facts when the CLI buffers a Claude read for retry. */
export function compactClaudeRecord(frame: SessionFrame): SessionFrame | undefined {
  if (frame.type !== 'record')
    return frame
  const row = object(frame.record.native)
  const { sequence, source, provider } = frame.record
  if (row.type === 'cost-state')
    return { type: 'record', record: { sequence, provider, source, native: { type: row.type, isSidechain: row.isSidechain, agentId: row.agentId, sessionId: row.sessionId, totalCostUSD: row.totalCostUSD, modelUsage: row.modelUsage, hasUnknownModelCost: row.hasUnknownModelCost } } }
  if (row.type === 'assistant' || row.type === 'user') {
    const message = object(row.message)
    return { type: 'record', record: { sequence, provider, source, native: { type: row.type, sessionId: row.sessionId, isSidechain: row.isSidechain, message: { id: message.id, model: message.model }, requestId: row.requestId } } }
  }
}
