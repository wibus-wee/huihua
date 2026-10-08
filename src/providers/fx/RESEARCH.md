# fx compatibility evidence

Reviewed upstream source and documentation on 2026-10-05.

## Official facts

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
Newer manifest schemas, event-tail replay and result-store expansion are outside this snapshot adapter.

The [pinned checkpoint reader](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/FxSessionParser.swift) uses optional display.json title metadata and state.preferences.
Huihua reads display.json through the existing bounded JSON helper during scan and read, preserves it as its own evidence record, and uses only its explicit title.
Checkpoint preferences remain complete session metadata; they are not copied onto historical assistant models.
Compacted summaries and background records retain their native kinds; output handles and event tails are not opened.

Fixtures combine local synthetic examples and pinned independent compatibility inputs; they do not establish release-wide correctness.
[Fixture provenance](../../../fixtures/compatibility/README.md) distinguishes upstream validation from the facts asserted through Huihua's public API.
[Architecture](../../../docs/architecture.md#provider-coverage-and-format-ownership) owns acquisition, evidence and resource-limit contracts.
