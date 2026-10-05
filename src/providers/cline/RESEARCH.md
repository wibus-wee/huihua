# Cline CLI and Desktop compatibility evidence

Reviewed upstream source and documentation on 2026-10-05.

## Official facts

- [Source](https://github.com/cline/cline/blob/main/sdk/packages/core/docs/messages-contract-v1.md): The version-1 messages artifact contains sessionId, system_prompt and ordered native messages.
  Messages carry id, ts in epoch milliseconds, modelInfo, metrics and Anthropic content blocks; tool results are user-message blocks.
- [Source](https://github.com/cline/cline/blob/main/sdk/packages/core/src/session/stores/session-manifest-store.ts): The manifest and messages file live beside each other in the session directory.
  Manifest metadata identifies surface, workspace and title.

## Third-party compatibility experience

CLI and Desktop use the same durable messages contract.
Imported histories can retain a different source provider in provenance, which does not change the file owner or justify dispatching to another adapter.

## Huihua decisions

Discover ~/.cline/data/sessions/<id>/<id>.json.
Read the adjacent <id>.messages.json, ignoring exported messages_path and importedFrom paths.
Require version 1 and matching native identities across companions, even when the caller supplies a display ID.
Missing companions fail; malformed evidence remains unknown.
Each complete JSON file is one record and all embedded messages refer to it.
Preserve repeated IDs, reasoning, embedded tool results, per-message modelInfo/metrics and source surface.
Legacy VS Code api_conversation_history.json and runtime hooks are separate formats outside this adapter.

Fixtures are handwritten synthetic format examples, not collected private sessions or a release-wide certification.
[Architecture](../../../docs/architecture.md#provider-coverage-and-format-ownership) owns acquisition, evidence and resource-limit contracts.
