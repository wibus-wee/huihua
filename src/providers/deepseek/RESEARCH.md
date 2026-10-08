# DeepSeek Harness compatibility evidence

Reviewed upstream source and documentation on 2026-10-05.

## Official facts

- [Source](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/persistence-changes/historical-formats/README.md): Historical formats are independently versioned immutable session generations, with adjacent migration contracts.
- [Source](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/persistence-changes/2026-09-16-session-format-v4.md): Version 4 records developer messages and first-class tool results; user/message stores a direct message while assistant/message and tool/result use wrappers.
- [Source](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-format/src/filename.ts): Version zero uses session.jsonl; later generations use session.vN.jsonl.
  Compression adds .zstd.
- [Source](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-format-v0-to-v1/src/codec.ts): Historical packed text/reasoning observations use seq0/time0 and dt deltas.
  Surface edits and source-event references are native evidence.

## Third-party compatibility experience

Compatibility observations distinguish immutable generations from separate sessions and independently framed Zstandard artifacts from plain JSONL.
A successful streamed prefix cannot establish that a later frame is intact.

## Huihua decisions

Discover DSH_HOME/sessions or ~/.dsh/sessions.
Select the highest generation in each session directory; equal-generation plain/compressed ambiguity fails explicitly.
Support known v0–v4 facts without applying upstream migrations, rebuilding a model surface, or rewriting history.
Preserve packed observations, mirrored calls, surfaceOp, sourceEventSeqs and physical record order.
Unknown/future events remain evidence with diagnostics.
Zstandard uses the existing checksum/window-limited reader.
No runtime/plugin dependency or native decoder is installed; dictionary frames and oversized windows remain unsupported.

The [pinned historical decoder](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/DeepSeekHarness/DeepSeekHarnessFormatTypes.swift) distinguishes wrapped v2/v3 results and explicit parentSession headers.
Huihua keeps parentSessionId precedence, then accepts parentSession; origin and delegationDepth remain native metadata.
Historical result IDs come from nested toolCallId, source.callId or native callId/subCallId fields; nested isError establishes failure.
The result projection retains the whole native wrapper and does not chase the parent or reconstruct seeded history.

Fixtures combine local synthetic examples and pinned independent compatibility inputs; they do not establish release-wide correctness.
[Fixture provenance](../../../fixtures/compatibility/README.md) distinguishes upstream validation from the facts asserted through Huihua's public API.
[Architecture](../../../docs/architecture.md#provider-coverage-and-format-ownership) owns acquisition, evidence and resource-limit contracts.
