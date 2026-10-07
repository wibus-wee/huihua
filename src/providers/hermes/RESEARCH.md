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
