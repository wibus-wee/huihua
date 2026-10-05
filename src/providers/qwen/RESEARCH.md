# Qwen Code compatibility evidence

Reviewed upstream source and documentation on 2026-10-05.

## Official facts

- [Source](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/chatRecordingService.ts): ChatRecord is ordered JSONL with sessionId, uuid, parentUuid, timestamp, cwd, a native Google Content message with parts, usageMetadata, and systemPayload/subtype metadata.
- [Source](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/session-transcript-reader.ts): The upstream reader distinguishes conversation records, system records, transcript topology and non-conversation telemetry.

## Third-party compatibility experience

Compatibility observations include project-local chats directories, tool results with systemPayload.toolCallId, and native functionCall/functionResponse parts.
Tool-result UI metadata can retain callId and error status when functionResponse omits them.
Historical installations can predate QWEN_HOME.
No release-wide compatibility claim follows from synthetic examples.

## Huihua decisions

Discover QWEN_HOME/projects or ~/.qwen/projects; explicit homeDir isolates the environment.
Exclude system.jsonl and system_telemetry.jsonl.
Read ordinary UTF-8 JSONL through the existing framer; malformed or glued JSON objects remain unknown evidence rather than repaired data.
Normalize text, thought parts, tools, explicit attachment data and native usage.
Prefer functionResponse.id, then systemPayload.toolCallId, then toolCallResult.callId for result identity; explicit response/UI errors and UI error status establish failure.
Use custom_title and parent_session only when recorded.
Preserve compression/rewind records without replaying them.
Managed daemon stores and arbitrary JSON exports are not supported.

Fixtures combine local synthetic examples and pinned independent compatibility inputs; they do not establish release-wide correctness.
[Fixture provenance](../../../fixtures/compatibility/README.md) distinguishes upstream validation from the facts asserted through Huihua's public API.
[Architecture](../../../docs/architecture.md#provider-coverage-and-format-ownership) owns acquisition, evidence and resource-limit contracts.
