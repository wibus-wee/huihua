import { appendFile, readFile } from 'node:fs/promises'
import process from 'node:process'

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
const summary = renderCompatibilitySummary(progress, process.env.COMPAT_OUTCOME ?? 'unknown')
if (process.env.GITHUB_STEP_SUMMARY !== undefined && process.env.GITHUB_STEP_SUMMARY !== '')
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
else
  console.log(summary)
