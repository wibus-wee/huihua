# Captured synthetic writer evidence

Source: [run 38047648682](https://github.com/wibus-wee/huihua/actions/runs/38047648682), 2026-10-10.

- `live-2026-10-10.jsonl`: copilot 1.0.95, artifact 11668870610, ZIP SHA-256 `f3ae0a8a1508109b574d97ca017d32f3df88563b6f2128c1b8e486021497bdea`.
- `pinned-2026-10-10.jsonl`: copilot 1.0.93, artifact 11668920452, ZIP SHA-256 `905f9f6f97cf2548de41739d31e628153b2f94053ae5ad9a75dedc181bd3636c`.

Lines are derived from captured read.records and reserialized as JSONL.
Producer prompt text is redacted and runner workspace paths are replaced with a synthetic path.
Field names, types, event ordering, usage counters and correlation fields are preserved.
Whitespace is not the original byte representation. No authentication files, environment files,
or producer binaries are included. These fixtures establish only this synthetic journey.


## Copilot system-message representations (2026-10-15)

Fresh local captures replay `tools/producer-compat/live.ts` at Huihua commit
`7d1e62a53fd54ea9316fc59f545554b48f4a1b3c` with the system-message oracle added in
this change. Both use the manifest's simulator commit
`4357945b88d16a1a3155c39305ce135dc66b9510`, synthetic credentials, an empty temporary
workspace and the text/continue journey. Producer packages are installed from npm.

| Native JSONL | CLI | SHA-256 |
| --- | --- | --- |
| `cli-1.0.95-2026-10-15.jsonl` | `@github/copilot@1.0.95` | `d4b260a8b9c80d3cef84d8e825b690f79b5da9a8f1c87c7651a44255545e9670` |
| `cli-1.0.97-2026-10-15.jsonl` | `@github/copilot@1.0.97` | `ac99f67324b0d8f300cc1f423936e5e29cd73897ba3a900a4b451c95938f4737` |

These two files are byte-for-byte copies of the native `events.jsonl`, with all 15
records and the complete 22,515-character system body retained. They are not the
2026-10-14 Actions artifacts linked from [issue #43](https://github.com/wibus-wee/huihua/issues/43).
No prompt redaction or path replacement is applied to these captures; all paths
refer to the isolated synthetic runner. No authentication files, environment dumps
or producer binaries are included.

1.0.95 includes `data.contentBlocks` and an `isStatic` marker; 1.0.97 omits them.
Both retain the complete body in `data.content`. Native field/type drift is exactly
the four system-message paths reported by issue #43. Read, snapshot and both stream
interfaces preserve complete system payloads and first/resumed user/assistant text.
The 1.0.95 replay passed the existing baseline; 1.0.97 reached baseline review after
all reading assertions passed. The reviewed baseline makes only those four paths
optional, including their existing types. Different types, unknown block fields,
missing system content and changes to other record types still fail.
This certifies these text/continue samples only; no tool roundtrip was exercised.
