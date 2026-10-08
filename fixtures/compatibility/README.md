# Independent provider compatibility corpus

These 34 artifacts are unmodified copies from Agent Sessions.
The original 22 use [revision b7893c7](https://github.com/jazzyalex/agent-sessions/tree/b7893c772b0014918211f1c45a5ab58add229703); 12 additional audit inputs use [revision 6fa9a73](https://github.com/jazzyalex/agent-sessions/tree/6fa9a73f489d37f655873871e5e6a5cf6975d1ff).
In sources.json, a file's optional commit overrides the top-level commit; existing artifacts and hashes remain unchanged.
[sources.json](sources.json) records the exact upstream path and SHA-256 of every artifact;
[LICENSE](LICENSE) retains the upstream MIT notice.
The copies are fixed test inputs, never generated output or a source of runtime dependencies.

| Provider | Inputs | Huihua assertions |
| --- | --- | --- |
| Kimi | [Wire](kimi/assistant_tools.jsonl), [ID-less state](kimi/assistant_tools.state.json) | Complete records, loop content/tools/errors, metadata and exact four-component usage arithmetic |
| Codex | [Historical tools](codex/large.jsonl), [schema drift](codex/schema_drift.jsonl) | Historical chat/function aliases, raw evidence and explicit usage scope |
| Cursor | [CLI schema drift](cursor/schema_drift.jsonl) | Native tool alias IDs, names, arguments and failed results |
| Grok | [Chat history](grok/chat_history.jsonl), [summary](grok/summary.json), [child history](grok/subagent/chat_history.jsonl) and summary | Chat/reasoning/native tool results, explicit metadata and unknown variants |
| Antigravity | [CLI transcript](antigravity/cli_small.jsonl), [schema drift](antigravity/cli_schema_drift.jsonl) | Step facts, reasoning/tools, explicit truncation diagnostics, no invented tool IDs |
| Copilot | [JSONL](copilot/small.jsonl) | Native record order, mirrored call arguments, standalone reasoning |
| Hermes | [Snapshot](hermes/large.json), [schema drift](hermes/schema_drift.json) | Native identity, workspace spelling, reasoning, tools, unknown roles and explicit finish_reason failure |
| OpenClaw | [Legacy JSONL](openclaw/small.jsonl) | Pi message parts, message IDs, tool IDs and usage |
| Qwen | [JSONL](qwen/session.jsonl) | Google tool parts, reasoning and unmodified hook context |
| Devin | [Logical row payloads](devin/small.json) | Flat object arguments, message IDs, reasoning and native payloads in a temporary SQL store |
| fx | [Manifest](fx/session.json), [checkpoint](fx/checkpoint.json) | Native identity, tool arguments, interruption and incomplete-tail diagnostics |
| Cline | [Manifest](cline/cline-cli-tool.json), [messages](cline/cline-cli-tool.messages.json) | Adjacent acquisition, embedded failed results, metrics and reasoning |
| Droid | [Stored JSONL](droid/session_store_small.jsonl), [captured stream](droid/stream_json_small.jsonl) | Stored/headerless identities and native tool call/result IDs |
| DeepSeek | v0–v4 plain JSONL and Zstandard pairs in [deepseek](deepseek) | Native identity, records, tool relationships and independently checksummed frame equivalence |

[tests/provider-imports.test.ts](../../tests/provider-imports.test.ts) owns the hash checks and public-API assertions.
Its focused Droid, Qwen and Copilot cases also exercise field variants from upstream tests and official contracts.
Additional metadata/discovery and usage assertions are in [behavior.test.ts](../../tests/behavior.test.ts) and [usage.test.ts](../../tests/usage.test.ts).
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
