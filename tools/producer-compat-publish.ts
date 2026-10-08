import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

import type { LaneResult } from './producer-compat-daily.ts'
import { anomalyKey, completeMatrix, providers, renderDailyReport, replaceReportSection, reportMarker } from './producer-compat-daily.ts'

interface Issue { number: number, body: string | null, state: string, pull_request?: unknown }
interface Comment { id: number, body: string, user: { login: string, type: string } }
const repository = process.env.GITHUB_REPOSITORY ?? ''
assert(/^[\w.-]+\/[\w.-]+$/.test(repository))
const commit = process.env.GITHUB_SHA ?? ''
assert(/^[a-f\d]{40}$/.test(commit))
const runId = process.env.GITHUB_RUN_ID ?? ''
assert(/^\d+$/.test(runId))
const runUrl = `https://github.com/${repository}/actions/runs/${runId}`
const date = new Date().toISOString().slice(0, 10)
const directory = process.env.COMPAT_RESULTS_DIR ?? 'compat-results'
const results: LaneResult[] = []
for (const name of await readdir(directory)) {
  if (!name.endsWith('.json'))
    continue
  const value = JSON.parse(await readFile(join(directory, name), 'utf8')) as LaneResult
  assert(providers.includes(value.provider) && ['pinned', 'latest'].includes(value.lane), 'Unexpected provider/lane in artifact')
  assert(/^[a-z0-9-]+$/.test(value.stage), 'Invalid stage in artifact')
  assert(/^[a-z0-9.+-]+$/i.test(value.version), 'Invalid CLI version in artifact')
  assert(typeof value.version === 'string' && typeof value.detail === 'string' && typeof value.stage === 'string' && typeof value.commit === 'string')
  assert(['passed', 'read-failure', 'drift-review', 'environment-blocked', 'incomplete'].includes(value.verdict))
  assert(typeof value.outcome === 'string' && (value.verdict !== 'passed' || (value.outcome === 'success' && value.stage === 'passed')), 'Inconsistent pass result')
  assert([value.sessions, value.records].every(count => count === null || (Number.isSafeInteger(count) && count >= 0)), 'Invalid counts in result')
  results.push(value)
}
const matrix = completeMatrix(results, commit)
const report = renderDailyReport(matrix, date, runUrl, commit)
await writeFile(process.env.COMPAT_DAILY_REPORT ?? 'daily-compatibility.md', report)
console.log(report)
if (process.env.COMPAT_PUBLISH !== 'true')
  process.exit(0)
// Publication is confined to trusted default-branch scheduled/explicit manual runs.
assert(process.env.GITHUB_REF === `refs/heads/${process.env.COMPAT_DEFAULT_BRANCH}`)
assert(['schedule', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME ?? ''))
const token = process.env.GITHUB_TOKEN
assert(token !== undefined && token !== '')
const api = `https://api.github.com/repos/${repository}`
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${api}${path}`, { method, headers: { 'authorization': `Bearer ${token}`, 'accept': 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) })
  // No automatic retry of uncertain writes: the next run reconciles markers first.
  assert(response.ok, `GitHub ${method} ${path}: ${response.status}`)
  return await response.json() as T
}
async function pages<T>(path: string): Promise<T[]> {
  const values: T[] = []
  for (let page = 1; ; page++) {
    const batch = await request<T[]>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    values.push(...batch)
    if (batch.length < 100)
      return values
  }
}
const issues = (await pages<Issue>('/issues?state=all')).filter(issue => issue.pull_request === undefined)
const dashboards = issues.filter(issue => issue.body?.startsWith(reportMarker))
assert(dashboards.length <= 1, 'Multiple daily tracking issues; resolve manually rather than overwriting')
const dashboard = dashboards[0] ?? await request<Issue>('/issues', 'POST', { title: 'Daily producer compatibility checks', body: `${reportMarker}\nTracks real native session acquisition for Claude, Kimi and Codex. Managed results below; discussion and human notes outside the section are preserved.` })
assert(dashboard.state !== 'closed', 'Tracking issue is closed; do not reopen or overwrite it automatically')
await request(`/issues/${dashboard.number}`, 'PATCH', { body: replaceReportSection(dashboard.body ?? reportMarker, report) })
const dayMarker = `<!-- huihua-daily:${date} -->`
async function upsertComment(issue: number, marker: string, body: string): Promise<void> {
  const matches = (await pages<Comment>(`/issues/${issue}/comments`)).filter(comment => comment.body.startsWith(marker) && comment.user.login === 'github-actions[bot]')
  assert(matches.length <= 1, 'Duplicate daily comments; reconcile manually')
  if (matches[0])
    await request(`/issues/comments/${matches[0].id}`, 'PATCH', { body: `${marker}\n${body}` })
  else await request(`/issues/${issue}/comments`, 'POST', { body: `${marker}\n${body}` })
}
await upsertComment(dashboard.number, dayMarker, report)
const anomalies = new Map<string, LaneResult[]>()
for (const result of matrix.filter(result => result.verdict !== 'passed')) {
  const key = anomalyKey(result)
  anomalies.set(key, [...(anomalies.get(key) ?? []), result])
}
for (const [key, failures] of anomalies) {
  const first = failures[0]!
  const marker = `<!-- huihua-compat-anomaly:${key} -->`
  const matches = issues.filter(issue => issue.body?.startsWith(marker))
  assert(matches.length <= 1, 'Duplicate anomaly issues; reconcile manually')
  const title = `[compatibility] ${first.provider}: ${first.verdict} at ${first.stage}`
  const evidence = report
  const issue = matches[0] ?? await request<Issue>('/issues', 'POST', { title, body: `${marker}\n${title}\n\nThis is an automatically detected compatibility anomaly, not a confirmed parser root cause.\n\n${evidence}` })
  await upsertComment(issue.number, dayMarker, `Observed in ${failures.map(result => result.lane).join(', ')}. [Evidence and reproducible synthetic stores](${runUrl}).\n\n${failures.map(result => `${result.provider}/${result.lane}: ${result.verdict}, stage ${result.stage}, CLI ${result.version}`).join('\n')}`)
}
console.log(`Tracking issue: https://github.com/${repository}/issues/${dashboard.number}`)
