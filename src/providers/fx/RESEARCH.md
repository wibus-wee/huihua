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

## fx 0.0.16 observed journal additions

The synthetic official-writer capture in [daily run 41048114939](https://github.com/wibus-wee/huihua/actions/runs/41048114939), artifact 12972678432 (ZIP SHA-256 `66c65e2d125d996622c953dfb5d322b25ba2056056ffd81d78ba0ed834e6ec23`), contains 20 journal rows.
It adds one `runtime_context` item with messages and a `set` usage value with token counts and nullable cache/reasoning fields.
This is one capture, not a complete format specification.

The unknown context record remains native evidence with a corresponding `PartialParse` diagnostic.
The baseline permits only the observed typed paths, at most one such unknown record, and its associated diagnostic; it does not map or discard the new record.

## November 1 native tool, cancellation and compaction journeys

The official fx 0.0.13 and 0.0.16 Linux binaries were exercised against the
manifest-pinned loopback simulator with synthetic inputs.
Their SHA-256 hashes
were `00def23f9c68ef538d7d967394c3491910793461884fad0b983cb74011b9120c`
and `b8670dcc121b4289e2bdcd2a3e226fd64e3def53c976c42b42de72ee69f66cae`.
Each made a real `read_file` call, returned the synthetic file contents to the
simulated model, produced a final reply, and resumed the same native session.
Separately, a controlled streaming gate and SIGINT produced a native
cancellation.
The 0.0.13 capture wrote `interrupted` with null partial text;
the 0.0.16 journal wrote an `interruption` item with partial text and a
`turn_interrupted` record.
Actual persisted partial text is timing-dependent.

The unchanged synthetic native captures are `fixtures/fx/tool-v1`,
`tool-v2`, `cancel-v1`, and `cancel-v2`.
Their respective event or journal
SHA-256 hashes are `67a58d266a66ea5df96b7d168a0161377c36ecc1cef23ba9ba2f9f8d3b3b5093`,
`d23e9ec3660720a8acbdf9ab56e276d6f16e2db910de11ff07fc632e3386ac33`,
`7ed3e33dc9e94fc57a0c05fec30bf1d282b7e279e30fb2e8586afec6b13a43dd`,
and `0f3605be7766614fd45bac9b00cb3be539866847d46799c37325825a19a73294`.
These captures contain no real model endpoint or credentials.

Huihua treats the observed `interruption` item like the older `interrupted`
event: preserve its native payload as a system fact and expose any recorded
partial text as an assistant message tied to the same record.
The journal's
`turn_interrupted` remains a separate system fact.
This does not reconstruct
missing text.
The observed `tool_running` remains unknown native evidence,
with one bounded diagnostic; it is not promoted to a duplicate tool call.
The same two releases were resumed in an interactive pseudo-terminal and
`/compact` was run with a synthetic model response.
The v1 writer recorded `context_checkpoint`; the v2 writer recorded
`compacted` followed by `snapshot`.
The unchanged `fixtures/fx/compact-v1/events.jsonl` and
`fixtures/fx/compact-v2/log.jsonl` have SHA-256 hashes
`f0ff0431c7bbd766337c62a6f018732f0e54b5d7ad751755ba6fa03a697b135b` and
`192fde43f1697c2bd14e5c77ebff60ae5507923b5e467e13d4aa87962270e87d`.
The live lane verifies the summary, original messages and tool records on all
four read surfaces, without following referenced blobs.
No user-facing session archive operation was found in the tested Fx CLI help;
this observation does not establish behavior for every producer or version.
