# OpenClaw compatibility evidence

Reviewed upstream source and documentation on 2026-10-05.

## Official facts

- [Source](https://github.com/openclaw/openclaw/blob/main/docs/reference/session-management-compaction/store.md): Current runtime transcripts live in per-agent agent/openclaw-agent.sqlite; sessions directories retain legacy JSONL artifacts. session_windows owns transcript generations.
- [Source](https://github.com/openclaw/openclaw/blob/main/src/state/openclaw-agent-schema.sql): transcript_events selects session_id and orders by seq.
  Payloads are event_json TEXT or event_zstd BLOB with declared event_utf8_bytes; unrelated indexing and runtime tables are separate owners.
- [Source](https://github.com/openclaw/openclaw/blob/main/docs/reference/session-management-compaction/schema.md): Transcript entries retain the session header, messages, parentId edges, model/thinking changes, compaction and reset observations.

## Third-party compatibility experience

Older compatibility readers commonly cover Pi-shaped JSONL rather than the current SQLite store.
A session parentSession path is evidence, not necessarily a canonical session ID.
These observations do not establish coverage of every database migration.

## Huihua decisions

Discover OPENCLAW_STATE_DIR/agents or ~/.openclaw/agents, plus legacy ~/.clawdbot/agents when no override exists.
Exclude trajectory logs.
Select a SQLite session window through locator.id, preserve its row and all selected transcript rows, and decode Zstandard through the existing bounded binary reader.
Verify declared decompressed size.
Keep resets, branches and compactions as observations; do not reconstruct current context.
Native compressed bytes and decoded JSON text remain reachable.
Cold archives, encrypted storage locations, incognito memory and live Gateway calls are outside coverage.

The [pinned discovery](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/OpenClawSessionDiscovery.swift) includes .jsonl.deleted.* history.
Huihua admits those physical recordings through the existing JSONL mapper while retaining trajectory exclusions.
Deleted files are independent evidence; they are never restored or rewritten.

Fixtures combine local synthetic examples and pinned independent compatibility inputs; they do not establish release-wide correctness.
[Fixture provenance](../../../fixtures/compatibility/README.md) distinguishes upstream validation from the facts asserted through Huihua's public API.
[Architecture](../../../docs/architecture.md#provider-coverage-and-format-ownership) owns acquisition, evidence and resource-limit contracts.
