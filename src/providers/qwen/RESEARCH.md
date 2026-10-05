# Qwen Code compatibility evidence

Reviewed upstream source and documentation on 2026-10-05.

## Official facts

- [Source](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/chatRecordingService.ts): ChatRecord is ordered JSONL with sessionId, uuid, parentUuid, timestamp, cwd, a native Google Content message with parts, usageMetadata, and systemPayload/subtype metadata.
- [Source](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/session-transcript-reader.ts): The upstream reader distinguishes conversation records, system records, transcript topology and non-conversation telemetry.

## Third-party compatibility experience

Compatibility observations include project-local chats directories, tool results with systemPayload.toolCallId, and native functionCall/functionResponse parts.
Historical installations can predate QWEN_HOME.
No release-wide compatibility claim follows from synthetic examples.

## Huihua decisions

Discover QWEN_HOME/projects or ~/.qwen/projects; explicit homeDir isolates the environment.
Exclude system.jsonl and system_telemetry.jsonl.
Read ordinary UTF-8 JSONL through the existing framer; malformed or glued JSON objects remain unknown evidence rather than repaired data.
Normalize text, thought parts, tools, explicit attachment data and native usage.
Use custom_title and parent_session only when recorded.
Preserve compression/rewind records without replaying them.
Managed daemon stores and arbitrary JSON exports are not supported.

Fixtures are handwritten synthetic format examples, not collected private sessions or a release-wide certification.
[Architecture](../../../docs/architecture.md#provider-coverage-and-format-ownership) owns acquisition, evidence and resource-limit contracts.
