import { createHash } from 'node:crypto'

import type { CompatibilityProgress } from './producer-compat-summary.ts'

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
  return { provider, lane, version, commit, outcome, stage, verdict, detail: error.split('\n')[0]!.slice(0, 240), sessions: progress?.auditedSessions ?? null, records: progress?.auditedRecords ?? null }
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
  return createHash('sha256').update(JSON.stringify([result.provider, result.verdict, result.stage, normalized])).digest('hex').slice(0, 20)
}

export function renderDailyReport(results: LaneResult[], date: string, runUrl: string, commit: string): string {
  const matrix = completeMatrix(results, commit)
  const rows = matrix.map(result => `| ${result.provider} | ${result.lane} | ${escape(result.version)} | ${result.verdict} | ${escape(result.stage)} | ${result.sessions ?? '—'} / ${result.records ?? '—'} |`)
  const notes = matrix.filter(result => result.verdict !== 'passed').map(result => `- ${result.provider}/${result.lane}: ${escape(result.detail || 'No complete passing evidence.')} [Run evidence](${runUrl})`)
  return [
    `## Daily compatibility — ${date} (UTC)`,
    '',
    `Huihua commit: ${commit}. [Actions and synthetic artifacts](${runUrl}).`,
    '',
    '| Provider | Lane | CLI version | Verdict | Stage | Sessions / raw rows |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...notes,
    '',
    '### What is checked',
    '- Real native discovery and raw evidence preservation',
    '- Supported messages, tool/usage mappings and read/snapshot/stream consistency',
    '- Fixed-version regression versus latest-version compatibility',
    '- Reviewed schema/unknown/diagnostics drift; never auto-update baselines',
    '',
    '### Not covered',
    '- Kimi: tool roundtrip and native shape/unknown/diagnostics baseline',
    '- All providers: cancellation, compaction, archive transitions, subagent journeys and arbitrary historical/corrupt stores',
    '',
    'A read-failure needs investigation; it is not an automatic root-cause diagnosis. A drift-review needs native evidence review. Environment failures are not parser bugs. Missing results never count as PASS.',
    'If pinned passes but latest fails, investigate the producer-version change first; if both fail, compare Huihua changes and runner/setup evidence.',
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
