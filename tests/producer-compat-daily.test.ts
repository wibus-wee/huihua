import assert from 'node:assert/strict'
import { test } from 'node:test'

import { anomalyKey, completeMatrix, laneResult, renderDailyReport, replaceReportSection } from '../tools/producer-compat-daily.ts'

const sha = 'a'.repeat(40)
const success = { stage: 'passed', completed: ['scan', 'read', 'snapshot', 'records', 'events', 'scenario', 'baseline'], auditedSessions: 1, auditedRecords: 29 }

await test('daily classification distinguishes complete, drift, reader and infrastructure failures', () => {
  assert.equal(laneResult('codex', 'pinned', '0.161.0', sha, 'success', success).verdict, 'passed')
  assert.equal(laneResult('codex', 'pinned', '0.161.0', sha, 'success', { ...success, completed: [] }).verdict, 'incomplete')
  assert.equal(laneResult('codex', 'latest', '0.161.0', sha, 'failure', { stage: 'baseline', completed: [], error: 'native field/type drift' }).verdict, 'drift-review')
  assert.equal(laneResult('kimi', 'pinned', '2.1.1', sha, 'failure', { stage: 'read', completed: [], error: 'missing assistant replies' }).verdict, 'read-failure')
  assert.equal(laneResult('codex', 'pinned', '0.161.0', sha, 'failure', { stage: 'scenario', completed: [], error: 'bwrap: loopback Operation not permitted' }).verdict, 'environment-blocked')
  assert.equal(laneResult('claude', 'latest', 'unavailable', sha, 'skipped').verdict, 'incomplete')
})

await test('daily report never hides missing, duplicate, stale or uncovered results', () => {
  const result = laneResult('kimi', 'pinned', '2.1.1', sha, 'success', success)
  assert.equal(completeMatrix([result], sha).filter(value => value.verdict === 'passed').length, 1)
  assert.equal(completeMatrix([result, result], sha).filter(value => value.verdict === 'passed').length, 0)
  assert.equal(completeMatrix([{ ...result, commit: 'b'.repeat(40) }], sha).filter(value => value.verdict === 'passed').length, 0)
  const report = renderDailyReport([result], '2026-10-08', 'https://github.com/wibus-wee/huihua/actions/runs/1', sha)
  assert.match(report, /Kimi: tool roundtrip and native shape/)
  assert.match(report, /codex \| latest \| unavailable \| incomplete/)
  assert.match(report, /2026-10-08 \(UTC\)/)
})

await test('anomaly identity is stable across lane, version, dates, paths and UUIDs', () => {
  const result = laneResult('codex', 'pinned', '0.161.0', sha, 'failure', { stage: 'read', completed: [], error: '/tmp/run-123/rollout.jsonl: missing 2 records for 12345678-1234-1234-1234-123456789abc' })
  assert.equal(anomalyKey(result), anomalyKey({ ...result, lane: 'latest', version: '0.162.0', detail: '/tmp/run-999/rollout.jsonl: missing 3 records for aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }))
  assert.notEqual(anomalyKey(result), anomalyKey({ ...result, provider: 'kimi' }))
  assert.notEqual(anomalyKey(result), anomalyKey({ ...result, stage: 'baseline' }))
})

await test('managed issue updates preserve human text and reject ambiguous markers', () => {
  const first = replaceReportSection('Human introduction', 'day one')
  const second = replaceReportSection(`${first}\nHuman follow-up`, 'day two')
  assert.match(second, /^Human introduction/)
  assert.match(second, /Human follow-up$/)
  assert.doesNotMatch(second, /day one/)
  assert.equal(replaceReportSection(second, 'day two'), second)
  assert.throws(() => replaceReportSection('<!-- huihua-daily-results:start -->', 'no'), /Ambiguous/)
  assert.throws(() => replaceReportSection(`${first}\n${first}`, 'no'), /Ambiguous/)
})

await test('failure details cannot inject mentions, table rows or HTML into public reports', () => {
  const result = laneResult('kimi', 'latest', '2.1.1', sha, 'failure', { stage: 'read', completed: [], error: '@everyone <script> | injected\nsecret second line' })
  const report = renderDailyReport([result], '2026-10-08', 'https://github.com/wibus-wee/huihua/actions/runs/1', sha)
  assert.doesNotMatch(report, /@everyone|<script>|secret second line/)
  assert.match(report, /&#64;everyone &lt;script&gt; &#124;/)
})
