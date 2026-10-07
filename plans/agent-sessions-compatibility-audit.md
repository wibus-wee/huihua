# Agent Sessions compatibility audit

This is the pre-fix audit.
Implemented findings and behavior/native-data verification are tracked in [compatibility acceptance](../docs/compatibility-acceptance.md).

Date: 2026-10-08.
Huihua baseline: `b185fc1514ec5c131619934d6b663c88e66f86b5` (`v0.4.0`).
Agent Sessions baseline: [`6fa9a73f489d37f655873871e5e6a5cf6975d1ff`](https://github.com/jazzyalex/agent-sessions/tree/6fa9a73f489d37f655873871e5e6a5cf6975d1ff), verified against the repository's current `main` during this audit.
This is the same reference revision already cited by several Huihua research files; the largest gaps are not explained by a newly changed reference repository.

The audit covers local discovery, acquired formats, normalization, evidence, model attribution and token-report semantics.
It compares all 17 Agent Sessions source identities with the corresponding Huihua providers, plus Huihua's three additional providers.
It does not claim identical UI output or release-wide certification.

## Results and navigation

| Provider         | Result                                                                                                                                                      | Detail                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Devin            | A shared SQL-comment bug makes the existing native schema look unsupported.                                                                                 | [Devin](#devin), [F01](#f01-read-sql-comments-as-comments) |
| Kimi             | Real loop output, ID-less state metadata and native token arithmetic are missing.                                                                           | [Kimi](#kimi), F02–F04                                     |
| OpenCode         | Existing formats are readable, but per-message full-table rescans make complete reports expensive.                                                          | [OpenCode](#opencode), F05                                 |
| Codex            | Modern core mapping exists; historical aliases, some usage families and nested lineage are narrower; Usage omits native turn-context attribution by design. | [Codex](#codex)                                            |
| Claude           | Main roots and block mapping overlap; `.ndjson` and some historical top-level tools are narrower; accounting differs deliberately.                          | [Claude](#claude)                                          |
| Cursor           | IDE and persisted graph coverage overlap; observed CLI tool aliases are not normalized.                                                                     | [Cursor](#cursor), F06                                     |
| Hermes           | SQLite coverage is additional; a recorded tool failure can normalize as successful.                                                                         | [Hermes](#hermes), F07                                     |
| DeepSeek Harness | Generation/compression coverage exists; historical tool-result identity/error and native parent fields are missing.                                         | [DeepSeek](#deepseek-harness), F08–F09                     |
| Cline            | Manifest/message coverage overlaps; configured `CLINE_DATA_DIR` is ignored.                                                                                 | [Cline](#cline), F10                                       |
| Copilot CLI      | Main transcript mapping overlaps; tokenDetails-only shutdown usage is omitted.                                                                              | [Copilot](#copilot-cli), F11                               |
| Droid            | Reviewed stage0 fixtures parse; several confirmed reference aliases remain narrower.                                                                        | [Droid](#droid), F12                                       |
| Qwen             | Certified discovery and Google parts are supported; payload-only tool fallback and runtime-user classification differ.                                      | [Qwen](#qwen)                                              |
| Antigravity      | The provider names hide different source families: Huihua's partial SQLite steps versus reference brain Markdown/JSONL.                                     | [Antigravity](#antigravity)                                |
| Grok             | Huihua reads the authoritative update journal; reference reads the smaller derived chat history.                                                            | [Grok](#grok)                                              |
| Pi               | Reviewed fixture behavior is supported; transcript branch selection and token confidence differ intentionally.                                              | [Pi](#pi)                                                  |
| OpenClaw         | Legacy JSONL overlaps; Huihua additionally supports selected SQLite windows; deleted JSONL discovery is narrower.                                           | [OpenClaw](#openclaw)                                      |
| fx               | Checkpoint coverage overlaps; display sidecars and some edge-case fixtures are narrower.                                                                    | [fx](#fx)                                                  |
| ACP              | No corresponding Agent Sessions provider.                                                                                                                   | [Additional providers](#additional-huihua-providers)       |
| OAR              | No corresponding Agent Sessions provider.                                                                                                                   | [Additional providers](#additional-huihua-providers)       |
| Morph            | No corresponding Agent Sessions provider.                                                                                                                   | [Additional providers](#additional-huihua-providers)       |

## Evidence and interpretation

Reference links below are pinned to the audited revision.
They describe that application's behavior, not an official provider storage guarantee.
Primary provider sources are linked separately where they establish semantics, especially Kimi usage.
Huihua's [architecture](../docs/architecture.md), per-provider research, public contracts, nearest tests and native fixtures were reviewed alongside the reference parsers, discovery code, telemetry and tests.

Read-only differential replays used Huihua's existing public parse/read/stream contracts and Usage builder.
A disposable SQLite database reproduced the SQL-comment defect independently of the user's store.
Inspection of the real Devin store used Huihua's read-only reader and bounded schema bytes; no source database was opened through a native engine, copied, repaired or written.
Real Kimi inspection disclosed only field names and counts.
No private conversation content, credentials or session records are included here.

The following distinctions matter when interpreting the earlier CLI output:

- `UnsupportedSchema` can be a reader defect: Devin is such a case.
- `unknown` retains a complete native record, but a known transcript family left unknown is still a normalization gap.
- `partial` combines token ambiguity, repeated identities, lineage and parser diagnostics in the current Usage report; it is not a count of unsupported formats.
- Missing model attribution can coexist with preserved native model configuration, as in Codex.
- Different acquisition surfaces can produce different coverage despite identical provider names, as in Antigravity and Grok.

The reference's [source registry](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Model/SessionSourceRegistry.swift#L31) contains 17 identities, including legacy Droid.
Its telemetry engine is a separate consumer that can reread source bytes because transcript rendering truncates some raw JSON; see [SessionTelemetryEngine](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Telemetry/SessionTelemetryEngine.swift#L64).
Huihua retains complete evidence and its Usage consumer uses public provider contracts instead.
Copying that separate raw-byte telemetry parser into Huihua would duplicate format ownership.

## Prioritized confirmed findings

Effort includes focused regressions and owning documentation: S means hours, M approximately a day, L multiple days.
Fix risk describes the chance of changing existing semantics; confidence describes the evidence for the finding, not every provider release.

| ID  | Priority | Finding / owner                                     | Impact                                                                               | Effort | Fix risk             | Confidence                                               |
| --- | -------- | --------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ | -------------------- | -------------------------------------------------------- |
| F01 | P0       | SQL comments / existing shared SQLite schema reader | Valid native columns disappear; Devin cannot scan.                                   | M      | Medium               | High; native schema plus independent reproduction        |
| F02 | P0       | Kimi loop events / existing provider mapper         | Real capture produces no assistant, reasoning or tool events.                        | M      | Medium               | High; public parse of captured fixture                   |
| F03 | P0       | Kimi counters / existing Usage arithmetic           | Explicit native usage becomes entirely unavailable.                                  | S–M    | Medium               | High; fixture and primary producer source                |
| F04 | P1       | Kimi state / existing metadata mapper               | Real title, workspace and timestamps are skipped.                                    | S      | Low–medium           | High; captured ID-less state                             |
| F05 | P1       | OpenCode scans / existing provider acquisition      | Each selected message traverses all parts again.                                     | M      | Medium               | High; code path, no benchmark claim                      |
| F06 | P1       | Cursor CLI tool aliases / provider mapping          | Tool blocks appear as structured conversation rather than tool events.               | S      | Low–medium           | High for pinned compatibility fixture                    |
| F07 | P1       | Hermes failure alias / provider mapping             | Recorded failed tool result is marked successful.                                    | S      | Low                  | High; fixture and reproduction                           |
| F08 | P1       | DeepSeek v2/v3 result fields / provider mapping     | Call identity and nested failure are absent; false unmatched-call diagnostics occur. | S      | Low                  | High; native-shaped reproduction                         |
| F09 | P1       | DeepSeek parent key / provider metadata             | Explicit recorded lineage is absent from canonical metadata.                         | S–M    | Medium               | High; valid subagent header reproduction                 |
| F10 | P1       | Cline environment root / provider discovery         | Configured sessions are missed; default-profile history can be read instead.         | S      | Low                  | High for reference difference; confirm producer contract |
| F11 | P2       | Copilot shutdown tokenDetails / provider mapping    | Explicit summary counters are not selectable as Usage events.                        | S      | Low for preservation | High; imported fixture and reproduction                  |
| F12 | P2       | Droid aliases / provider mapping                    | Tool results and explicit workspace aliases can remain unknown/absent.               | S      | Low                  | High for behavior; medium for native prevalence          |

### F01: Read SQL comments as comments

Owner: [src/shared/sqlite.ts](../src/shared/sqlite.ts), `definitions` at line 54, `columnDefinition` at line 176 and `schema` at line 207.
The current splitter handles quoting and parentheses but not `--` or block comments.
An apostrophe in a line comment can therefore enter string-quote state, and comment tokens can become column names.
[sqlite-store.ts](../src/shared/sqlite-store.ts) line 22 then rejects required columns that were present in the original SQL.

The real Devin `message_nodes` DDL places line comments after `node_id` and `parent_node_id`.
Huihua reports columns `row_id`, `session_id`, `node_id`, `--` instead of the native parent/message/time columns.
A disposable database independently reproduced the same result:

```text
Expected: row_id, session_id, node_id, parent_node_id, chat_message, created_at
Actual:   row_id, session_id, node_id, --
```

The row decoder also associates subsequent values with that wrong schema.
This is a shared reader correctness defect with potential effects beyond Devin.
The reference [DevinSqliteReader](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Devin/DevinSqliteReader.swift#L210) executes selected SQL through SQLite and does not parse persisted DDL with this splitter.
Adopting that native engine would violate Huihua's maintained boundary.

Start with `tests/sqlite.test.ts` and native SQL fixture syntax, including comments containing quotes, commas and parentheses, comment-like quoted identifiers/defaults, and exact logical-row assertions.
Evaluate a maintained compatible tokenizer before adding generic SQL infrastructure; otherwise document why a narrowly scoped extension of the existing schema reader is required.
Do not repair the Devin database or relax required-column validation to hide the defect.

### F02–F04: Correct Kimi's existing researched format

Owners: [Kimi provider](../src/providers/kimi/index.ts), [Kimi research](../src/providers/kimi/RESEARCH.md), [Usage builder](../packages/usage/src/report.ts) and [Usage contract](../docs/usage-report.md).
These are three separate failures within the existing source family.

The reference [Kimi parser](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/KimiSessionParser.swift#L189) maps `context.append_loop_event` directly into recorded content/tool events.
Huihua's mapper at line 48 handles `context.append_message`, but has no loop-event branch.
Public parsing of the reference [captured journal](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/Resources/Fixtures/stage0/agents/kimi/assistant_tools.jsonl) gives:

| Observation                                                      | Current Huihua result |
| ---------------------------------------------------------------- | --------------------- |
| Complete native records                                          | 200                   |
| Native loop-event records                                        | 112                   |
| Canonical user messages                                          | 13                    |
| Canonical assistant / reasoning / tool-call / tool-result events | 0 / 0 / 0 / 0         |
| Usage events                                                     | 23                    |
| Unknown events                                                   | 125                   |

This is not a future-version guess: the already pinned official [wire manifest](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/docs/wire-manifest.d.ts#L25) and [loop-event types](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/contextMemory/loopEventFold.ts#L18) establish this vocabulary.
Extend the existing mapper for recorded text/thought/calls/results and nested error flags; do not build a replay engine or remove mirrored records.

Usage line 315 groups Kimi with Cline/DeepSeek and reads `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` and `totalTokens`.
Real durable Kimi records contain `inputOther`, `output`, `inputCacheRead` and `inputCacheCreation` instead.
The official [TokenUsage definition and total functions](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/kosong/src/usage.ts#L1) establish:

```text
inclusive input = inputOther + inputCacheRead + inputCacheCreation
grand total     = inclusive input + output
```

For the captured fixture these components sum to 30,174 + 661,504 + 0 + 5,515 = 697,193 tokens.
The existing Usage builder reports all five totals as `null` despite receiving all 23 usage events.
This directly reproduces the same field mismatch seen in the user's larger report.

At the pinned [UsageAgentModel](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/session/usage/usageAgentModel.ts#L24), both `usageScope: turn` and `usageScope: session` are additive generation contributions.
The latter must not be discarded as a cumulative snapshot.
Cumulative status is a separate projection at lines 53–72.
The capture contains 22 turn-scoped records and one session-scoped compaction contribution.
Do not also sum matching loop `step.end` copies, and do not infer billing uniqueness from these arithmetic rules.
The existing report must explicitly document whether the input column shows uncached or inclusive input.

Finally, metadata line 23 requires `v.id` before extracting any state facts.
The real [state sidecar](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/Resources/Fixtures/stage0/agents/kimi/assistant_tools.state.json) has title, workDir, agents and RFC3339 times but no ID.
The current synthetic [state fixture](../fixtures/kimi/session/state.json) supplies the extra ID, while its wire fixture uses the non-native counter names and context-message output.
Those fixtures mask all three defects.
Recognize state facts independently of optional identity, keep fallback identity labeled, and correct the research assertion that all such timestamps are milliseconds.

### F05: Remove repeated OpenCode part-table traversal

Owner: [OpenCode acquisition](../src/providers/opencode/index.ts).
`associated` at line 201 traverses every row of its table and filters afterward.
The selected-message loop at line 337 invokes `associated(part, messageId)` at line 372 for each message.
For M selected messages and P total part rows, that section decodes approximately M × P part rows, including unrelated sessions repeatedly.
Each session also opens a fresh database, loads its WAL, and scans message metadata again.
This explains a concrete expensive path encountered by the full Usage run; it does not establish a measured speed ratio or exclude other costs.

The reference [OpenCode reader](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/OpenCode/OpenCodeSqliteReader.swift#L240) binds the session ID and [loads parts](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/OpenCode/OpenCodeSqliteReader.swift#L374) with a selected message ID through SQLite.
Its per-message SQL query does not imply equivalent cost to Huihua's unconditional full-table iterator.

A scoped first fix can collect selected-message identities and group matching parts in one traversal per read, retaining existing selected-session buffering, row evidence, per-message ordering, orphan diagnostics and source validation.
Use structural iteration-count regression tests and existing semantic fixtures; benchmark permission is separate.
Do not introduce a persistent index/cache, native SQLite binding or source mutation.
Broader report-wide batching is a separate architecture decision because replay handles currently open fresh sources.
The generic [row-store helper](../src/shared/sqlite-store.ts) lines 38 and 51 has the related S × R full-transcript-scan pattern across S session reads, but lacks OpenCode's additional per-message multiplier.

### F06–F12: Smaller evidenced mapping and discovery defects

| ID  | Huihua evidence                                                                                                                                 | Pinned reference evidence                                                                                                                                                                                                           | Required regression / correction                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F06 | Cursor `index.ts:64`; shared `messageEvents:309` supports `tool_use/toolCall` and `tool_result`, but not observed `tool_call/tool-result`.      | [Cursor parser](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/CursorSessionParser.swift#L315), `stage0/agents/cursor/schema_drift.jsonl:2`.                      | Reproduced zero tool events with payloads classified as structured conversation; establish provider-owned aliases and preserve original blocks.                    |
| F07 | Hermes `index.ts:31` passes messages to shared `chatMessageEvents:367`, which omits `finish_reason`.                                            | [Hermes parser](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/HermesSessionParser.swift#L273), `stage0/agents/hermes/schema_drift.json:42`.                      | Reproduced `finish_reason: error` as `isError: false`; map the alias in Hermes rather than asserting a universal chat-field meaning.                               |
| F08 | DeepSeek `index.ts:91` omits `message.source.callId` and historical nested result fields.                                                       | [Result mapper](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/DeepSeekHarness/DeepSeekHarnessSessionParser.swift#L522), `DeepSeekHarnessSessionParserTests.swift:99`.     | Reproduced missing call ID, `isError: false` and false unmatched-call diagnostic; cover v2/v3 source and nested block facts without folding history.               |
| F09 | DeepSeek `index.ts:25` reads `parentSessionId` rather than native `parentSession`.                                                              | [Native header decoder](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/DeepSeekHarness/DeepSeekHarnessFormatTypes.swift#L170), subagent/fork tests at lines 520/547.       | Valid explicit-subagent header loses canonical parent without a diagnostic; decide seeded-fork versus subagent lineage semantics and preserve origin facts.        |
| F10 | Cline `index.ts:12` uses only explicit/default roots.                                                                                           | [Cline root precedence](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/ClineSessionDiscovery.swift#L29), discovery tests at line 44.                              | Confirm native `CLINE_DATA_DIR`, then test explicit-root priority, environment-selected missing/empty stores and `homeDir` isolation.                              |
| F11 | Copilot `index.ts:67` emits shutdown Usage only when `modelMetrics` exists.                                                                     | [Copilot tokenDetails fallback](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Telemetry/CopilotTelemetryAccumulator.swift#L118); imported small fixture has tokenDetails. | TokenDetails-only reproduction emits system but no Usage; retain the full summary observation while keeping process totals separate from daily request arithmetic. |
| F12 | Droid `index.ts:23` lowercases `toolResult` into unreachable `toolresult`; line 28 omits camel event results; line 13 omits `workingDirectory`. | [Droid parser](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/DroidSessionParser.swift#L46), aliases at lines 526/717.                                            | Focused alias reproductions fail despite all six reviewed stage0 Droid fixtures mapping known events; extend only evidence-backed adapter aliases.                 |

## Provider-by-provider comparison

### Codex

[Huihua](../src/providers/codex/index.ts) and the reference [discovery](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/SessionDiscovery.swift#L90) both honor CODEX_HOME and active/archive roots.
Huihua additionally supports compressed rollouts and broader explicit filenames.
Modern messages, reasoning, function/custom calls/results, approvals and selected collaboration events are mapped while both mirrored record streams remain visible.

There are narrower transcript families: reference `stage0/agents/codex/large.jsonl:6–7` uses `response_item` tool_call/tool_result aliases, and its schema-drift fixture uses older top-level chat/function records.
They become unknown in Huihua, retaining raw evidence but missing normalized selectors.
The reference [generic parser](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/SessionIndexer.swift#L2984) accepts these shapes; validate native provenance before adopting its broader heuristics.
Nested `source.subagent.thread_spawn.parent_thread_id` is also omitted by Huihua metadata line 49, whereas the reference reads it at `SessionIndexer.swift:2382`.
Conflicting parent precedence needs an explicit provider decision.

The observed model problem is explained by [Usage's same-record attribution](../packages/usage/src/report.ts) line 198.
The provider preserves top-level turn_context as a system event, but evidence-free usage supplies only model facts from the usage row itself.
The reference [Codex telemetry](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Telemetry/CodexTelemetryAccumulator.swift#L63) maintains a model/effort timeline and computes cumulative epochs, including reset handling and usage-family selection.
Huihua deliberately sums empirical request records and excludes token_count snapshots.
It also leaves top-level turn.completed unknown, so that explicit usage family needs a scoped preservation mapping before any arithmetic change.

Improved attribution belongs to the Usage consumer with explicit turn-context provenance, or to a deliberately extended provider capability.
A session-wide last-model guess and silent cumulative deltas are incompatible alternatives.
Existing usage fixtures put model directly on request rows, masking the common absent-same-record-model case.

### Claude

[Huihua](../src/providers/claude/index.ts) and reference discovery substantially overlap after the recent conventional/XDG/config/Desktop/Cowork expansion.
Text, thinking, user-envelope tool results and same-record model/usage mapping are implemented.
Huihua scans lowercase `.jsonl` only; [reference discovery](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/SessionDiscovery.swift#L643) additionally admits `.ndjson`.
A native-shaped temporary `.ndjson` was readable through the provider but yielded no scan refs or failures.
This is an evidenced discovery extension, with weaker evidence for widespread native use.

Reference [Claude parsing](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/ClaudeSessionParser.swift#L297) also accepts historical top-level tools and supplies Desktop sidecar titles.
Huihua's unknown attachments/progress remain evidence; a replay of the combined/redacted small reference fixture retained 138 records and produced 91 unknown events, mostly attachments.
That fixture census is not a production failure-rate estimate.

Reference [telemetry](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Telemetry/ClaudeTelemetryAccumulator.swift#L45) deduplicates message identities and filters synthetic configuration/usage.
Huihua retains repeated observations and labels possible overlap partial.
Filename-derived subagent parent guesses and rendering folds must not be copied into native evidence semantics.

### Cursor

[Huihua](../src/providers/cursor/index.ts) covers IDE KV/bubbles, conversationMap, ItemTable-backed indexes, CLI transcripts and chat/ACP meta/blob stores.
Its [persisted reader](../src/providers/cursor/persisted.ts) validates content addresses, preserves all native rows and emits repeated graph references without duplicating evidence rows.
The reference [Cursor parser](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/CursorSessionParser.swift#L1105) also skips private graph tool/thinking variants; those unknown variants are not a parity defect.

The observed CLI block aliases in F06 are a real mapping gap.
Reference subagent parent links also derive from native layout, while Huihua reads those files as independent streams without promoting directory ancestry.
Broader role aliases, path-decoded cwd, unknown-role-to-assistant defaults, wrapper stripping and live-store copy/archive behavior are separate reference policies.
Do not replace Huihua's strict missing-fact and source-identity behavior with those heuristics.

### OpenCode

[Huihua](../src/providers/opencode/index.ts) supports SQLite message/part, session_message, empirical session_v2 and historical filesystem stores.
The reference [SQLite reader](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/OpenCode/OpenCodeSqliteReader.swift) covers selected session/message/part records and its [filesystem parser](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/OpenCodeSessionParser.swift) supports historical layouts.
Huihua retains full metadata/part rows, native token objects, malformed data, orphan diagnostics and partially migrated records.
F05 is the confirmed structural cause of excessive rereading, not evidence that the format itself is unsupported.

Ordering differs: the reference sorts parts by native creation time then ID; Huihua uses ID in its existing per-message part selection.
The reference filters archived sessions and can derive titles/model summaries; Huihua keeps independent sources and does not replace absent historical facts with current presentation state.
Order/fallback changes must be assessed against official producer behavior and static semantic baselines rather than bundled into the performance fix.

### Pi

[Huihua](../src/providers/pi/index.ts) supports v1/v2/v3 physical trees and future-record preservation, with native PI_CODING_AGENT_DIR handling.
The reference [Pi parser](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/PiSessionParser.swift#L188) constructs the last leaf's ancestry and deduplicates IDs for its transcript view.
Huihua keeps all branches and repeats; its command event preserves bash output/exit facts instead of inventing a tool relationship.
The complete 13-record reference small fixture mapped without unknown events.

Both use same-message model and additional cache counters.
Reference [telemetry](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Telemetry/PiTelemetryAccumulator.swift#L39) sums assistant usage and defaults missing counters to zero.
Huihua preserves missing/invalid values and labels branch/replay uncertainty.
No concrete Pi defect was established in the reviewed set; this is not certification of every version or custom role.

### Copilot CLI

[Huihua](../src/providers/copilot/index.ts) and the reference support flat and session-state events layouts, messages, reasoning and tool lifecycle records.
Huihua retains mirrored tool requests/start records; the reference [parser](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/CopilotSessionParser.swift#L197) suppresses duplicates and joins remembered tool names/arguments into results.
Unknown notification, abort and subagent records remain native evidence in Huihua.

F11 concerns preserving explicit shutdown usage, not automatically adding it to daily totals.
Reference [telemetry](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Telemetry/CopilotTelemetryAccumulator.swift#L57) sums distinct process-lifetime shutdown summaries across resume and chooses per-model metrics over tokenDetails to avoid double counting.
Huihua reports only response-level assistant.usage; checkpoints/quota units and process summaries are excluded from request/day arithmetic.
A process-summary report would need a separate scope and date-allocation design.

### Hermes

[Huihua](../src/providers/hermes/index.ts) discovers HERMES_HOME/state.db plus historical JSON/JSONL and retains inactive/compacted SQLite rows in native ID order.
This selected SQLite/sentinel coverage goes beyond the reviewed reference historical snapshot parser.
Both map OpenAI-style tools and explicit reasoning, but F07 loses the native finish_reason failure alias.
The imported large fixture misses the independent schema-drift error case.

Reference fallback timestamps and delegated-output unwrapping at [HermesSessionParser](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/HermesSessionParser.swift#L217) are presentation policies.
Huihua correctly leaves absent message times absent and preserves complete delegate envelopes.
An unavailable additive token contract is distinct from inability to read the transcript.

### OpenClaw

[Huihua](../src/providers/openclaw/index.ts) supports canonical and legacy roots, Pi-style JSONL, selected current SQLite windows, compressed payload bytes, seq order and source validation.
The reference [discovery](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/OpenClawSessionDiscovery.swift#L87) mainly enumerates sessions JSONL, including `.jsonl.deleted.*` at line 104; Huihua's suffix filter omits those deleted-history files.
That is an additional local discovery option, not an established failure of current SQLite mapping.

Text, thinking and recorded tools overlap with [reference parsing](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/OpenClawSessionParser.swift#L297).
Some permissive role/block/tool-ID aliases are narrower and need independent evidence before expansion.
Keeping compactions, resets, branches, unknowns and repeated IDs differs deliberately from rendering a current transcript.
Cold restoration and live runtime behavior remain outside scope.

### Qwen

[Huihua](../src/providers/qwen/index.ts) has fixture-backed active/archive layout, first-head identity certification, configured-root precedence and isolated-home behavior.
Google text/thought/function calls/responses, explicit media, usage metadata and native event identifiers are retained.
Reference [Qwen parsing](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/QwenSessionParser.swift#L575) emits a toolCallResult-only fallback when no functionResponse exists; Huihua only uses that object to supplement a functionResponse part.
A payload-only reproduction produces no canonical result.
Confirm this display-result surface against a pinned producer before promoting it as complete model-facing output.

Reference runtime-user subtypes notification/cron/goal_runtime become metadata at lines 519–525, while Huihua emits user messages for their text.
That semantic classification needs an explicit canonical-message decision.
Reference active-chain selection, UUID-fragment aggregation, hook stripping and glued-JSON repair contradict Huihua's documented preservation policy and are not fixes to copy.

### Kimi

The three defects F02–F04 dominate this comparison.
[Huihua](../src/providers/kimi/index.ts) already preserves every physical agent wire, companions, native usage/model and explicit subagent events.
Reference [discovery](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/KimiSessionDiscovery.swift#L40) lists main-agent transcripts rather than Huihua's complete physical-stream set.
Huihua must preserve that broader source evidence while fixing loop mappings, state recognition and Usage arithmetic.

Several already known control families become unknown instead of system evidence, inflating parser diagnostics without necessarily invalidating token counters.
Newer agent.message.appended projection records may mirror loop output; mapping them as a second conversation requires an explicit provenance/representation decision.
Do not reconstruct context, merge agents or drop usageScope session contributions.

### Grok

[Huihua](../src/providers/grok/index.ts) deliberately reads updates.jsonl and summary.json through the shared ACP mapper.
Reference [discovery](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/GrokSessionDiscovery.swift#L3) reads chat_history.jsonl because update journals repeatedly contain accumulated tool output.
The reference's cited size comparison is its observation, not a benchmark performed here.
Huihua does not support the derived chat-history surface or sibling subagent metadata, and must not be described as equivalent source coverage.

The existing journal decision preserves native updates rather than folds; chat history is a useful acquisition alternative requiring documented provenance and duplicate-source policy.
Explicit sidecar parent IDs could support future bounded lineage discovery, but directory fallback or session-wide model inheritance must not invent native facts.
Ignoring empty environment home values also differs from the current relative-sessions result and warrants a focused discovery regression.

### Antigravity

[Huihua](../src/providers/antigravity/index.ts) maps a partial observed conversations steps SQLite/Protobuf subset and retains all native bytes, unknowns and unsupported tool outcomes.
Reference [discovery](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/AntigravitySessionDiscovery.swift#L40) reads desktop brain Markdown and CLI brain/id/.system_generated/logs/transcript.jsonl.
Those are different source families; sharing a provider name does not establish parity.

The captured [CLI JSONL fixture](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/Resources/Fixtures/stage0/agents/antigravity/cli_small.jsonl) establishes a meaningful missing local ingestion surface, including explicit step/type/time/planner/tool facts.
An additive JSONL reader should reuse the existing JSONL acquisition pipeline after native semantics and truncation behavior are researched.
Markdown-to-assistant guesses, mtime event timestamps, current-workspace/Git inspection, prose model extraction and remembered-last-tool matching are separate UI heuristics outside Huihua's contract.

### Devin

[Huihua](../src/providers/devin/index.ts) already understands the sessions/message_nodes schema, parent edges, main-chain order and OpenAI-style chat messages.
F01 prevents that mapper from reaching the real commented DDL.
The current [synthetic SQL fixture](../fixtures/devin/sessions.sql) and logical-message import omit those comments, so broad test success does not exercise the failing schema syntax.

Reference [Devin selection](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Devin/DevinSqliteReader.swift#L255) renders the recursive main chain and excludes hidden sessions.
Huihua deliberately preserves hidden sessions and abandoned branches with explicit branch-scoped diagnostics.
Sibling image arrays remain raw rather than normalized markers; adding their explicit media facts is a smaller mapping extension.
Placeholder cost/context cursors still do not establish usage.

### Cline

[Huihua](../src/providers/cline/index.ts) and reference discovery/parser select matching version-1 manifest and adjacent messages, reject companion identity/version mismatches and avoid arbitrary embedded paths.
Message order, thinking, tools, failures, metrics and surface facts overlap.
F10 concerns the missing native-profile environment root, not the snapshot parser.

Reference [Cline parsing](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/ClineSessionParser.swift#L110) also derives model/title summaries from the manifest.
A current/session-level model must not become an inferred historical response model.
Existing imported CLI and synthetic Desktop tests are useful but lack the selected-root precedence and isolation cases.
Legacy VS Code stores are expressly outside current claimed coverage.

### fx

[Huihua](../src/providers/fx/index.ts) and the reference [checkpoint parser](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/FxSessionParser.swift#L151) cover manifest/checkpoint turns, recorded tools, replies and interrupted work.
Huihua keeps complete result objects and explicitly diagnoses an unread post-checkpoint event tail.
The reference additionally acquires display.json titles and preference model/effort; these are optional extra sources, not evidence that checkpoint reads fail.

Reference background/compaction/byte/truncation tests are broader than Huihua's imported checkpoint and tail cases.
Expand those independent edge cases before claiming more complete parity.
No dereferencing artifacts, executing restore or treating cumulative snapshot counters as requests is required.

### DeepSeek Harness

[Huihua](../src/providers/deepseek/index.ts) and reference discovery agree on highest-generation selection, ambiguity and header/filename mismatch checks, with plain/Zstandard v0–v4 evidence.
Huihua retains packed chunks, repeated native lifecycle records, future headers and surface provenance; the reference [presentation parser](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/DeepSeekHarness/DeepSeekHarnessSessionParser.swift#L154) migrates/folds/deduplicates a display.
Those differences are intentional.

F08 and F09 are concrete lost native fields inside advertised historical coverage.
Imported minimal v2/v3 dispatch fixtures verify broad version dispatch, not wrapped historical tool results or explicit subagent parent keys.
Add those nearest regressions without editing static v1 baselines or silently importing migration/relationship frameworks.
The pure-JS bounded decoder remains an architectural alternative to the reference's native Zstandard core.

### Droid

[Huihua](../src/providers/droid/index.ts) and the reference support legacy nested messages and captured stream-json messages, tools, completions and errors.
All six top-level reference stage0 Droid fixtures mapped known events in the replay.
The reproduced alias gaps in F12 are therefore boundary cases omitted by existing fixtures, not a claim that the entire provider is broken.

Reference [Droid parsing](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/DroidSessionParser.swift#L717) normalizes more punctuation/case aliases and consults adjacent settings.
Huihua preserves system-reminder prose and raw fields instead of sanitizing/truncating the transcript representation.
Current/private remote-store certification and historical-model inference from present settings remain outside scope.
Neither reviewed implementation establishes a general Droid daily-token arithmetic contract.

### Additional Huihua providers

The audited Agent Sessions registry has no ACP, OAR or Morph counterpart.
There is consequently no corresponding implementation to compare or parity gap to infer.
[ACP](../src/providers/acp/index.ts) reads explicit recorded protocol notifications without a default store; [OAR](../src/providers/oar/index.ts) preserves voyage/RawEvent wrappers and native agent/span facts; [Morph](../src/providers/morph/index.ts) reads topic projections and ordered journals without inspecting workspace state.
Their own research/fixtures remain their compatibility authority.

## Considered and rejected as automatic fixes

- Removing unknown or repeated records to make compatibility metrics look better would destroy evidence.
- Deduplicating mirrored Claude/Copilot/Pi/DeepSeek observations would change the maintained representation and uncertainty contract.
- Replacing unknown Codex model with a session-wide latest model would conceal a missing attribution relationship.
- Treating every Kimi session-scoped usage record as cumulative would contradict the pinned producer.
- Inferring native parent/workspace/time from folder names, prose, mtime or present workspace files would invent past state.
- Copying reference SQLite/native-Zstandard engines, runtime resume, restore, search indexes, network pricing or UI projections would violate the package boundary.
- Suppressing diagnostics, weakening schema validation or updating snapshots to hide regressions would not establish compatibility.
- Unrelated documentation/link cleanup was not included in this compatibility audit.

## Recommended implementation order and validation

First fix F01 and the three Kimi defects independently: they explain hard scan failure, missing transcript selectors and completely unavailable native counters.
Next address F05 and the small confirmed field/alias failures F06–F09.
Then handle discovery/summary aliases F10–F12 and research the weaker historical Codex/Claude/Qwen families.
Turn-aware Codex attribution, additional Antigravity/Grok sources, broader SQLite batching and report-confidence changes require explicit owner/alternative/compatibility decisions before implementation.

Every bug fix should first fail a focused reproduction in the nearest existing harness, then extend the current helper/mapper and rerun that regression.
Provider changes must update their RESEARCH.md with primary facts, third-party observations and our decisions.
New public capabilities or serialized semantics also update architecture ownership and executable policy.
Use the existing SQL/native fixture sources and explicit fixture/golden tools; static v1 compatibility goldens stay immutable.
Run `pnpm check` after scoped fixes.
Do not run benchmark generators, workers or profiling workloads without separate user authorization.

This audit did not execute the Swift application/test suite, certify all private provider versions, inspect account/network/runtime behavior, or measure throughput.
The local full-history OpenCode run was stopped and is not a successful all-provider report.
Verification completed with `pnpm check`: all 380 tests passed, and lint, strict type checking, dependency/layer policy, fixture/compatibility/streaming checks and the installed 65-file ESM package passed.
All 33 local document links resolve.
Passing Huihua's existing suite demonstrates its current tested contracts, not equivalence to every reference format.
