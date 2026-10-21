# GitHub Copilot CLI compatibility evidence

Reviewed upstream source and documentation on 2026-10-05.

## Official facts

- [Source](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts): The official generated event contract defines session.start context, user/assistant messages, toolRequests, execution start/completion, reasoning and usage.
  Native event envelopes carry IDs, timestamps and parentId.
- [Source](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-command-reference): The CLI supports local session persistence.
  Session-state directories and historical flat JSONL files are compatibility inputs, not a stable SDK export guarantee.

## Third-party compatibility experience

Compatibility observations include both flat session-state JSONL and per-session events.jsonl.
Assistant toolRequests and execution_start can mirror one call; removing either loses an observation.
These observations do not certify every CLI release.

## Huihua decisions

Discover ~/.copilot/session-state and accept explicit roots.
Map only confirmed event fields, retain both mirrored calls and their native IDs, keep arguments unchanged, and preserve future events as unknown.
Map standalone assistant.reasoning content and recorded message reasoning; null reasoning fields do not establish a reasoning observation.
Usage objects remain native; no quota or price calculation.
Folder-trust prose never establishes a workspace.
Attachment references remain data and are never opened.

The [pinned compatibility telemetry](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Telemetry/CopilotTelemetryAccumulator.swift) accepts tokenDetails-only session.shutdown records.
Huihua preserves those complete shutdown counters as Usage even without modelMetrics.
They remain process summaries, excluded from the Usage CLI's response/day totals; preserving a summary is not permission to add it twice.

Fixtures combine local synthetic examples and pinned independent compatibility inputs; they do not establish release-wide correctness.
[Fixture provenance](../../../fixtures/compatibility/README.md) distinguishes upstream validation from the facts asserted through Huihua's public API.
[Architecture](../../../docs/architecture.md#provider-coverage-and-format-ownership) owns acquisition, evidence and resource-limit contracts.

## Captured CLI 1.0.95 usage records (2026-10-10)

The repository's [live run](https://github.com/wibus-wee/huihua/actions/runs/38047648682)
contains two `session.usage_record` objects with per-call `data.usage` and increasing
accounting sequence numbers.
Shutdown records separately retain cumulative accounting.
These are observations of the official writer under the synthetic scenario, not a guarantee
about all historical stores.
No third-party account data is included.

Map object-valued `data.usage` to the existing usage primitive; retain the complete native
record and envelope, including model and accounting facts.
Malformed values stay unknown.
The usage consumer accepts these per-call counters but excludes checkpoint/shutdown summaries
from additive totals.
It does not infer that caches or partial counters are complete.
See the captured fixtures and their provenance in fixtures/copilot/LIVE-CAPTURE.md.

The 2026-10-11 fresh CI replay additionally showed that `usageAccountingWatermarks` keys
are per-session UUIDs.
The Copilot drift summary normalizes only UUID keys at that exact
map path to `{sessionId}`; value types and unexpected non-UUID keys still fail comparison.
This does not alter stored native records or production normalization.

## Observed CLI 1.0.95 / 1.0.97 system-message drift (2026-10-15)

### Official writer observations

[Issue #43](https://github.com/wibus-wee/huihua/issues/43) reports four removed native
field/type paths under `system.message.data.contentBlocks` in CLI 1.0.97.
Fresh runs of the official npm writers reproduce exactly that drift using the
manifest-pinned simulator.
Both versions retain the complete system body in
`data.content`; only the 1.0.95 capture includes the block array and `isStatic`.
See [capture provenance and hashes](../../../fixtures/copilot/LIVE-CAPTURE.md).
These are observed writer outputs, not a release-wide storage contract.

### Third-party compatibility evidence

No additional third-party evidence is used to infer the meaning of the absent
block array or static marker.
An absent marker does not imply either boolean value.

### Huihua decision

Keep production normalization unchanged: system messages already preserve their
complete native payload, and user/assistant messages read `data.content`.
Do not introduce CLI-version branches or synthesize missing block/static facts.
The native audit now independently asserts the full system-message payload and its
record association across read, snapshot and stream interfaces, in addition to raw
record and first/resumed text preservation.
Mark only the four reviewed field/type paths optional in the shared Copilot baseline
so both recorded representations remain accepted.
Retain all other drift checks,
including unexpected types at those paths.
Tool calls remain outside this journey.

## Observed CLI 1.0.98 session-resume state (2026-10-15)

The official CLI 1.0.98 package installed by the compatibility run includes
`sessionWasActive:boolean` in its bundled `session-events.schema.json` for
`session.resume`.
Its schema description distinguishes a resume that joins a
still-active session, where pending work remains in flight, from one where pending
work is normally interrupted.
The 1.0.98 native capture records
`data.sessionWasActive: false`; the 1.0.95 capture does not contain this field.

Huihua's existing system event retains the complete native `session.resume`
payload.
Keep that mapping and do not create a separate activity primitive or infer
pending tool-call state.
Mark only the exact boolean path optional in global and
`session.resume`-grouped drift checks so the two observed writer shapes pass;
other types, record kinds and unknown fields remain review failures.

## October 20 native metadata review

### Official writer observations

The [2026-10-20 synthetic CI run](https://github.com/wibus-wee/huihua/actions/runs/39405791409)
used 1.0.100.
Each `session.usage_record.data.usage` adds `providerType: "anthropic"`.
The existing usage event preserves the entire usage object, including this field, without inferring a new model identity or changing token totals.
Accept only the string path on `session.usage_record`; other types and record kinds still fail.

### Third-party evidence and decision

No third-party interpretation is used for these new fields.
These are empirical
writer observations, not a release-wide storage contract.
Production mappings,
public primitives and dependency versions stay unchanged.
Focused tests retain
old-writer acceptance and reject wrong types, wrong record kinds, unknown growth
and missing required fields.
See the capture hashes and replay scope in
[producer compatibility](../../../docs/producer-compatibility.md#october-20-metadata-review).

## October 21 native metadata review

### Official writer observations and decision

The official 1.0.101 capture in [daily run 39583348520](https://github.com/wibus-wee/huihua/actions/runs/39583348520) adds three numeric fields to `session.usage_record.data.usage`: `customToolCallCount`, `orphanToolCallCount` and `unmatchedToolResultCount`.
Both captured usage records report zero for all three; tests use distinct nonzero values to verify preservation rather than accidental defaulting.

Keep the complete usage object under the existing usage event.
These counters do not establish tool names, arguments or individual tool executions.
Only these three numeric paths on this record kind become optional in the compatibility baseline; no unknown budget or production mapping changes.

### Evidence limits

No third-party interpretation is used.
These are observed synthetic official-writer captures, not a release-wide storage contract.
Pinned and latest captures pass local replay; existing journey coverage gaps remain.
See [capture evidence](../../../docs/producer-compatibility.md#october-21-telemetry-review).
