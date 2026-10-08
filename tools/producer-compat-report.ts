import { appendFile, readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

import { laneResult } from './producer-compat-daily.ts'
import type { CompatibilityProgress } from './producer-compat-summary.ts'
import { renderCompatibilitySummary } from './producer-compat-summary.ts'

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
