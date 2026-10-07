# Qwen Code compatibility evidence

Reviewed upstream source and documentation on 2026-10-05.

## Official facts

- [Source](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/chatRecordingService.ts): ChatRecord is ordered JSONL with sessionId, uuid, parentUuid, timestamp, cwd, a native Google Content message with parts, usageMetadata, and systemPayload/subtype metadata.
- [Source](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/session-transcript-reader.ts): The upstream reader distinguishes conversation records, system records, transcript topology and non-conversation telemetry.

## Third-party compatibility experience

Compatibility observations include project-local chats directories, tool results with systemPayload.toolCallId, and native functionCall/functionResponse parts.
Tool-result UI metadata can retain callId and error status when functionResponse omits them.
Historical installations can predate QWEN_HOME.
Agent Sessions' [Qwen discovery](https://github.com/jazzyalex/agent-sessions/blob/6fa9a73f489d37f655873871e5e6a5cf6975d1ff/AgentSessions/Services/QwenSessionDiscovery.swift)
records the older-version QWEN_HOME failure, exact project/chats and chats/archive layouts,
32–36 character hexadecimal/hyphen filenames, and first-record sessionId certification.
This is compatibility experience, not a release-wide captured transcript guarantee.
No release-wide compatibility claim follows from synthetic examples.

## Huihua decisions

Use QWEN_HOME/projects only when it is a directory; otherwise fall back to ~/.qwen/projects.
An empty configured projects directory still wins; explicit homeDir isolates the environment.
Directory scans accept only <project>/chats/<id>.jsonl and <project>/chats/archive/<id>.jsonl relative to the projects root.
The first complete nonblank physical record must match the native session-ID filename; missing, malformed,
oversized/truncated or mismatched heads cannot be certified from later records.
Exact explicit file roots bypass native layout certification for portable evidence acquisition.
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
