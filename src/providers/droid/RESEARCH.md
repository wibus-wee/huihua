# Factory Droid compatibility evidence

Reviewed upstream source and documentation on 2026-10-05.

## Official facts

- [Source](https://docs.factory.com/droid-cli/settings): The official settings reference places local configuration under ~/.factory.
  This is not an authoritative session-store schema.
- [Source](https://github.com/Factory-AI/droid-sdk-typescript/blob/main/docs/sdk-usage-guide.md): Official SDK documentation describes exec-mode streaming and JSON-RPC acquisition.
  Executing the CLI is a different acquisition layer from reading stored history.

## Third-party compatibility experience

Legacy compatibility observations show ~/.factory/sessions/<workspace>/<id>.jsonl with a session_start header and nested message blocks.
Captured stream-json records can instead carry system/session_id, flat message text, tool_call, tool_result and completion.
The private interactive store is empirical, not an official versioned interchange contract.

## Huihua decisions

Read these legacy JSONL shapes using independent droid identity.
Preserve tool names, arguments, embedded tool results, repeated IDs, system wrappers and unknown records.
Also discover legacy ~/.factory/projects recordings.
Do not strip system-reminder text or infer failures from output prose.
Companion settings, current remote sessions and newer private schemas are not certified.

Fixtures are handwritten synthetic format examples, not collected private sessions or a release-wide certification.
[Architecture](../../../docs/architecture.md#provider-coverage-and-format-ownership) owns acquisition, evidence and resource-limit contracts.
