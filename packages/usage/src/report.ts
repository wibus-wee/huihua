import type { RawRecord, SessionEvent, SessionFrame, SessionRef, Timestamp, UsageFact, UsageFactItem } from 'huihua'

export interface ReportOptions {
  readonly providers?: readonly string[]
  readonly providerIds?: readonly string[]
  readonly since?: string
  readonly until?: string
  readonly timeZone?: string
}

type Availability = 'complete' | 'partial' | 'unavailable'
interface TokenTotals {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cacheCreationTokens: number | null
  readonly cacheReadTokens: number | null
  readonly totalTokens: number | null
}
interface TokenSummary extends TokenTotals {
  readonly availability: Availability
  readonly usageEventCount: number
}
interface ModelBreakdown extends TokenSummary {
  readonly provider: string
  readonly model: string | null
}
interface DailyUsage extends TokenSummary {
  readonly date: string | null
  readonly modelsUsed: readonly string[]
  readonly modelBreakdowns: readonly ModelBreakdown[]
}
interface ProviderUsageReport extends TokenSummary {
  readonly provider: string
  readonly sessionCount: number
  readonly undatedUsageEventCount: number
  readonly diagnostics: readonly string[]
}
interface SessionUsageReport extends TokenSummary {
  readonly provider: string
  readonly id: string
  readonly title?: string
  readonly source: SessionRef['source']
  readonly undatedUsageEventCount: number
  readonly daily: readonly DailyUsage[]
  readonly diagnostics: readonly string[]
}
interface UsageReport {
  readonly schema: 'huihua-usage/v2'
  readonly filters: {
    readonly providers: readonly string[]
    readonly since?: string
    readonly until?: string
    readonly timeZone: string
  }
  readonly sessionsScanned: number
  readonly usageEventCount: number
  readonly undatedUsageEventCount: number
  readonly daily: readonly DailyUsage[]
  readonly totals: TokenSummary
  readonly providers: readonly ProviderUsageReport[]
  readonly sessions: readonly SessionUsageReport[]
  readonly semantics: readonly string[]
}
interface MutableTotals {
  inputTokens: number | null
  outputTokens: number | null
  cacheCreationTokens: number | null
  cacheReadTokens: number | null
  totalTokens: number | null
}
interface Aggregate extends MutableTotals {
  partial: boolean
  usageEventCount: number
  overflow: Set<keyof TokenTotals>
}
interface ModelAccumulator extends Aggregate {
  date: string | null
  provider: string
  model: string | null
}
interface SessionAccumulator {
  ref: SessionRef
  current?: RawRecord
  assistant?: { record: number, id?: string, model: string } | undefined
  branches: Map<string, string>
  embeddedModels: WeakMap<object, string> | undefined
  lastGroup?: ModelAccumulator
  groups: Map<string, ModelAccumulator>
  diagnostics: Set<string>
  partial: boolean
  usageEventCount: number
  undatedUsageEventCount: number
  selectedTimestamp?: Timestamp | undefined
  selectedDate?: string | undefined
}
interface Projection {
  tokens: TokenTotals
  complete: boolean
  model: string | null
}

/** Private structured-clone transport; no native records/events and no finalized report arithmetic. */
export interface UsagePartition {
  readonly schema: 'usage-partition/v1'
  readonly sessions: readonly {
    readonly key: string
    readonly groups: readonly ModelAccumulator[]
    readonly diagnostics: readonly string[]
    readonly partial: boolean
    readonly usageEventCount: number
    readonly undatedUsageEventCount: number
  }[]
  readonly identities: readonly (readonly [string, string])[]
}

const noUsage = new Set(['antigravity', 'cursor', 'fx', 'grok', 'morph'])
const noTokenContract = new Set(['acp', 'devin', 'hermes', 'droid'])
const tokenKeys: readonly (keyof TokenTotals)[] = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'totalTokens']
const unavailableTokens: TokenTotals = { inputTokens: null, outputTokens: null, cacheCreationTokens: null, cacheReadTokens: null, totalTokens: null }
const semantics = [
  'Daily/model/session totals sum validated native token counters; partial totals include only known components, and null means unavailable rather than zero.',
  'Repeated native records are retained and counted. Repeated response identities, forks and replay uncertainty mark affected totals partial; this is not deduplicated billable work.',
  'Cumulative checkpoints without safe request/date allocation are excluded with diagnostics; no snapshot deltas are invented.',
  'Claude and Pi-style cache counters are additional; Codex cached input is a subset of input and reasoning output is a subset of output.',
  'Models come from explicit usage, same-record native/normalized facts, or recorded Codex turn context with provenance. Null denotes unknown; no session-wide last-model guess is used.',
  'Native timestamps determine local calendar dates. Undated usage has a null-date bucket without bounds and is excluded when bounds are active.',
  'No price estimates, native cost sums or actual billing claims are produced.',
]

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
function count(value: unknown, field: string, diagnostics: Set<string>): number | null {
  if (value === undefined || value === null)
    return null
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    return value
  diagnostics.add(`Invalid or unsafe token counter ${field}; it was excluded, not coerced to zero.`)
  return null
}
function knownSum(values: readonly (number | null)[], diagnostics: Set<string>): number | null {
  let sum = 0
  let known = false
  for (const value of values) {
    if (value !== null) {
      known = true
      sum += value
    }
  }
  if (!known)
    return null
  if (!Number.isSafeInteger(sum)) {
    diagnostics.add('Token sum exceeds the safe integer range; that total is unavailable.')
    return null
  }
  return sum
}
function empty(): Aggregate {
  return { inputTokens: null, outputTokens: null, cacheCreationTokens: null, cacheReadTokens: null, totalTokens: null, partial: false, usageEventCount: 0, overflow: new Set() }
}
function merge(target: Aggregate, next: TokenTotals & { readonly overflow?: ReadonlySet<keyof TokenTotals> }, partial: boolean, eventCount = 0): void {
  target.partial ||= partial
  target.usageEventCount += eventCount
  for (const field of tokenKeys) {
    if (next.overflow?.has(field)) {
      target[field] = null
      target.overflow.add(field)
      target.partial = true
    }
    const value = next[field]
    if (value === null || target.overflow.has(field))
      continue
    const sum = (target[field] ?? 0) + value
    if (!Number.isSafeInteger(sum)) {
      target[field] = null
      target.overflow.add(field)
      target.partial = true
    }
    else {
      target[field] = sum
    }
  }
}
function summary(value: Aggregate, forcePartial = false): TokenSummary {
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheCreationTokens: value.cacheCreationTokens,
    cacheReadTokens: value.cacheReadTokens,
    totalTokens: value.totalTokens,
    availability: value.totalTokens === null ? 'unavailable' : value.partial || forcePartial ? 'partial' : 'complete',
    usageEventCount: value.usageEventCount,
  }
}
function sameRecordModel(provider: string, event: UsageFact, session: SessionAccumulator): string | null {
  const usage = object(event.data.usage)
  let model = text(usage.model) ?? text(event.providerMetadata.model)
  const context = event.providerMetadata.native_usage_context
  if (context !== undefined)
    return model ?? text(object(context).model) ?? null
  if (model !== undefined)
    return model
  const native = session.current?.sequence === event.record ? object(session.current.native) : {}
  const message = object(native.message)
  const data = object(native.data)
  if (['claude', 'pi', 'openclaw', 'droid'].includes(provider))
    model ??= text(message.model)
  else if (provider === 'codex')
    model ??= text(object(native.payload).model)
  else if (provider === 'qwen' || provider === 'kimi')
    model ??= text(native.model)
  else if (provider === 'copilot')
    model ??= text(data.model)
  else if (provider === 'deepseek')
    model ??= text(object(object(data.message).source).model)
  else if (provider === 'opencode')
    model ??= text(data.modelID) ?? text(object(data.model).id)
  if (model === undefined && session.current?.sequence === event.record && typeof event.data.usage === 'object' && event.data.usage !== null)
    model = session.embeddedModels?.get(event.data.usage)
  if (model === undefined && session.assistant?.record === event.record && session.assistant.id === event.id)
    model = session.assistant.model
  return model ?? null
}
function project(provider: string, event: UsageFact, session: SessionAccumulator): Projection | undefined {
  const value = object(event.data.usage)
  const diagnostics = session.diagnostics
  const model = sameRecordModel(provider, event, session)
  let input: unknown, output: unknown, write: unknown, read: unknown, total: unknown
  let cacheAdditional = true
  let completeScope = true
  if (provider === 'claude') {
    input = value.input_tokens
    output = value.output_tokens
    read = value.cache_read_input_tokens
    write = value.cache_creation_input_tokens
    if (write === undefined && value.cache_creation !== undefined) {
      const tiers = object(value.cache_creation)
      const five = count(tiers.ephemeral_5m_input_tokens, 'cache_creation.ephemeral_5m_input_tokens', diagnostics)
      const hour = count(tiers.ephemeral_1h_input_tokens, 'cache_creation.ephemeral_1h_input_tokens', diagnostics)
      write = five !== null && hour !== null ? knownSum([five, hour], diagnostics) : undefined
    }
    else if (write !== undefined && value.cache_creation !== undefined) {
      const tiers = object(value.cache_creation)
      const five = count(tiers.ephemeral_5m_input_tokens, 'cache_creation.ephemeral_5m_input_tokens', diagnostics)
      const hour = count(tiers.ephemeral_1h_input_tokens, 'cache_creation.ephemeral_1h_input_tokens', diagnostics)
      const root = count(write, 'cache creation', diagnostics)
      if (root !== null && five !== null && hour !== null && root !== knownSum([five, hour], diagnostics)) {
        completeScope = false
        diagnostics.add('Cache creation tiers disagree with the top-level counter; the top-level counter is retained and totals are partial.')
      }
    }
  }
  else if (provider === 'codex') {
    if (value.type === 'token_count' || 'info' in value || event.providerMetadata.usage_scope === 'turn_summary') {
      diagnostics.add('Codex token_count cumulative/last snapshots cannot be safely allocated to requests and dates; excluded from additive totals.')
      return undefined
    }
    const tokens = object(value.usage)
    input = tokens.input_tokens
    output = tokens.output_tokens
    read = tokens.cached_input_tokens
    total = tokens.total_tokens
    cacheAdditional = false
  }
  else if (provider === 'pi' || provider === 'openclaw') {
    input = value.input
    output = value.output
    write = value.cacheWrite
    read = value.cacheRead
    total = value.totalTokens
    if (session.ref.metadata.parentSession !== undefined) {
      diagnostics.add('Pi-style parentSession may carry replayed history; all native message counters are retained and totals are partial.')
      completeScope = false
    }
  }
  else if (provider === 'opencode') {
    if (value.type === 'step-finish') {
      diagnostics.add('OpenCode step-finish counters may overlap message totals; excluded rather than added twice.')
      return undefined
    }
    const tokens = object(value.tokens)
    input = tokens.input
    output = tokens.output
    write = object(tokens.cache).write
    read = object(tokens.cache).read
    const reasoning = count(tokens.reasoning, 'tokens.reasoning', diagnostics)
    completeScope = reasoning === 0
    if (reasoning !== null && reasoning > 0)
      diagnostics.add('OpenCode reasoning/output overlap is not established by the available evidence; reasoning is not added to output.')
  }
  else if (provider === 'qwen') {
    input = value.promptTokenCount
    output = value.candidatesTokenCount
    read = value.cachedContentTokenCount
    total = value.totalTokenCount
    cacheAdditional = false
    // Google totals can include thought/tool prompt counters beyond these displayed components.
    completeScope = total !== undefined
  }
  else if (provider === 'copilot') {
    if (event.providerMetadata.type !== 'assistant.usage') {
      diagnostics.add('Copilot checkpoint/shutdown metrics are cumulative scopes; excluded from response token totals.')
      return undefined
    }
    input = value.inputTokens
    output = value.outputTokens
    read = value.cacheReadTokens
    write = value.cacheWriteTokens
    cacheAdditional = false
    completeScope = false
  }
  else if (provider === 'kimi') {
    if ('inputOther' in value || 'output' in value || 'inputCacheRead' in value || 'inputCacheCreation' in value) {
      input = value.inputOther
      output = value.output
      read = value.inputCacheRead
      write = value.inputCacheCreation
    }
    else {
      input = value.inputTokens
      output = value.outputTokens
      read = value.cacheReadTokens
      write = value.cacheWriteTokens
      total = value.totalTokens
      cacheAdditional = false
      completeScope = false
      diagnostics.add('Legacy Kimi token-named counters retain their partial scope; native generation fields were not present.')
    }
  }
  else if (['deepseek', 'cline'].includes(provider)) {
    input = value.inputTokens
    output = value.outputTokens
    read = value.cacheReadTokens
    write = value.cacheWriteTokens
    total = value.totalTokens
    cacheAdditional = false
    completeScope = false
    diagnostics.add(`${provider} totals use explicit token-named fields; source replay/branch or counter scope is not universally established.`)
  }
  else if (provider === 'oar') {
    input = object(value.tokens).input
    output = object(value.tokens).output
    completeScope = false
    diagnostics.add('OAR token counters have runtime-specific scopes; repeated frame counters remain partial.')
  }
  else {
    diagnostics.add('No evidence-backed additive token mapping exists for this provider or usage shape.')
    return undefined
  }
  const inputTokens = count(input, 'input', diagnostics)
  const outputTokens = count(output, 'output', diagnostics)
  const cacheCreationTokens = count(write, 'cache creation', diagnostics)
  const cacheReadTokens = count(read, 'cache read', diagnostics)
  const nativeTotal = count(total, 'total', diagnostics)
  const components = cacheAdditional ? [inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens] : [inputTokens, outputTokens]
  const componentSum = knownSum(components, diagnostics)
  let complete = completeScope && (nativeTotal !== null || (componentSum !== null && components.every(value => value !== null)))
  if (completeScope && nativeTotal !== null && components.every(value => value !== null) && nativeTotal !== componentSum && provider !== 'qwen') {
    diagnostics.add('Native total disagrees with mapped components; the native total is retained and completeness is partial.')
    complete = false
  }
  if (['codex', 'qwen'].includes(provider) && inputTokens !== null && cacheReadTokens !== null && cacheReadTokens > inputTokens) {
    diagnostics.add('Cached input exceeds input tokens; subset semantics are inconsistent.')
    complete = false
  }
  if (!complete)
    diagnostics.add('Token totals are partial: missing components or ambiguous counter scope are not treated as zero.')
  return { tokens: { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalTokens: nativeTotal ?? componentSum }, complete, model }
}
function identity(provider: string, event: UsageFact, session: SessionAccumulator): string | undefined {
  if (provider === 'claude') {
    const context = object(event.providerMetadata.native_usage_context)
    const native = event.providerMetadata.native_usage_context === undefined && session.current?.sequence === event.record ? object(session.current.native) : {}
    const id = text(context.message_id) ?? text(object(native.message).id)
    const request = text(context.request_id) ?? text(native.requestId)
    return id === undefined ? undefined : JSON.stringify([id, request ?? session.ref.source, request === undefined ? event.timestamp : undefined])
  }
  if (provider === 'codex')
    return text(object(event.data.usage).response_id)
  if (provider === 'deepseek') {
    const native = session.current?.sequence === event.record ? object(session.current.native) : {}
    return text(object(object(native.data).message).id)
  }
  return text(event.id)
}
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year!, month! - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day
}
function instant(timestamp: SessionEvent['timestamp']): number | undefined {
  if (timestamp === undefined)
    return undefined
  const value = timestamp.format === 'rfc3339' ? Date.parse(timestamp.value) : timestamp.value
  const clipped = new Date(value).getTime()
  return Number.isFinite(clipped) ? clipped : undefined
}
function calendarDay(value: number, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(value)
  const year = parts.find(part => part.type === 'year')!.value
  const month = parts.find(part => part.type === 'month')!.value
  const day = parts.find(part => part.type === 'day')!.value
  return `${year}-${month}-${day}`
}
function refKey(ref: SessionRef): string {
  return JSON.stringify([ref.provider, ref.source])
}
function groupOf(session: SessionAccumulator, date: string | null, model: string | null): ModelAccumulator {
  if (session.lastGroup?.date === date && session.lastGroup.model === model)
    return session.lastGroup
  const key = JSON.stringify([date, model])
  let group = session.groups.get(key)
  if (group === undefined) {
    group = { ...empty(), date, provider: session.ref.provider, model }
    session.groups.set(key, group)
  }
  session.lastGroup = group
  return group
}
function daily(groups: readonly ModelAccumulator[], partial = false): DailyUsage[] {
  const days = new Map<string | null, { total: Aggregate, models: Map<string, ModelAccumulator> }>()
  for (const group of groups) {
    const day = days.get(group.date) ?? { total: empty(), models: new Map<string, ModelAccumulator>() }
    days.set(group.date, day)
    merge(day.total, group, partial || group.partial, group.usageEventCount)
    const key = JSON.stringify([group.provider, group.model])
    const model = day.models.get(key) ?? { ...empty(), date: group.date, provider: group.provider, model: group.model }
    merge(model, group, partial || group.partial, group.usageEventCount)
    day.models.set(key, model)
  }
  return [...days].sort(([a], [b]) => a === null ? b === null ? 0 : 1 : b === null ? -1 : a.localeCompare(b)).map(([date, day]) => ({
    date,
    ...summary(day.total),
    modelsUsed: [...new Set([...day.models.values()].flatMap(model => model.model === null ? [] : [model.model]))].sort(),
    modelBreakdowns: [...day.models.values()].sort((a, b) => JSON.stringify([a.provider, a.model]).localeCompare(JSON.stringify([b.provider, b.model]))).map(model => ({ provider: model.provider, model: model.model, ...summary(model) })),
  }))
}
function aggregate(groups: readonly ModelAccumulator[], partial: boolean, eventCount: number): Aggregate {
  const result = empty()
  for (const group of groups)
    merge(result, group, partial || group.partial)
  result.usageEventCount = eventCount
  return result
}

export class UsageReportBuilder {
  readonly #timeZone: string
  readonly #formatter: Intl.DateTimeFormat | undefined
  readonly #options: ReportOptions
  readonly #selected: Set<string> | undefined
  readonly #sessions = new Map<string, SessionAccumulator>()
  readonly #providerIds: readonly string[]
  readonly #identities = new Map<string, SessionAccumulator>()
  readonly #imported = new Set<string>()
  #lastRef: SessionRef | undefined
  #lastSession: SessionAccumulator | undefined
  #utcDay: number | undefined
  #utcDate = ''

  constructor(refs: readonly SessionRef[], options: ReportOptions = {}) {
    this.#timeZone = options.timeZone ?? 'UTC'
    this.#options = options
    this.#selected = options.providers === undefined ? undefined : new Set(options.providers)
    this.#formatter = this.#timeZone === 'UTC' ? undefined : new Intl.DateTimeFormat('en-CA', { timeZone: this.#timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    if (options.since !== undefined && !isCalendarDate(options.since))
      throw new TypeError('--since must be a calendar date in YYYY-MM-DD format')
    if (options.until !== undefined && !isCalendarDate(options.until))
      throw new TypeError('--until must be a calendar date in YYYY-MM-DD format')
    if (options.since !== undefined && options.until !== undefined && options.since > options.until)
      throw new TypeError('--since must not be later than --until')
    this.#providerIds = [...new Set(options.providerIds ?? refs.map(ref => ref.provider))].filter(provider => !this.#selected || this.#selected.has(provider)).sort()
    for (const ref of refs) {
      if (this.#selected && !this.#selected.has(ref.provider))
        continue
      const diagnostics = new Set<string>()
      const partial = ref.metadata.parentSession !== undefined || ref.metadata.fork_boundary !== undefined || text(ref.metadata.parent_id) !== undefined
      if (partial)
        diagnostics.add('Native fork/replay metadata is present; retained history may overlap other sessions.')
      this.#sessions.set(refKey(ref), { ref, groups: new Map(), branches: new Map(), embeddedModels: undefined, diagnostics, partial, usageEventCount: 0, undatedUsageEventCount: 0 })
    }
  }

  add(ref: SessionRef, frame: SessionFrame): void {
    const session = this.#lastRef === ref ? this.#lastSession : this.#sessions.get(refKey(ref))
    this.#lastRef = ref
    this.#lastSession = session
    if (!session)
      return
    if (frame.type === 'metadata') {
      if (frame.patch.parentSessionId !== undefined) {
        session.partial = true
        session.diagnostics.add('Native parent session lineage is present; retained history may overlap other sessions.')
      }
      return
    }
    if (frame.type === 'record') {
      session.current = frame.record
      session.assistant = undefined
      session.embeddedModels = undefined
      const native = object(frame.record.native)
      if (ref.provider === 'cline' && Array.isArray(native.messages)) {
        session.embeddedModels = new WeakMap()
        for (const value of native.messages) {
          const message = object(value)
          const tokens = message.usage ?? message.metrics
          const model = text(message.model) ?? text(object(message.modelInfo).id)
          if (model !== undefined && typeof tokens === 'object' && tokens !== null)
            session.embeddedModels.set(tokens, model)
        }
      }
      const parent = text(native.parentId)
      const id = text(native.id)
      if (['pi', 'openclaw'].includes(ref.provider) && native.type === 'message' && parent !== undefined && id !== undefined) {
        const sibling = session.branches.get(parent)
        if (sibling !== undefined && sibling !== id) {
          session.partial = true
          session.diagnostics.add('Multiple Pi-style branches are present; all native message counters are counted, not only a selected branch.')
        }
        session.branches.set(parent, id)
      }
      return
    }
    if (frame.type === 'diagnostic') {
      session.diagnostics.add(frame.diagnostic.message)
      session.partial = true
      return
    }
    const event = frame.event
    if (event.type === 'assistant_message' && event.data.model !== undefined) {
      session.assistant = { record: event.record, ...(event.id === undefined ? {} : { id: event.id }), model: event.data.model }
      return
    }
    if (event.type === 'user_message') {
      session.assistant = undefined
      return
    }
    if (event.type !== 'usage')
      return
    this.#addUsage(ref, event, session)
  }

  addFact(ref: SessionRef, item: UsageFactItem): void {
    if (item.type !== 'usage') {
      this.add(ref, item)
      return
    }
    const session = this.#lastRef === ref ? this.#lastSession : this.#sessions.get(refKey(ref))
    this.#lastRef = ref
    this.#lastSession = session
    if (session !== undefined)
      this.#addUsage(ref, item, session)
  }

  /** Same date policy before provider fact/envelope creation; bounded undated observations are accounted here. */
  acceptTimestamp(ref: SessionRef, timestamp: Timestamp | undefined): boolean {
    const session = this.#lastRef === ref ? this.#lastSession : this.#sessions.get(refKey(ref))
    this.#lastRef = ref
    this.#lastSession = session
    if (session === undefined)
      return false
    const time = instant(timestamp)
    const date = time === undefined ? null : this.#calendarDay(time)
    if (date === null) {
      if (this.#options.since === undefined && this.#options.until === undefined)
        return true
      session.undatedUsageEventCount++
      return false
    }
    if ((this.#options.since !== undefined && date < this.#options.since) || (this.#options.until !== undefined && date > this.#options.until))
      return false
    session.selectedTimestamp = timestamp
    session.selectedDate = date
    return true
  }

  #addUsage(ref: SessionRef, event: UsageFact, session: SessionAccumulator): void {
    let date: string | null
    if (session.selectedDate !== undefined && session.selectedTimestamp === event.timestamp) {
      date = session.selectedDate
    }
    else {
      const time = instant(event.timestamp)
      date = time === undefined ? null : this.#calendarDay(time)
    }
    session.selectedDate = undefined
    session.selectedTimestamp = undefined
    if (date === null) {
      session.undatedUsageEventCount += 1
      if (this.#options.since !== undefined || this.#options.until !== undefined)
        return
    }
    if (date !== null && ((this.#options.since !== undefined && date < this.#options.since) || (this.#options.until !== undefined && date > this.#options.until)))
      return
    session.usageEventCount += 1
    const projection = project(ref.provider, event, session)
    if (projection === undefined)
      session.partial = true
    if (projection?.model === null)
      session.diagnostics.add('Model is unavailable for some usage; it is grouped under unknown instead of inferred from another record.')
    const group = groupOf(session, date, projection?.model ?? null)
    merge(group, projection?.tokens ?? unavailableTokens, projection === undefined || !projection.complete || projection.model === null || date === null, 1)
    const id = identity(ref.provider, event, session)
    if (id !== undefined) {
      const identityKey = JSON.stringify([ref.provider, ['claude', 'codex'].includes(ref.provider) ? null : ref.source, id])
      const previous = this.#identities.get(identityKey)
      if (previous !== undefined) {
        for (const affected of [previous, session]) {
          affected.partial = true
          affected.diagnostics.add('Repeated response identity was retained in the token sum; distinct billable work cannot be established.')
        }
      }
      this.#identities.set(identityKey, session)
    }
    else if (projection !== undefined) {
      session.partial = true
      session.diagnostics.add('Response identity is absent; repeated work cannot be ruled out for this native counter sum.')
    }
    if (ref.provider === 'claude' && Array.isArray(object(event.data.usage).iterations)) {
      // The empirical advisor_message shape is a separate model contribution. Ordinary message iterations repeat outer counters.
      for (const iteration of object(event.data.usage).iterations as unknown[]) {
        const value = object(iteration)
        if (value.type !== 'advisor_message')
          continue
        const advisorEvent = { ...event, data: { usage: value } }
        const advisor = project('claude', advisorEvent, session)!
        const advisorModel = text(value.model) ?? null
        if (advisorModel === null)
          session.diagnostics.add('Advisor model is absent; its explicit token counters are grouped under unknown.')
        const advisorGroup = groupOf(session, date, advisorModel)
        merge(advisorGroup, advisor.tokens, !advisor.complete || advisorModel === null || date === null)
      }
    }
  }

  #calendarDay(time: number): string {
    if (this.#formatter !== undefined)
      return calendarDay(time, this.#formatter)
    const day = Math.floor(time / 86_400_000)
    if (day !== this.#utcDay) {
      this.#utcDate = new Date(time).toISOString().slice(0, 10)
      this.#utcDay = day
    }
    return this.#utcDate
  }

  end(ref: SessionRef): void {
    const session = this.#lastRef === ref ? this.#lastSession : this.#sessions.get(refKey(ref))
    if (!session)
      return
    delete session.current
    session.assistant = undefined
    session.embeddedModels = undefined
    session.branches.clear()
    session.selectedDate = undefined
    session.selectedTimestamp = undefined
  }

  partition(): UsagePartition {
    for (const session of this.#sessions.values()) this.end(session.ref)
    return {
      schema: 'usage-partition/v1',
      sessions: Array.from(this.#sessions, ([key, session]) => ({
        key,
        groups: [...session.groups.values()],
        diagnostics: [...session.diagnostics],
        partial: session.partial,
        usageEventCount: session.usageEventCount,
        undatedUsageEventCount: session.undatedUsageEventCount,
      })),
      identities: Array.from(this.#identities, ([identity, session]) => [identity, refKey(session.ref)] as const),
    }
  }

  importPartition(partition: UsagePartition): void {
    if (partition.schema !== 'usage-partition/v1')
      throw new TypeError('unsupported usage partition')
    const keys = new Set<string>()
    for (const state of partition.sessions) {
      if (!this.#sessions.has(state.key) || keys.has(state.key) || this.#imported.has(state.key))
        throw new TypeError('unknown or repeated usage partition session')
      keys.add(state.key)
    }
    for (const [, key] of partition.identities) {
      if (!keys.has(key))
        throw new TypeError('identity points outside its usage partition')
    }
    for (const state of partition.sessions) {
      const session = this.#sessions.get(state.key)!
      this.end(session.ref)
      session.groups = new Map(state.groups.map(group => [JSON.stringify([group.date, group.model]), group]))
      delete session.lastGroup
      session.diagnostics = new Set(state.diagnostics)
      session.partial = state.partial
      session.usageEventCount = state.usageEventCount
      session.undatedUsageEventCount = state.undatedUsageEventCount
      this.#imported.add(state.key)
    }
    for (const [identity, key] of partition.identities) {
      const session = this.#sessions.get(key)!
      const previous = this.#identities.get(identity)
      if (previous !== undefined) {
        for (const affected of [previous, session]) {
          affected.partial = true
          affected.diagnostics.add('Repeated response identity was retained in the token sum; distinct billable work cannot be established.')
        }
      }
      this.#identities.set(identity, session)
    }
    this.#lastRef = undefined
    this.#lastSession = undefined
  }

  finish(): UsageReport {
    const allGroups: ModelAccumulator[] = []
    const byProvider = new Map<string, { aggregate: Aggregate, sessions: number, undated: number, diagnostics: Set<string> }>()
    for (const provider of this.#providerIds) {
      const diagnostics = new Set<string>()
      if (noUsage.has(provider))
        diagnostics.add('Huihua has no native usage mapping for this provider; token totals are unavailable.')
      else if (noTokenContract.has(provider))
        diagnostics.add('Native fields do not establish an additive token contract; token totals are unavailable.')
      byProvider.set(provider, { aggregate: empty(), sessions: 0, undated: 0, diagnostics })
    }
    const sessionReports = Array.from(this.#sessions.values(), (session): SessionUsageReport => {
      this.end(session.ref)
      const groups = [...session.groups.values()]
      if (session.partial) {
        for (const group of groups) group.partial = true
      }
      allGroups.push(...groups)
      const total = aggregate(groups, session.partial, session.usageEventCount)
      if (total.overflow.size > 0)
        session.diagnostics.add('Token aggregation exceeds the safe integer range; affected fields are unavailable.')
      const provider = byProvider.get(session.ref.provider)
      if (provider) {
        provider.sessions += 1
        provider.undated += session.undatedUsageEventCount
        merge(provider.aggregate, total, session.partial || total.partial, session.usageEventCount)
        for (const diagnostic of session.diagnostics) provider.diagnostics.add(diagnostic)
      }
      return {
        provider: session.ref.provider,
        id: session.ref.id,
        ...(session.ref.title === undefined ? {} : { title: session.ref.title }),
        source: session.ref.source,
        ...summary(total, session.partial),
        undatedUsageEventCount: session.undatedUsageEventCount,
        daily: daily(groups, session.partial),
        diagnostics: [...session.diagnostics].sort(),
      }
    }).sort((a, b) => JSON.stringify([a.provider, a.source, a.id]).localeCompare(JSON.stringify([b.provider, b.source, b.id])))
    const providers = Array.from(byProvider, ([provider, state]): ProviderUsageReport => ({ provider, ...summary(state.aggregate), sessionCount: state.sessions, undatedUsageEventCount: state.undated, diagnostics: [...state.diagnostics, ...(state.aggregate.overflow.size > 0 ? ['Token aggregation exceeds the safe integer range; affected fields are unavailable.'] : [])].sort() }))
    const events = sessionReports.reduce((sum, session) => sum + session.usageEventCount, 0)
    const total = aggregate(allGroups, sessionReports.some(session => session.availability !== 'complete' && session.usageEventCount > 0), events)
    return {
      schema: 'huihua-usage/v2',
      filters: {
        providers: this.#selected === undefined ? this.#providerIds : [...this.#selected].sort(),
        ...(this.#options.since === undefined ? {} : { since: this.#options.since }),
        ...(this.#options.until === undefined ? {} : { until: this.#options.until }),
        timeZone: this.#timeZone,
      },
      sessionsScanned: sessionReports.length,
      usageEventCount: events,
      undatedUsageEventCount: sessionReports.reduce((sum, session) => sum + session.undatedUsageEventCount, 0),
      daily: daily(allGroups),
      totals: summary(total),
      providers,
      sessions: sessionReports,
      semantics,
    }
  }
}

export function createUsageReport(refs: readonly SessionRef[], frames: ReadonlyMap<string, readonly SessionFrame[]>, options: ReportOptions = {}): UsageReport {
  const builder = new UsageReportBuilder(refs, options)
  for (const ref of refs) {
    for (const frame of frames.get(refKey(ref)) ?? []) builder.add(ref, frame)
    builder.end(ref)
  }
  return builder.finish()
}
export function formatUsageReport(report: UsageReport): string {
  const header = ['DATE', 'PROVIDER / MODEL', 'INPUT', 'OUTPUT', 'CACHE WRITE', 'CACHE READ', 'TOTAL', 'STATUS']
  const row = (date: string, model: string, tokens: TokenSummary): string[] => [date, model, ...tokenKeys.map(field => tokens[field] === null ? 'unavailable' : tokens[field].toLocaleString('en-US')), tokens.availability]
  const rows = [header]
  for (const day of report.daily) {
    rows.push(row(day.date ?? 'undated', 'all models', day))
    for (const model of day.modelBreakdowns) rows.push(row('', `${model.provider} / ${model.model ?? 'unknown'}`, model))
  }
  rows.push(row('TOTAL', 'all models', report.totals))
  const widths = header.map((_, index) => Math.max(...rows.map(cells => cells[index]!.length)))
  const table = rows.map(cells => cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  ')).join('\n')
  const diagnostics = report.providers.flatMap(provider => provider.diagnostics.map(message => `[${provider.provider}] ${message}`))
  return [table, '', `${report.sessionsScanned} sessions; timezone ${report.filters.timeZone}. Partial totals include only known counters; unavailable is not zero.`, ...(report.undatedUsageEventCount > 0 ? [`${report.undatedUsageEventCount} usage events have no usable timestamp.`] : []), ...diagnostics].join('\n')
}
