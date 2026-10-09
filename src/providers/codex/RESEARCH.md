# Codex compatibility research

The existing per-replay parser owns Usage model attribution in all delivery modes.
An explicit payload.model wins; otherwise a compatible native turn_context supplies model with model_origin=turn_context and the recorded context.
No model is inferred from session metadata, prose or a different turn ID.
New contexts (even without a model), session/task starts, completion/abort and malformed records clear the window.
Full, selective, callback, evidence-free and timestamp-filtered facts agree; replay and source state are isolated.
Default event metadata with only same-record facts remains unchanged; inherited turn models add provenance, and evidence-free delivery explicitly carries either kind of model fact.
Request response identity stays in the native token_usage_record payload.
Cumulative token_count and turn.completed counters remain observations, excluded from additive request totals without deltas or deduplication.

Reviewed 2026-10-05.
Primary source: openai/codex
[`80cce09`](https://github.com/openai/codex/tree/80cce09d059780528e59353ab3d87e4c97d1e944/codex-rs).
Secondary: recall [`47a2252`](https://github.com/pratikgajjar/recall/blob/47a2252f3c60dffdeafa50a25c6923c1ef2568ee/codex.go).

| Official facts                                                                                                                                                        | Third-party compatibility experience                                                                                                                                                                                           | Huihua decisions                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rollout crate owns JSONL persistence; protocol SessionMeta records id, cwd, timestamp, forked_from_id/parent_thread_id and optional git                               | recall discovers active and archived JSONL without launching Codex                                                                                                                                                             | Discovery owns default CODEX_HOME roots; parsers accept explicit files; scan reads a bounded header only                                                                                                            |
| Records use timestamp/type/payload; response_item contains message, reasoning, function/custom tool calls and outputs                                                 | Existing consumers often extract only text from event_msg/response_item                                                                                                                                                        | Keep both evidence streams, label native record type, never merge/delete mirrored records; consumers can select their projection                                                                                    |
| Function arguments are JSON encoded inside a string; outputs may be text or structured arrays                                                                         | Historical rollouts omit fields newer recorders provide                                                                                                                                                                        | Decode valid argument JSON, preserve the original record; invalid JSON stays a string with a diagnostic                                                                                                             |
| Reasoning may have summary/content/encrypted_content                                                                                                                  | Tool outputs and schema additions drift across versions                                                                                                                                                                        | Separate reasoning; preserve encryption as evidence; unknown and malformed records remain Unknown                                                                                                                   |
| [Official compression reader](https://github.com/openai/codex/blob/80cce09d059780528e59353ab3d87e4c97d1e944/codex-rs/rollout/src/compression.rs) accepts `.jsonl.zst` | Flat JSONL-only adapters omit compressed archives                                                                                                                                                                              | Use streaming zstd decoding, bounded decompressed headers/records and a 32 MiB window ceiling and 4 GiB declared-frame-size ceiling; reject dictionaries and validate content checksums; no materialized transcript |
| Official protocol defines collab_agent_spawn_end / collab_agent_interaction and native agent statuses                                                                 | Flat consumers often discard collab lifecycle records                                                                                                                                                                          | Normalize only explicitly identified agents/stages; no invented ID for spawn_begin before an agent exists                                                                                                           |
| Native lineage and history_base/subagent ordinals exist                                                                                                               | Flat viewers often do not reconstruct inheritance                                                                                                                                                                              | Expose explicit parent IDs; retain history_base/ordinals raw, never chase another store or fabricate inherited events                                                                                               |
| Our pinned official recorder does not define token_usage_record                                                                                                       | [ccusage Codex parser](https://github.com/ccusage/ccusage/blob/b8bfa6aa2f179de118c2ef3bf066b1e4372878d2/rust/adapters/codex/src/parser.rs) tests separate request/compaction usage records and cumulative/last token snapshots | Accept the empirical shape as Usage with complete payload; preserve repeated/cumulative snapshots, never calculate deltas or drop replay history; model attribution uses recorded provenance                        |

Fixtures are authored minimal examples derived from these published shapes, not copied private
transcripts.
No claim of compatibility with every future Codex version.
Compressed rollouts use the same JSONL semantics after bounded streaming decompression.

## Implementation decisions

The existing metadata mapper accepts selected patch keys from shared ingestion.
Session-meta identity extraction always runs, including conflicting later headers;
workspace/git/time/parent fields are constructed only when selected.
Discovery and default full reads retain all original fields, and no usage field,
timestamp or branch is inferred by this allocation change.
Recorded turn-model attribution is a separate explicit provider decision above.

[Pinned reference fixtures](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/Resources/Fixtures/stage0/agents/codex/schema_drift.jsonl) establish empirical historical chat/function/tool aliases.
They are normalized by this same mapper while retaining complete native records.
Nested source.subagent.thread_spawn.parent_thread_id supplies lineage only after explicit top-level parent_thread_id/forked_from_id, so precedence remains deterministic.
These private aliases and request-usage observations are third-party compatibility evidence, distinct from the official protocol facts.

[Design decisions](../../../docs/design.md) own the provider behavior inventory and binary-reading choices.
The adjacent TypeScript implementation and shared compatibility fixtures are the maintained sources of truth.

## Observed 0.162.0 lifecycle and mirror changes

The [2026-10-09 native CI capture](https://github.com/wibus-wee/huihua/actions/runs/37926896716)
adds task_started turn attribution and removes old turn-context and command-mirror fields.
These are empirical official-CLI outputs, not a guarantee of a stable schema.
No third-party
parser behavior is used to infer their meaning.
The existing provider preserves task_started
and item_completed as complete unknown payloads and turn_context as system evidence.
The actual tool result still comes from response_item, not removed mirror output fields.
The reviewed compatibility baseline keeps two complete shapes rather than making all changed
paths independently optional.
See docs/producer-compatibility.md for exact changes and digests.
