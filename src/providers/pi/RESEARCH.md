# Pi compatibility evidence

| Official facts                                                                                                                                                                                                                                 | Third-party compatibility experience                                                                                                                                                                          | Huihua decisions                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Official session format](https://github.com/earendil-works/pi/blob/dcd461925db2edf69a43c8135db1180d418afd54/packages/coding-agent/docs/session-format.md) documents JSONL headers, v1 linear entries, v2 trees and v3 custom-message changes. | [recall pi.go](https://github.com/pratikgajjar/recall/blob/47a2252f3c60dffdeafa50a25c6923c1ef2568ee/pi.go) focuses on flattened conversational messages.                                                      | Read every entry in physical order; retain id/parentId and all branches. Do not reconstruct only the selected LLM context or apply Pi's mutating migration code.                       |
| `parentSession` is a file path; entry parentId is a tree edge, not a session ID.                                                                                                                                                               | Flattening can lose branch and fork evidence.                                                                                                                                                                 | Preserve parentSession in metadata; never pretend it is parent_session_id. Preserve tree edges in event metadata, including null roots.                                                |
| Assistant blocks include text, thinking, images and toolCall; toolResult and bashExecution are separate roles. Compaction and branch summaries are real records.                                                                               | Some parsers discard custom/configuration entries or estimate missing usage.                                                                                                                                  | Normalize explicit message/tool/command/usage facts. Preserve compaction/configuration records as System and new/custom records as Unknown. Never fabricate reasoning or usage.        |
| Default session root is `.pi/agent/sessions`; header version may be absent in v1.                                                                                                                                                              | Encoded workspace directories are not a reliable inverse path mapping.                                                                                                                                        | Workspace only comes from header.cwd. Future header versions are preserved and diagnosed UnsupportedSchema, with best-effort known records.                                            |
| Native usage and tree edges are evidence, not reconstructed totals.                                                                                                                                                                            | [ccusage Pi parser](https://github.com/ccusage/ccusage/blob/b8bfa6aa2f179de118c2ef3bf066b1e4372878d2/rust/adapters/pi/src/parser.rs) accepts lenient token fields and classifies replay prefixes for billing. | Keep null/string/numeric usage and every branch; no missing-count defaults or replay removal. PI_AGENT_DIR is a consumer convention; use native PI_CODING_AGENT_DIR or explicit roots. |

Reviewed official checkout at dcd461925db2edf69a43c8135db1180d418afd54, 2026-10-05.
Fixtures cover v1/v3, tree edges, interrupted calls and unknown records; more real anonymized fixtures are needed as releases evolve.

## Implementation decisions

[Design decisions](../../../docs/design.md) own the provider behavior inventory and binary-reading choices.
The adjacent TypeScript implementation and shared compatibility fixtures are the maintained sources of truth.

## Session discovery and pi-subagents artifacts (2026-10-09)

### Official facts

The [official format](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/session-format.md)
defines a type=session header as the first record, including legacy sessions without a version.
The [session manager](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/src/core/session-manager.ts)
checks header content when discovering sessions.
session_info.name is a mutable display name;
parentSession is a file path, not a parent session ID.
Pi also provides [pi.appendEntry(customType, data)](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/src/core/extensions/types.ts#L1719)
for extension-owned durable custom records excluded from model context.

### Third-party compatibility experience

[Huihua #27](https://github.com/wibus-wee/huihua/issues/27) reports extension transcripts being
listed as sessions alongside genuine nested child sessions.
The [pi-subagents transcript writer](https://github.com/nicobailon/pi-subagents/blob/ad11b7ab1b09abd9a6ebdeff032f9c7279c606fc/src/shared/child-transcript.ts)
writes version/recordType/source/runId/agent records, without a Pi session header.
The extension's [child naming helper](https://github.com/nicobailon/pi-subagents/blob/ad11b7ab1b09abd9a6ebdeff032f9c7279c606fc/src/shared/child-session-name.ts)
now derives readable names from the agent and task.
Its [runtime](https://github.com/nicobailon/pi-subagents/blob/ad11b7ab1b09abd9a6ebdeff032f9c7279c606fc/src/runs/shared/subagent-prompt-runtime.ts)
may instead retain an intercom routing name with older bridges.
The [route builder](https://github.com/nicobailon/pi-subagents/blob/ad11b7ab1b09abd9a6ebdeff032f9c7279c606fc/src/intercom/intercom-bridge.ts)
allows hyphens in both agent and run ID and uses index+1 for an optional suffix.
Thus subagent-* is neither a universal child marker nor an unambiguous encoding of agent,
runId and childIndex.
[Upstream #2763](https://github.com/nicobailon/pi-subagents/issues/2763)
requests persisted parent-session metadata and remains open at review time.

### Huihua decisions

The Pi adapter owns content certification through the existing identify hook: directory
discovery requires type=session on the first record of the bounded prefix.
Checking any later record, excluding a private artifacts directory, or adding a second parser
would weaken content identity or duplicate existing ownership.
Malformed heads are not skipped to certify a later session record; incomplete bounded headers
cannot certify a candidate.
A recognized header with a missing ID still retains the existing
source-locator fallback, and future versions remain discoverable and diagnosed on read.
Exact file roots remain explicitly readable, as do direct read/open/parse/stream inputs.
No dependency, public API, event mapping or agent-session/v1 representation changes.
Keep names as recorded titles; defer optional subagent identity and parent linkage until a
structured persisted fact is available.
An upstream extension-owned custom entry containing explicit agent/run/parent IDs could supply
those facts in the session itself, without a title parser or artifact-layout dependency.
Never derive parentSessionId from directory names or
reinterpret parentSession as an ID.
The behavior regression covers default/explicit directory roots, nested child identity,
artifact rejection, malformed/late headers, bounded prefixes, future versions and explicit acquisition.
