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
