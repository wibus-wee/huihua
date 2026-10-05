# Factory Droid compatibility evidence

Reviewed upstream source and documentation on 2026-10-05.

## Official facts

- [Source](https://docs.factory.com/droid-cli/settings): The official settings reference places local configuration under ~/.factory.
  This is not an authoritative session-store schema.
- [Source](https://github.com/Factory-AI/droid-sdk-typescript/blob/main/docs/sdk-usage-guide.md): Official SDK documentation describes exec-mode streaming and JSON-RPC acquisition.
  Executing the CLI is a different acquisition layer from reading stored history.

## Third-party compatibility experience

Legacy compatibility observations show ~/.factory/sessions/<workspace>/<id>.jsonl with a session_start header and nested message blocks.
Captured stream-json records can instead carry system/session_id or sessionId, flat message text, tool_call/toolCall, tool_result and completion.
Observed variants include working_directory, uppercase roles, tool_call_id/toolCallID or native event id, name/input, final text, completion usage, boolean/string error flags and numeric exit codes.
Streams can begin with a message rather than an initialization header.
The private interactive store is empirical, not an official versioned interchange contract.

## Huihua decisions

Read these legacy JSONL shapes using independent droid identity.
Preserve tool names, arguments, embedded tool results, repeated IDs, system wrappers and unknown records.
Use explicitly recorded session identities even in headerless captures; a first observed message does not establish session creation time.
Normalize confirmed field aliases without changing raw records.
Tool failures use explicit flags and nonzero integer exit codes, never output prose.
Also discover legacy ~/.factory/projects recordings.
Do not strip system-reminder text or infer failures from output prose.
Companion settings, current remote sessions and newer private schemas are not certified.

Fixtures combine local synthetic examples and pinned independent compatibility inputs; they do not establish release-wide correctness.
[Fixture provenance](../../../fixtures/compatibility/README.md) distinguishes upstream validation from the facts asserted through Huihua's public API.
[Architecture](../../../docs/architecture.md#provider-coverage-and-format-ownership) owns acquisition, evidence and resource-limit contracts.
