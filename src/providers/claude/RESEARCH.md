# Claude Code compatibility research

Reviewed 2026-10-05.
Primary compatibility implementation:
[claude-session-parser 81b4aa5](https://github.com/sevenevesai/claude-session-parser/tree/81b4aa5a1280c234dbb65db77bda18d9d57d83fe).
Secondary: [recall 47a2252](https://github.com/pratikgajjar/recall/blob/47a2252f3c60dffdeafa50a25c6923c1ef2568ee/claude.go).

| Official facts                                                                                                                                           | Third-party compatibility experience                                                                                                                                                                  | Huihua decisions                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Claude documentation](https://code.claude.com/docs/en/how-claude-code-works) describes local sessions; it does not promise a stable JSONL wire contract | Both parsers locate projects/encoded-path/session-id.jsonl; subagents may live under session-id/subagents                                                                                             | Scan recursive JSONL under explicit roots; default ~/.claude/projects; never decode directory names as factual workspace paths                                                               |
| Anthropic message content includes text/thinking/tool_use/tool_result/image blocks, but Claude Code's outer records are private                          | 2.1+ split assistant content into records sharing message.id; usage fields may repeat                                                                                                                 | Preserve every physical record and block order, including synthetic and sidechain rows; no ID-based deduplication or billing aggregation                                                     |
| No public guarantee for file history/hook/session index representation                                                                                   | file-history-snapshot, system, attachment and summaries coexist with chat records                                                                                                                     | Preserve every unsupported record as Unknown; system lifecycle rows stay System; summary may supply title only when explicitly recorded as such                                              |
| No guaranteed branch/subagent tree protocol                                                                                                              | parentUuid/isSidechain/agentId and nested subagent directories appear in compatible data                                                                                                              | Keep explicit envelope lineage; never invent parent session IDs from filenames or turn parentUuid into a session ID                                                                          |
| Provider stores can be interrupted or partially written                                                                                                  | Reference parser skips malformed lines and synthetic rows for its viewer                                                                                                                              | Do not adopt its skip rules: malformed bytes survive with diagnostics; bounded streaming reads, no repair                                                                                    |
| The private outer transcript has no stable public schema                                                                                                 | [ccusage Claude adapter](https://github.com/ccusage/ccusage/blob/b8bfa6aa2f179de118c2ef3bf066b1e4372878d2/rust/adapters/claude/src/lib.rs) reads usage-only records and nested advisor iterations     | Emit native Usage even without content; retain nested fields and repeated IDs, without billing deduplication or invented advisor messages                                                    |
| Config discovery and parsing are separate concerns                                                                                                       | [ccusage paths](https://github.com/ccusage/ccusage/blob/b8bfa6aa2f179de118c2ef3bf066b1e4372878d2/rust/adapters/claude/src/paths.rs) accepts config roots, projects roots and XDG config installations | Discover both conventional roots, honor absolute XDG_CONFIG_HOME and avoid doubling projects in CLAUDE_CONFIG_DIR; keep environment paths literal, use ScanOptions.roots for multiple stores |

Fixtures are authored anonymized examples of these shapes.
Third-party workarounds are compatibility
evidence, not official protocol.
This adapter deliberately does not infer token cost or classification.

## Implementation decisions

Reviewed Agent Sessions [Claude discovery](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/SessionDiscovery.swift)
on 2026-10-07 as third-party compatibility evidence for CLAUDE_CONFIG_DIRS, `.claude*` sibling installations,
and Desktop/Cowork `local-agent-mode-sessions/**/local_*/.claude/projects` transcripts.
These private Desktop paths are not an official stable storage contract.
Huihua combines these roots with CLAUDE_CONFIG_DIR and conventional/XDG projects rather than replacing
defaults when an environment root is present.
CLAUDE_CONFIG_DIRS uses the platform path-list delimiter.
Explicit roots still replace defaults; explicit homeDir excludes process environment roots.
Directory discovery requires native sessionId in the bounded prefix; exact supplied files remain readable
even without native identity.
Desktop discovery admits only the transcript subtree and excludes journals.
A failed home sibling listing produces a source failure while independently configured/default roots still scan.

[Pinned reference discovery/parser](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/ClaudeSessionParser.swift) also establishes `.ndjson` acquisition and historical top-level tool_use/tool_call/tool_result shapes as third-party compatibility evidence.
They reuse the existing discovery and mapper; native block names, arguments, results and error flags remain intact.
For Desktop transcripts under local_*/.claude/projects, the bounded metadata prelude reads the adjacent local_*.json.
Only matching native local sessionId and cliSessionId/file identity establish a title association; custom-title records override the sidecar title.
The local sidecar ID is preserved separately as desktop_session_id and never replaces the transcript ID.
Foreign sidecar metadata stays raw; its model is not a historical response model.
Supplied JSONL opens no sidecar.

Reviewed [Huihua issue #24](https://github.com/wibus-wee/huihua/issues/24) on 2026-10-09
as third-party compatibility evidence: current Claude Code subagent records carry
the enclosing session's `sessionId`, their own `agentId`, and `isSidechain: true`.
The adjacent `agent-<agentId>.meta.json` records the agent type, description,
spawn tool call and depth.
This private layout is not an official wire contract.
The Claude mapper uses native `agentId` as `id` and native `sessionId` as
`parentSessionId` when both subagent markers are present and no explicit
`parentSessionId` already identifies a legacy independently named child session.
It retains both native IDs in metadata and the original event envelopes.
Neither filenames nor `parentUuid` establish a session identity or parent.
As with other providers, IDs remain native and source-scoped rather than
promising global uniqueness across stores.

File-backed `subagents/agent-*.jsonl` and `.ndjson` select only their exact sibling
`.meta.json` through the existing bounded companion hook.
A metadata object with
native `agentType` and `toolUseId` is preserved as `metadata.subagent` and a System
event with source type `subagent_metadata`; complete native records retain its
actual source path and unknown fields.
Missing sidecars do not prevent the
transcript's explicit identity and parent mapping.
Metadata does not invent a
title, response model, lifecycle event or parent from a directory or tool ID.
The same mapper serves discovery, direct acquisition, snapshots and selected
usage delivery.
Focused regressions cover a parent with two child transcripts,
optional sidecars, acquired text/bytes/chunks, preserved legacy lineage and
foreign-identity diagnostics without rewriting historical goldens.

On 2026-10-09 the pinned real Claude Code 2.1.292, driven by the loopback simulator,
independently reproduced this private layout for two foreground general-purpose children.
Both native child transcripts reuse the parent's `sessionId` and carry their own `agentId`.
The real companions contain `requestShape: "foreground"`, `requestNonInteractive: true`
and `spawnDepth: 1`; their `toolUseId` values match parent Agent calls and completed results.
The test-only live journey and reviewed structural baseline are documented in
[producer compatibility](../../../docs/producer-compatibility.md#foreground-subagent-baseline-provenance).
This producer observation corroborates issue #24 without making the private layout an official
contract or certifying background, nested or resumed children.

[Design decisions](../../../docs/design.md) own the provider behavior inventory and binary-reading choices.
The adjacent TypeScript implementation and shared compatibility fixtures are the maintained sources of truth.

`consumeUsage` reuses this mapping without delivering native records.
Its opt-in
`native_usage_context` copies only message.model, message.id and outer requestId
from the same record.
It does not infer a session model or distinct billable work.
Normal streams retain complete evidence and unchanged event metadata.
UTF-8/JSON,
identity, unknown-record and tool diagnostics still run; native JSON decoding is
not bypassed.
Fixture and daily-report equivalence cover repeated IDs, missing
fields, advisor iterations, malformed input and interrupted tools.

`consumeUsageFacts` shares this mapper and native context; it omits the canonical
event/frame envelope and optionally applies a caller's timestamp predicate.
Context extraction is lazy after that predicate; framing, JSON, identity,
unknown-record and tool/EOF checks still run for rejected rows.
No usage, date, model, identity or branch fact is inferred.

The same metadata function accepts the existing selected patch keys internally.
It always resolves native session/agent identity for validation, and only constructs
requested workspace/title/time/parent/metadata fields; discovery and full reads
omit that selector and retain their complete original facts.
