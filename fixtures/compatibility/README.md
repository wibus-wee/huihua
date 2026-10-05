# Independent provider compatibility corpus

These 22 artifacts are unmodified copies from [Agent Sessions revision b7893c7](https://github.com/jazzyalex/agent-sessions/tree/b7893c772b0014918211f1c45a5ab58add229703).
[sources.json](sources.json) records the exact upstream path and SHA-256 of every artifact;
[LICENSE](LICENSE) retains the upstream MIT notice.
The copies are fixed test inputs, never generated output or a source of runtime dependencies.

| Provider | Inputs | Huihua assertions |
| --- | --- | --- |
| Copilot | [JSONL](copilot/small.jsonl) | Native record order, mirrored call arguments, standalone reasoning |
| Hermes | [Snapshot](hermes/large.json) | Native identity, workspace spelling, reasoning, tools and unknown roles |
| OpenClaw | [Legacy JSONL](openclaw/small.jsonl) | Pi message parts, message IDs, tool IDs and usage |
| Qwen | [JSONL](qwen/session.jsonl) | Google tool parts, reasoning and unmodified hook context |
| Devin | [Logical row payloads](devin/small.json) | Flat object arguments, message IDs, reasoning and native payloads in a temporary SQL store |
| fx | [Manifest](fx/session.json), [checkpoint](fx/checkpoint.json) | Native identity, tool arguments, interruption and incomplete-tail diagnostics |
| Cline | [Manifest](cline/cline-cli-tool.json), [messages](cline/cline-cli-tool.messages.json) | Adjacent acquisition, embedded failed results, metrics and reasoning |
| Droid | [Stored JSONL](droid/session_store_small.jsonl), [captured stream](droid/stream_json_small.jsonl) | Stored/headerless identities and native tool call/result IDs |
| DeepSeek | v0–v4 plain JSONL and Zstandard pairs in [deepseek](deepseek) | Native identity, records, tool relationships and independently checksummed frame equivalence |

[tests/provider-imports.test.ts](../../tests/provider-imports.test.ts) owns the hash checks and public-API assertions.
Its focused Droid, Qwen and Copilot cases also exercise field variants from upstream tests and official contracts.
Additional Hermes/OpenClaw SQLite cases remain in the local synthetic corpus and use their documented official schemas.

The upstream inputs have different evidence strengths.
Devin's logical corpus reports verified CLI schema/payload observations.
The [DeepSeek manifest](deepseek/manifest.json) records catalog validation, source revisions and independent frame production.
Other committed examples combine synthetic and redacted compatibility inputs; a committed example does not establish every installed version's behavior.
Huihua checks the facts stated in the table, and does not run the upstream Swift test suite.

Huihua preserves native observations rather than reproducing another application's display output:
hook/system text and abandoned branches stay recorded, mirrored events stay separate, and DeepSeek surface changes are not replayed through migrations.
fx covers checkpoint history and diagnoses the unconsumed tail.
Passing these tests establishes compatibility for their recorded facts, not release-wide correctness or parity with every private store.
