# fx compatibility evidence

Reviewed upstream source and documentation on 2026-10-08.

## Official facts

- [v0.0.13 metadata codec](https://github.com/vercel-labs/fx/blob/4d966e272cfc4296cdf703f409480088cf2e72ba/src/core/session/session_codec.zig) writes schema-4 `session.json` as metadata, without conversation history.
- [v0.0.13 conversation frames](https://github.com/vercel-labs/fx/blob/4d966e272cfc4296cdf703f409480088cf2e72ba/src/core/session/session_event.zig) writes schema-3 `events.jsonl` and accepts frame versions 1 through 3.
  Each envelope has `seq`, `timestamp_ms` and a single tagged `event`.
  User/assistant/steering text, tool calls/results, interruptions, turn completion and context checkpoints have separate payloads.
  Tool arguments remain JSON strings; tool results include previews and artifact references rather than necessarily containing their complete output.
- [Source](https://github.com/vercel-labs/fx/blob/main/src/core/session/session_codec.zig): Durable session state retains history and tool-step snapshots.
  Text is a JSON string or a base64 durable-byte object; the general base64 codec belongs to Node.
- [Source](https://github.com/vercel-labs/fx/blob/main/src/core/session/session_json.zig): The event_log_v1 manifest and checkpoint snapshot have separately versioned metadata and state.
  History includes assistant, interrupted, background_command and compacted_summary.
- [Source](https://github.com/vercel-labs/fx/blob/main/src/core/shared/types.zig): Persisted tool status distinguishes success and failure; arguments_json is a native string rather than an already-decoded object.

## Third-party compatibility experience

Compatibility observations confirm manifest schema 3, checkpoint schema 1 and these history kinds.
A checkpoint is a durable snapshot, not proof that the complete event-log tail has been included.

## Huihua decisions

Discover ~/.fx/sessions/**/session.json and read the adjacent checkpoint.json through bounded JSON acquisition.
Select the manifest/checkpoint native identity, preserve complete files, and map recorded history/tool steps without loading output handles, command logs, current workspace files or artifact references.
Keep tool arguments as strings and invalid UTF-8 durable bytes as structured evidence.
Always diagnose that records after through_seq are not replayed.
This legacy path remains unchanged, including its partial-parse diagnostic; it does not replay the old event-log tail.

For schema-4 metadata, the provider composes the existing bounded `readJson`, `jsonLines` and `Ingestion` helpers.
It reads the adjacent conversation log in physical order, retains every envelope and original line, and maps text/tool facts with the envelope timestamp and native sequence as evidence.
Repeated sequences and call IDs are not deduplicated or used to reconstruct runtime state.
Unknown kinds, malformed rows and unsupported future frame versions remain unknown evidence with diagnostics; later readable rows continue.
Unknown metadata versions still fail explicitly.
Missing conversation logs fail instead of returning an apparently complete empty session.
Context checkpoints and completion records remain system facts; they neither erase history nor invent per-response model/usage facts.
Interruptions preserve recorded partial text and the terminal payload.
Tool result artifact references, image paths, permission/recovery files and current workspace files are never followed.
Optional display titles remain separately preserved evidence.

The provider owns the version dispatch rather than widening the generic snapshot factory to understand a particular event store.
The old snapshot mapper and new conversation mapper describe distinct official formats; both reuse shared acquisition rather than adding a parser or dependency.
The handle conservatively remains `buffered` because legacy checkpoints are complete JSON records, even though current log rows use incremental framing.
There is no public API or agent-session/v1 change.

`fixtures/fx/current/` is an unchanged synthetic capture from the official Linux x86_64 fx 0.0.13 binary (SHA256 `00def23f9c68ef538d7d967394c3491910793461884fad0b983cb74011b9120c`), using the manifest-pinned loopback Chat Completions simulator for first turn and native resume.
It contains no real conversation, key or model endpoint.
The captured session metadata SHA256 is `69470f0d7727bdd395c9d17fc42d5e807ef6bad9dd46c6d49ceb19e15a31ad9d`; events SHA256 is `eca0d335deeeeed4bb3415216cb807acf0cd04ef42cdb6462c3df4c501f67935`.
The public-entry-point regression failed with `UnsupportedSchema` before this fix, then passed with all seven native records and both replies.
Additional synthetic mutations cover tool evidence, cancellation, interruptions, malformed/future rows, identity and resource limits; these do not claim a real tool roundtrip.

The [pinned checkpoint reader](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/FxSessionParser.swift) uses optional display.json title metadata and state.preferences.
Huihua reads display.json through the existing bounded JSON helper during scan and read, preserves it as its own evidence record, and uses only its explicit title.
Checkpoint preferences remain complete session metadata; they are not copied onto historical assistant models.
Compacted summaries and background records retain their native kinds; output handles and event tails are not opened.

Fixtures combine local synthetic examples and pinned independent compatibility inputs; they do not establish release-wide correctness.
[Fixture provenance](../../../fixtures/compatibility/README.md) distinguishes upstream validation from the facts asserted through Huihua's public API.
[Architecture](../../../docs/architecture.md#provider-coverage-and-format-ownership) owns acquisition, evidence and resource-limit contracts.

## fx 0.0.15 manager journal

Official [v0.0.15 schema](https://github.com/vercel-labs/fx/blob/v0.0.15/src/core/session_manager/schema.zig)
records version-1 envelopes (`v`, `seq`, millisecond `ts`, `kind`, `crc`) under
`~/.fx/sessions/v2/<id>/log.jsonl`.
The manager owns lifecycle and setting records;
conversation items carry their own `type` and `data`.
The [log writer](https://github.com/vercel-labs/fx/blob/v0.0.15/src/core/session_manager/log.zig)
uses CRC32C and separately implements transactional recovery.

The unchanged synthetic `fixtures/fx/v2/log.jsonl` was captured by official fx 0.0.15
(binary SHA-256 `9ecac1bf74b95c15d8e3a616b029748ff65382d7b1b0fab12a3164f8954aa89c`)
in [run 40679658980](https://github.com/wibus-wee/huihua/actions/runs/40679658980),
artifact 12812920441 (ZIP SHA-256 `d55fbdac3da2f031051b43eb7c8b6b0486df4fc4309923443a543e4b6c794f06`).
Both model replies and resume succeeded; the old independent inventory and provider
only discovered `session.json`, missing all 17 journal records.

Huihua now composes the shared JSONL provider for this separate journal format.
Discovery requires a bounded first `session_created` record with version 1 and native ID.
It ignores index files and never follows blob references, snapshots, locks or embedded paths.
Every physical row remains evidence, including lifecycle records and unknown/future items.
Text/tool items reuse the existing conversation mapper while unknown payloads retain the
original journal envelope.
Preferences do not invent historical response models.
Snapshots/compaction remain system facts; they do not erase or reconstruct conversation history.
This is raw evidence acquisition, not the manager's CRC verification, committed-state fold
or recovery algorithm.
Uncommitted rows are retained, not asserted to be committed.
No dependency or public schema changes are needed; legacy snapshot and conversation routes remain.
The v2 native oracle and baseline are separate from the unchanged v0.0.13 baseline.
