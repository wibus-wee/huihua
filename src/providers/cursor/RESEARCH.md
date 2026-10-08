# Cursor compatibility evidence

| Official facts                                                                                                                                                                                  | Third-party compatibility experience                                                                                                                                                                                                                                                 | Huihua decisions                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [History](https://docs.cursor.com/en/agent/chat/history) and [CLI](https://docs.cursor.com/en/cli/using) describe local history, without a stable on-disk schema contract.                      | [recall cursor.go](https://github.com/pratikgajjar/recall/blob/47a2252f3c60dffdeafa50a25c6923c1ef2568ee/cursor.go) reads `cursorDiskKV`, `composerData:` metadata, ordered bubble headers and `bubbleId:` records.                                                                   | Support this observed IDE schema; keep composer and bubble payloads, including non-text records. Do not infer timestamps, workspace or titles from folder names or text.                                                                                                                                             |
| Public docs do not specify numeric bubble roles.                                                                                                                                                | Recall observes 1=user, 2=assistant and `ItemTable` / `composer.composerData` workspace indexes.                                                                                                                                                                                     | Normalize 1/2 only; unknown roles remain Unknown. Rich-text-only content remains structured, without a lossy rendering pass.                                                                                                                                                                                         |
| Public docs do not specify IDE schema migrations.                                                                                                                                               | [cursaves storage research](https://github.com/Callum-Ward/cursaves/blob/2919739d35a043f1f35979a758f87d4c936a42b7/docs/how-cursor-stores-chats.md) describes coexisting KV/ItemTable, metadata-only workspace indexes, legacy conversationMap, checkpoints and request-context keys. | Select by records rather than table presence; decode conversationMap in header order and retain composer-associated supplemental rows as Unknown. Inline conversation arrays are a permissive synthetic shape, not a verified release contract. Do not adopt its live-copy atomicity claims.                         |
| CLI history is a distinct product store.                                                                                                                                                        | [recall cursor_agent.go](https://github.com/pratikgajjar/recall/blob/47a2252f3c60dffdeafa50a25c6923c1ef2568ee/cursor_agent.go) observes JSONL under `.cursor/projects/*/agent-transcripts`.                                                                                          | Support role/message JSONL separately; retain prompt wrappers. No mtime-as-event-time or token estimates. Persisted meta/blob stores now decode the confirmed text graph; private steps remain native evidence.                                                                                                      |
| [SQLite WAL](https://www.sqlite.org/wal.html) can contain committed rows absent from the main file; [copying live databases](https://www.sqlite.org/howtocorrupt.html) is not an atomic backup. | Recall opens immutable snapshots, which can omit WAL.                                                                                                                                                                                                                                | Never open the source through a SQLite engine. Read rowid-table pages and checksum-validated committed WAL frames directly; reject nonempty rollback journals and verify source file fingerprints on close. No temporary DB copies or writes. This is not atomic live isolation; changed stores return PartialParse. |

Reviewed 2026-10-05.
Fixtures are synthetic, derived from the documented shapes above; they do not certify every Cursor release.
Default roots cover macOS/Linux/Windows IDE globalStorage/workspaceStorage, CLI projects, chat stores and ACP stores; explicit roots replace defaults.

## Implementation decisions

Reviewed Agent Sessions [discovery](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/CursorSessionDiscovery.swift),
[chat metadata](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Cursor/CursorChatMetaReader.swift)
and [ACP store reader/tests](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessionsTests/CursorSessionParserTests.swift)
on 2026-10-07.
These are third-party observations of private formats, not official protocol promises.
They establish .cursor/chats/<workspace>/<UUID>/store.db and .cursor/acp-sessions/<UUID>/store.db,
hex JSON at meta key 0, agentId/name/createdAt/latestRootBlobId, and content-addressed SHA-256 blobs.
ACP has an adjacent schemaVersion 1 meta.json with cwd.
Root field 8 references turns;
turn field 1 contains an agent turn (user reference field 1, ordered step references field 2),
turn field 2 contains a shell turn.
Step field 1 references assistant text; 2/3 are private tool/thinking variants.
User/assistant node field 1 contains UTF-8 text.

Huihua separates discovery families: native CLI JSONL must be under agent-transcripts and have a role/message
envelope in the bounded prefix; IDE candidates are state.vscdb in globalStorage/workspaceStorage.
Chat and ACP roots are included by default.
Exact supplied files remain an acquisition surface.
Native persisted stores require matching directory/native UUIDs, observed meta/blobs columns, and a valid root blob.
ACP sidecar failures name the companion path; unsupported sidecar versions omit the candidate.
Static canonical-path checks reject ACP symlink roots/ancestors and companions; recursive discovery skips symlink children.
There is no claim of the Swift application's descriptor-bound live-root authority or archive lifecycle semantics.

Persisted reads reuse the existing read-only SQLite and ingestion pipeline and the maintained protobuf wire library.
Confirmed text edges normalize in graph order; repeated references retain repeated events with one native evidence row.
Tool/thinking variants, shell turns, future variants and unreferenced historical blobs stay Unknown with native bytes.
All meta rows remain evidence.
Missing graph edges and corrupt content addresses fail explicitly.
The new synthetic SQL fixture exercises text, repeated edges, private steps, shell and historical data;
it does not certify the format across Cursor releases.
No usage, tool outcome or workspace hash decoding is invented.

Public Cursor docs do not specify role-less CLI turn failure records.
[Agent Sessions' parser](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/CursorSessionParser.swift)
and its [focused regression](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessionsTests/CursorSessionParserTests.swift)
observe `type: "turn_ended"`, `status: "error"` and a nonempty string `error` without a role.
Huihua maps that shape, including an empty role, to an error event with the native record as details.
Other turn endings and unknown roles remain Unknown; role/message content keeps its existing mapping.
[The synthetic reproduction](../../../fixtures/cursor/turn-error.jsonl) follows the upstream regression shape;
it is compatibility evidence, not a certified Cursor release sample.
The shared ingestion pipeline retains original JSONL text, complete native records and event associations.

The [pinned CLI compatibility fixture](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/Resources/Fixtures/stage0/agents/cursor/schema_drift.jsonl) records tool_use/tool-use/tool_call/tool-call and tool_result/tool-result blocks.
The CLI mapper normalizes their explicit names, IDs, arguments, results and errors without changing native blocks or extending IDE graph interpretation.
These aliases are empirical compatibility evidence, not a public Cursor transcript schema.

[Design decisions](../../../docs/design.md) own the provider behavior inventory and binary-reading choices.
The adjacent TypeScript implementation and shared compatibility fixtures are the maintained sources of truth.
