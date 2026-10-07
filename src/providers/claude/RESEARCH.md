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

[Design decisions](../../../docs/design.md) own the provider behavior inventory and binary-reading choices.
The adjacent TypeScript implementation and shared compatibility fixtures are the maintained sources of truth.
