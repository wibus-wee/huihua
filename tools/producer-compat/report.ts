import { createHash } from 'node:crypto'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

import type { NativeDrift } from './runtime.ts'

export interface CompatibilityProgress {
  stage: string
  completed: string[]
  auditedSessions?: number
  auditedRecords?: number
  error?: string
  drift?: NativeDrift
}

const checks = [
  ['scan', 'Discovery / scan'],
  ['read', 'Read'],
  ['snapshot', 'Snapshot'],
  ['records', 'Streamed records'],
  ['events', 'Streamed events'],
  ['scenario', 'Text / tool roundtrip / resume'],
  ['baseline', 'Native shape / unknown / diagnostics baseline'],
] as const

export function renderCompatibilitySummary(progress: CompatibilityProgress | undefined, outcome: string, provider: 'claude' | 'kimi' | 'codex' = 'claude', lane: 'pinned' | 'latest' = 'pinned'): string {
  const selectedChecks = provider === 'kimi' ? checks.slice(0, 5) : checks
  const passed = outcome === 'success' && progress?.stage === 'passed' && selectedChecks.every(([key]) => progress.completed.includes(key))
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('\n', '<br>')
  const rows = selectedChecks.map(([key, label]) => `| ${label} | ${progress?.completed.includes(key) ? 'PASS' : progress?.stage === key ? 'FAIL' : 'NOT RUN'} |`)
  return [
    '## Huihua reading compatibility',
    `Lane: ${lane}`,
    '',
    `Result: ${passed ? 'PASS' : outcome === 'skipped' ? 'NOT RUN' : 'FAIL / INCOMPLETE'}`,
    '',
    `Native sessions: ${progress?.auditedSessions ?? 'not inventoried'}`,
    `Native records: ${progress?.auditedRecords ?? 'not inventoried'}`,
    '',
    '| Check | Result |',
    '| --- | --- |',
    ...rows,
    '',
    ...(passed ? [] : [`Failed stage: ${escape(progress?.stage ?? 'setup / harness startup')}`, '', escape(progress?.error ?? 'No audit evidence for successful completion. Inspect the failed step logs.')]),
    '',
    ...renderNativeDrift(progress?.drift),
    provider === 'codex' ? 'Scope: Codex text, synthetic file-read tool roundtrip and resume. No other providers or scenarios are covered by this lane.' : provider === 'kimi' ? 'Scope: Kimi text and resume in one native session. No tool, subagent or native-shape baseline coverage is claimed.' : 'Scope: Claude only; two independent sessions including a Read tool roundtrip and resume. PASS does not imply other providers or scenarios are covered.',
    '',
    `Download ${provider === 'codex' ? 'synthetic-codex-compatibility' : provider === 'kimi' ? 'synthetic-kimi-compatibility' : 'synthetic-producer-compatibility'}-${lane} from this run’s Artifacts for JSON reports, native inventory, stores and diagnostics.`,
    '',
  ].join('\n')
}

export const providers = ['claude', 'kimi', 'codex'] as const
export type Provider = typeof providers[number]
export type Lane = 'pinned' | 'latest'
type Verdict = 'passed' | 'read-failure' | 'drift-review' | 'environment-blocked' | 'incomplete'
export interface LaneResult {
  provider: Provider
  lane: Lane
  version: string
  commit: string
  outcome: string
  stage: string
  verdict: Verdict
  detail: string
  drift?: NativeDrift
  sessions: number | null
  records: number | null
}
export const reportMarker = '<!-- huihua-daily-compatibility:v1 -->'
const sectionStart = '<!-- huihua-daily-results:start -->'
const sectionEnd = '<!-- huihua-daily-results:end -->'
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('@', '&#64;').replace(/[\r\n]+/g, ' ')

export function laneResult(provider: Provider, lane: Lane, version: string, commit: string, outcome: string, progress?: CompatibilityProgress, evidenceOutcome = 'success'): LaneResult {
  if (evidenceOutcome !== 'success')
    return { provider, lane, version, commit, outcome, stage: 'evidence-upload', verdict: 'incomplete', detail: `Synthetic evidence upload: ${evidenceOutcome}; check the artifact step.`, sessions: progress?.auditedSessions ?? null, records: progress?.auditedRecords ?? null }
  const stage = progress?.stage ?? 'setup'
  const error = progress?.error ?? ''
  const expected = provider === 'kimi' ? ['scan', 'read', 'snapshot', 'records', 'events'] : ['scan', 'read', 'snapshot', 'records', 'events', 'scenario', 'baseline']
  const complete = outcome === 'success' && stage === 'passed' && expected.every(key => progress?.completed.includes(key))
  const infrastructure = /bwrap:|sandbox helper|socket directory|ECONN|ENOTFOUND|timed? ?out|ETIMEDOUT|authentication|unauthorized|rate.limit/i.test(error)
  const verdict: Verdict = complete ? 'passed' : infrastructure ? 'environment-blocked' : stage === 'baseline' ? 'drift-review' : ['scan', 'read', 'snapshot', 'records', 'events', 'scenario'].includes(stage) ? 'read-failure' : ['producer', 'simulator-startup', 'scenario-setup'].includes(stage) || stage.startsWith('producer-') ? 'environment-blocked' : 'incomplete'
  return { provider, lane, version, commit, outcome, stage, verdict, detail: error.split('\n')[0]!.slice(0, 240), ...(progress?.drift ? { drift: progress.drift } : {}), sessions: progress?.auditedSessions ?? null, records: progress?.auditedRecords ?? null }
}

export function completeMatrix(results: LaneResult[], commit: string): LaneResult[] {
  return providers.flatMap(provider => (['pinned', 'latest'] as const).map((lane) => {
    const matches = results.filter(result => result.provider === provider && result.lane === lane && result.commit === commit)
    if (matches.length === 1)
      return matches[0]!
    return { ...laneResult(provider, lane, 'unavailable', commit, 'missing'), detail: matches.length ? 'Duplicate result artifacts; review required.' : 'No result artifact; installation, cancellation or upload may have failed.' }
  }))
}

export function anomalyKey(result: LaneResult): string {
  // Stable across dates, run IDs, temporary paths and provider versions. Lane is excluded
  // so the same defect in pinned/latest updates one issue rather than creating two.
  const normalized = result.detail.replace(/(?:\/[\w.@+-]+)+/g, '<path>').replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, '<id>').replace(/\d+(?:\.\d+)*/g, '#')
  return createHash('sha256').update(JSON.stringify([result.provider, result.verdict, result.stage, normalized, ...(result.drift ? [[...result.drift.added].sort(), [...result.drift.removed].sort()] : [])])).digest('hex').slice(0, 20)
}

function renderNativeDrift(drift: NativeDrift | undefined): string[] {
  if (!drift)
    return []
  const rows = (paths: string[], label: string) => paths.slice(0, 20).map(path => `- ${label}: ${escape(path).slice(0, 160)}`)
  return [
    `Native field/type changes: +${drift.added.length} / -${drift.removed.length}`,
    ...rows(drift.added, 'Added'),
    ...rows(drift.removed, 'Removed'),
    ...(drift.added.length > 20 || drift.removed.length > 20 || [...drift.added, ...drift.removed].some(path => escape(path).length > 160) ? ['Showing up to 20 paths per direction, shortened to 160 characters; the complete diff is in the synthetic progress artifact.'] : []),
    '',
  ]
}

export function renderDailyReport(results: LaneResult[], date: string, runUrl: string, commit: string): string {
  const matrix = completeMatrix(results, commit)
  const failures = matrix.filter(result => result.verdict !== 'passed')
  const passed = matrix.length - failures.length
  const label: Record<Verdict, string> = {
    'passed': '✅ PASS',
    'read-failure': '🔴 Read failure',
    'drift-review': '🟠 Drift review',
    'environment-blocked': '🟡 Environment blocked',
    'incomplete': '⚪ Incomplete',
  }
  const coverage = {
    claude: 'Text · Read tool · resume · native baseline',
    kimi: 'Text · resume only',
    codex: 'Text · exec_command tool · resume · native baseline',
  }
  const cell = (result: LaneResult) => `${label[result.verdict]}<br>${escape(result.version)}`
  const rows = providers.map((provider) => {
    const lanes = matrix.filter(result => result.provider === provider)
    return `| ${provider} | ${cell(lanes[0]!)} | ${cell(lanes[1]!)} | ${coverage[provider]} |`
  })
  const actions = failures.map((result) => {
    const next = result.verdict === 'drift-review'
      ? 'Review the native diff before accepting any baseline change.'
      : result.verdict === 'environment-blocked'
        ? 'Inspect producer setup and runner logs; no parser verdict is established.'
        : result.verdict === 'incomplete'
          ? 'Recover the missing result or evidence before drawing a conclusion.'
          : 'Compare native records with Huihua output at the failed stage.'
    return [`- **${escape(result.provider)}/${result.lane} · ${label[result.verdict]}** — ${escape(result.stage)}: ${escape(result.detail || 'No complete passing evidence.')} ${next}`, ...renderNativeDrift(result.drift).map(line => line ? `  ${line}` : '')].join('\n')
  })
  return [
    `## Huihua Daily Compatibility · ${date} (UTC)`,
    '',
    failures.length ? `> [!WARNING]\n> **${failures.length} lane(s) need attention · ${passed}/6 covered lanes passed.**` : '> [!NOTE]\n> **6/6 covered lanes passed.** Coverage gaps below remain untested.',
    '',
    ...(failures.length ? ['### Needs attention', '', ...actions, '', `[Inspect this run and its synthetic evidence](${runUrl})`, ''] : []),
    '| Provider | Pinned | Latest | Exercised journey |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    '### Coverage gaps',
    '- **Kimi:** no tool roundtrip or native shape/unknown/diagnostics baseline yet.',
    '- **All providers:** cancellation, compaction, archive transitions, subagents and arbitrary historical/corrupt stores are outside these scenarios.',
    '',
    '<details>',
    '<summary>Evidence and interpretation</summary>',
    '',
    `Huihua commit: ${commit}. [Actions logs and synthetic artifacts](${runUrl}).`,
    '',
    '| Provider / lane | Last stage | Native sessions / rows |',
    '| --- | --- | --- |',
    ...matrix.map(result => `| ${result.provider} / ${result.lane} | ${escape(result.stage)} | ${result.sessions ?? '—'} / ${result.records ?? '—'} |`),
    '',
    'Each covered journey checks native discovery, complete raw evidence, supported mappings and read/snapshot/stream consistency. Counts are inventory, not a coverage score.',
    '',
    '- **Read failure:** an assertion failed; the root cause still needs investigation.',
    '- **Drift review:** inspect native changes; baselines are never updated automatically.',
    '- **Environment blocked:** producer/setup failed; this is not a confirmed parser defect.',
    '- **Incomplete:** missing, duplicate or unavailable evidence never counts as PASS.',
    '- If pinned passes and latest fails, inspect the producer-version change first. If both fail, compare Huihua changes and runner/setup evidence.',
    '',
    '</details>',
    '',
    'Updated by GitHub Actions. Daily history is retained in dated bot comments; repeated anomalies update their existing issue.',
    '',
  ].join('\n')
}

export function replaceReportSection(body: string, report: string): string {
  const start = body.indexOf(sectionStart)
  const end = body.indexOf(sectionEnd)
  if (start < 0 && end < 0)
    return `${body}\n\n${sectionStart}\n${report}\n${sectionEnd}`
  if (start < 0 || end < start || body.includes(sectionStart, start + 1) || body.includes(sectionEnd, end + 1))
    throw new Error('Ambiguous managed issue section; preserve human edits and stop')
  return `${body.slice(0, start)}${sectionStart}\n${report}\n${sectionEnd}${body.slice(end + sectionEnd.length)}`
}
async function main(): Promise<void> {
  let progress: CompatibilityProgress | undefined
  try {
    progress = JSON.parse(await readFile(`${process.env.COMPAT_REPORT}.progress.json`, 'utf8')) as CompatibilityProgress
  }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error
  }
  const evidenceOutcome = process.env.COMPAT_EVIDENCE_OUTCOME
  const displayProgress = evidenceOutcome !== undefined && evidenceOutcome !== 'success' ? { ...progress, completed: progress?.completed ?? [], stage: 'evidence-upload', error: `Synthetic evidence upload: ${evidenceOutcome}` } : progress
  const summary = renderCompatibilitySummary(displayProgress, process.env.COMPAT_OUTCOME ?? 'unknown', process.env.COMPAT_PROVIDER === 'codex' ? 'codex' : process.env.COMPAT_PROVIDER === 'kimi' ? 'kimi' : 'claude', process.env.COMPAT_LANE === 'latest' ? 'latest' : 'pinned')
  if (process.env.GITHUB_STEP_SUMMARY !== undefined && process.env.GITHUB_STEP_SUMMARY !== '')
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
  else
    console.log(summary)

  if (process.env.COMPAT_RESULT_PATH !== undefined) {
    const provider = process.env.COMPAT_PROVIDER === 'codex' ? 'codex' : process.env.COMPAT_PROVIDER === 'kimi' ? 'kimi' : 'claude'
    const result = laneResult(provider, process.env.COMPAT_LANE === 'latest' ? 'latest' : 'pinned', process.env.COMPAT_CLI_VERSION ?? 'unavailable', process.env.GITHUB_SHA ?? 'local', process.env.COMPAT_OUTCOME ?? 'unknown', progress, evidenceOutcome ?? 'missing')
    await writeFile(process.env.COMPAT_RESULT_PATH, JSON.stringify(result, null, 2))
  }
}

if (import.meta.main)
  await main()
