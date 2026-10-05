# GitHub Copilot CLI compatibility evidence

Reviewed upstream source and documentation on 2026-10-05.

## Official facts

- [Source](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts): The official generated event contract defines session.start context, user/assistant messages, toolRequests, execution start/completion, reasoning and usage.
  Native event envelopes carry IDs, timestamps and parentId.
- [Source](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-command-reference): The CLI supports local session persistence.
  Session-state directories and historical flat JSONL files are compatibility inputs, not a stable SDK export guarantee.

## Third-party compatibility experience

Compatibility observations include both flat session-state JSONL and per-session events.jsonl.
Assistant toolRequests and execution_start can mirror one call; removing either loses an observation.
These observations do not certify every CLI release.

## Huihua decisions

Discover ~/.copilot/session-state and accept explicit roots.
Map only confirmed event fields, retain both mirrored calls and their native IDs, keep arguments unchanged, and preserve future events as unknown.
Usage objects remain native; no quota or price calculation.
Folder-trust prose never establishes a workspace.
Attachment references remain data and are never opened.

Fixtures are handwritten synthetic format examples, not collected private sessions or a release-wide certification.
[Architecture](../../../docs/architecture.md#provider-coverage-and-format-ownership) owns acquisition, evidence and resource-limit contracts.
