export interface CompatibilityProgress {
  stage: string
  completed: string[]
  auditedSessions?: number
  auditedRecords?: number
  error?: string
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

export function renderCompatibilitySummary(progress: CompatibilityProgress | undefined, outcome: string, provider: 'claude' | 'kimi' | 'codex' = 'claude'): string {
  const selectedChecks = provider === 'kimi' ? checks.slice(0, 5) : checks
  const passed = outcome === 'success' && progress?.stage === 'passed' && selectedChecks.every(([key]) => progress.completed.includes(key))
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('\n', '<br>')
  const rows = selectedChecks.map(([key, label]) => `| ${label} | ${progress?.completed.includes(key) ? 'PASS' : progress?.stage === key ? 'FAIL' : 'NOT RUN'} |`)
  return [
    '## Huihua reading compatibility',
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
    provider === 'codex' ? 'Scope: Codex text, synthetic file-read tool roundtrip and resume. No other providers or scenarios are covered by this lane.' : provider === 'kimi' ? 'Scope: Kimi text and resume in one native session. No tool, subagent or native-shape baseline coverage is claimed.' : 'Scope: Claude only; two independent sessions including a Read tool roundtrip and resume. PASS does not imply other providers or scenarios are covered.',
    '',
    `Download ${provider === 'codex' ? 'synthetic-codex-compatibility' : provider === 'kimi' ? 'synthetic-kimi-compatibility' : 'synthetic-producer-compatibility'} from this run’s Artifacts for JSON reports, native inventory, stores and diagnostics.`,
    '',
  ].join('\n')
}
