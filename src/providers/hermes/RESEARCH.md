# Hermes Agent compatibility evidence

Reviewed upstream source and documentation on 2026-10-05.

## Official facts

- [Source](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md): Current canonical storage is HERMES_HOME/state.db; sessions.json is a routing mirror, not the session list.
  JSONL exports contain a complete session with messages in each record.
  Historical snapshots and JSONL may remain on disk.
- [Source](https://github.com/NousResearch/hermes-agent/blob/main/hermes_state_common.py): sessions and messages are rowid tables.
  Message IDs define persisted order; timestamp, started_at and ended_at use epoch seconds.
  Native tool_calls are serialized JSON.
- [Source](https://github.com/NousResearch/hermes-agent/blob/main/hermes_state_messages.py): Structured content is sentinel-prefixed JSON.
  Ordinary text stays unchanged; inactive and compacted rows remain part of stored evidence.
- [Source](https://github.com/NousResearch/hermes-agent/blob/main/hermes_state.py): The content sentinel is the six-character string \0json:.
  Default database resolution follows HERMES_HOME.

## Third-party compatibility experience

Historical compatibility observations include per-session JSON snapshots with session_id/messages, and legacy JSONL.
Reading only those files misses current SQLite sessions.
Routing indexes do not establish conversation history.

## Huihua decisions

Discover state.db and sessions under HERMES_HOME or ~/.hermes; ignore sessions.json and index.json.
Accept hermes_sqlite with locator.id, hermes_json snapshots, and supplied JSONL captures/exports.
Preserve selected metadata, every message row including inactive rows, native JSON strings and complete snapshot objects.
Decode only the documented content sentinel, never arbitrary JSON-looking text.
Convert documented seconds to milliseconds without guessing other units.
Native tool calls, results and reasoning use the shared message mapper.
Do not traverse parent-session lineage, invoke repair/export commands, or query FTS/index tables.

The [pinned schema-drift fixture](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/Resources/Fixtures/stage0/agents/hermes/schema_drift.json) records role=tool with finish_reason=error.
The provider-local wrapper recognizes that explicit failure before delegating ordinary messages to the shared mapper.
Snapshot, JSONL and SQLite paths use this same rule and retain the original result object and native usage.

Fixtures combine local synthetic examples and pinned independent compatibility inputs; they do not establish release-wide correctness.
[Fixture provenance](../../../fixtures/compatibility/README.md) distinguishes upstream validation from the facts asserted through Huihua's public API.
[Architecture](../../../docs/architecture.md#provider-coverage-and-format-ownership) owns acquisition, evidence and resource-limit contracts.

## Observed pinned/latest session-state rows (2026-10-15)

The official pinned Hermes commit `0240fa4a84123406a0e5e6e7262e5b772b43f0bd`
and latest commit `30463589eb54fa0f48724594cc0e98e6b995729b` both produced a
readable `state.db` for the same text/resume journey.
All five inventory rows were
read; the first and resumed assistant replies remained attached to the expected
native message rows, and scan/read/snapshot/records/events completed before the
baseline check.

The sole observed drift was in the `state` inventory row.
Eight sampled metadata
fields changed between null and populated values (`chat_id`, `chat_type`,
`created_source`, `end_reason`, `ended_at`, `origin_json`, `session_key`, and
`user_id`); latest also populated `runtime_generation:number` and
`runtime_revision:number`.
Huihua currently maps only its established identity,
title, timestamps, workspace and parent fields, and preserves the complete native
row.
The new runtime counters and routing/account metadata are not given new
canonical meanings.

Keep the exact observed type alternatives optional only for the `state` record
kind and its global native paths, so both producer versions pass.
The variants
remain type-specific: any other type, record kind, field, or mapping regression
continues to fail.
These captures establish writer variation for this journey, not
a release-wide schema guarantee.

## October 20 native metadata review

### Official writer observations

The [2026-10-20 synthetic CI run](https://github.com/wibus-wee/huihua/actions/runs/39405791409)
used e3f75a002557cf20ee29a80b88b07d273066fad5.
The native session row adds `transcript_revision: 0`.
This sampled number is not a timestamp, message count, or documented canonical revision contract.
The SQLite reader already retains the whole state row.
Keep it raw and accept only the numeric path on the state inventory kind; do not derive updatedAt or rewrite message order.

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
