# 汇话 · Huihua

**One API for Coding Agent session data.**

Huihua is a TypeScript library for reading local session data produced by different Coding Agents through one consistent API.

> [!NOTE]
> **Under heavy development.** APIs are not yet stable and may change in ways that break compatibility between releases.

## Supported Providers

<p>
<kbd>Codex</kbd>
&nbsp;
<kbd>Claude</kbd>
&nbsp;
<kbd>Pi</kbd>
&nbsp;
<kbd>Cursor</kbd>
&nbsp;
<kbd>OpenCode</kbd>
&nbsp;
<kbd>OAR</kbd>
&nbsp;
<kbd>ACP</kbd>
&nbsp;
<kbd>Morph</kbd>
&nbsp;
<kbd>Kimi</kbd>
&nbsp;
<kbd>Grok</kbd>
&nbsp;
<kbd>Antigravity</kbd>
&nbsp;
<kbd>Copilot CLI</kbd>
&nbsp;
<kbd>Hermes</kbd>
&nbsp;
<kbd>OpenClaw</kbd>
&nbsp;
<kbd>Qwen Code</kbd>
&nbsp;
<kbd>Devin CLI</kbd>
&nbsp;
<kbd>fx</kbd>
&nbsp;
<kbd>Cline</kbd>
&nbsp;
<kbd>DeepSeek Harness</kbd>
&nbsp;
<kbd>Droid</kbd>
</p>

## Installation

```sh
npm install huihua
pnpm install huihua
bun install huihua
yarn add huihua
```

## Quick start

```ts
import { sessions } from 'huihua'
import { conversationOf, toolCallsOf } from 'huihua/observe'

const { refs, failures } = await sessions.scan({ providers: ['codex'] })
for (const failure of failures)
  console.warn(failure.provider, failure.source?.path, failure.message)

if (refs[0]) {
  const session = await sessions.read(refs[0])
  conversationOf(session) // user and assistant messages, in source order
  toolCallsOf(session) // tool calls
}
```

A `Session` uses the `agent-session/v1` schema: `records` hold each native record once in read
order, normalized `events` refer back to their record, and `diagnostics` explain partial parses.
Unknown data is retained rather than dropped; missing facts stay absent.
Keep the whole `SessionRef` when passing sessions around — an ID alone can be ambiguous across
stores, and `source` identifies the exact file or selector.

| Selector                      | Selected events                                   |
| ----------------------------- | ------------------------------------------------- |
| `eventsOf(session, ...types)` | Explicit event types, with a narrowed result type |
| `conversationOf(session)`     | User and assistant messages                       |
| `toolCallsOf(session)`        | Tool calls                                        |
| `toolResultsOf(session)`      | Tool results                                      |
| `fileChangesOf(session)`      | File changes                                      |
| `subagentsOf(session)`        | Subagent lifecycle events                         |

Selectors keep order, duplicates and the original event objects; they never merge messages or
resolve relationships. `millisOf(timestamp)` converts a native `Timestamp` to epoch
milliseconds, leaving absent or unparseable input absent.
Serialize with `jsonOf(session)` or `JSON.stringify(session)`; `record.text` preserves JSON
numeric spellings beyond JavaScript's safe integer range.

## Reading paths

| Entry point                        | Input                                                           | Returns                                                              |
| ---------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| `sessions.scan(options?)`          | Provider ids, `roots`, `homeDir`, `signal`                      | `{ refs, failures }`; refs sorted                                    |
| `sessions.scanStream(options?)`    | Same                                                            | `AsyncIterable<ScanEvent>`; refs and failures as discovered          |
| `sessions.read(ref)`               | `SessionRef`                                                    | Complete `Session` snapshot                                          |
| `sessions.open(ref)`               | `SessionRef`                                                    | Replayable handle: `stream()`, `events()`, `records()`, `snapshot()` |
| `sessions.parse(provider, input)`  | `{ path, format?, id?, locator? }` or `{ jsonl, source?, id? }` | Complete `Session` snapshot                                          |
| `sessions.stream(provider, input)` | `{ jsonl }` acquired input                                      | Single-consumer `AsyncIterable<SessionFrame>`                        |
| `sessions.detect(options?)`        | `homeDir`, `roots`                                              | Per-provider discovered roots                                        |
| `sessions.require(id)`             | Provider id                                                     | Its registered handle, or `ProviderNotFound`                         |
| `sessions.providers()`             | —                                                               | Registered provider handles                                          |

Errors split by caller versus data: invalid requests and cancellation throw, while source
problems become in-band `failures` and `diagnostics` that never retract already emitted refs.
Iterables are lazy, follow consumer backpressure and check cancellation between frames; a
streamed prefix is provisional until the iterator completes.
The [architecture contract](docs/architecture.md) owns the full semantics.

## Scanning local stores

```ts
const { refs, failures } = await sessions.scan({
  providers: ['codex'],
  roots: { codex: ['/backups/codex/sessions'] },
})
```

Explicit `roots` replace defaults and accept supported files or directories; `homeDir` isolates
discovery from the process environment.
Default roots honor each provider's environment
variables — CODEX_HOME, CLAUDE_CONFIG_DIR(S), XDG_CONFIG_HOME/XDG_DATA_HOME and the per-provider
variables in the [coverage contract](docs/architecture.md#provider-coverage-and-format-ownership).
Missing stores produce no refs and no failures; a discovered ref does not guarantee that a later
read succeeds.

## Reading sessions

```ts
const opened = await sessions.open(refs[0]!)
opened.readMode // 'incremental' or 'buffered': the adapter's iteration strategy
for await (const frame of opened.stream()) {
  // 'record' | 'event' | 'diagnostic' | 'metadata' frames, in source order
}
const snapshot = await opened.snapshot() // a fresh read, collected into a Session
```

Each call opens a fresh read-only source and closes it on completion, early return or
cancellation, so replays observe file changes. `read` is equivalent to `open().snapshot()`.
File-backed handles may expose optional capabilities — `select(selection)`, `consume(selection, fn)`
and, where the provider certifies enough usage context, `consumeUsage(fn)`/`consumeUsageFacts(fn)`;
support is member presence on the handle.
Refs need not originate from `scan()`: construct one with `provider`, `id` and `source`
(`path`, `format`, optional `locator`) and call `open` or `read` directly.

## Supplying input directly

`parse`/`stream` skip discovery — no `detect()`, directory walk or header pre-read:

```ts
// A known file:
const fromFile = await sessions.parse('codex', { path: '/backups/rollout.jsonl' })

// Already acquired text, bytes or AsyncIterable<Uint8Array>:
const fromText = await sessions.parse('claude', {
  jsonl: '{"type":"user","sessionId":"example","message":{"content":"hello"}}\n',
  source: 'upload:example', // provenance label only; never opened as a path
})

// Structured stores need their explicit format and native selector:
const fromDatabase = await sessions.parse('cursor', {
  path: '/backups/state.vscdb',
  format: 'cursor_sqlite',
  id: 'composer-id',
  locator: { storage: 'modern' }, // 'legacy' selects ItemTable-backed stores
})
```

File inputs default to `format: 'jsonl'`; compressed files take `'jsonl_zstd'`.
The provider is
explicit — content and file extensions are never used to guess it.
Without an explicit `id`,
the first native identity wins and later conflicting identities are preserved and diagnosed.
Acquired JSONL is supported by every line-based provider; `opencode`, `antigravity`, `cline`,
`fx` and `devin` require file input, and unsupported input fails `UnsupportedSchema`.

`sessions.stream(provider, input)` consumes acquired JSONL incrementally without collecting a
snapshot.
Each returned sequence accepts one consumer — including for string and byte-array
input — and a second iterator throws `TypeError`; call `stream` again to replay.

## Provider coverage

| Provider                        | Implemented stores                                                                          | Compatibility evidence                            |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Claude Code (`claude`)          | Projects/sidechain and Desktop/Cowork JSONL, split and usage-only records                   | [Research](src/providers/claude/RESEARCH.md)      |
| Codex (`codex`)                 | Active/archived JSONL and Zstandard rollouts, both record streams                           | [Research](src/providers/codex/RESEARCH.md)       |
| Cursor (`cursor`)               | IDE KV/bubbles, conversationMap, ItemTable indexes, CLI JSONL and chat/ACP meta/blob stores | [Research](src/providers/cursor/RESEARCH.md)      |
| OpenCode (`opencode`)           | SQLite message/part and session_message, empirical session_v2, historical filesystem JSON   | [Research](src/providers/opencode/RESEARCH.md)    |
| Pi (`pi`)                       | Version 1/2/3 JSONL and complete session trees; future records remain visible               | [Research](src/providers/pi/RESEARCH.md)          |
| OAR (`oar`)                     | Voyage/3 recordings and RawEvent JSONL from any harness                                     | [Research](src/providers/oar/RESEARCH.md)         |
| ACP (`acp`)                     | Recorded stable v1/v2 session notifications and JSON-RPC JSONL                              | [Research](src/providers/acp/RESEARCH.md)         |
| Kimi Code (`kimi`)              | Per-agent wire.jsonl with native session metadata                                           | [Research](src/providers/kimi/RESEARCH.md)        |
| Grok Build (`grok`)             | Native updates.jsonl and summary.json; xAI extensions retained                              | [Research](src/providers/grok/RESEARCH.md)        |
| Antigravity CLI (`antigravity`) | Partial observed SQLite/Protobuf steps; native bytes retained                               | [Research](src/providers/antigravity/RESEARCH.md) |
| Mister Morph (`morph`)          | Topic discovery and ordered native task journal snapshots                                   | [Research](src/providers/morph/RESEARCH.md)       |
| GitHub Copilot CLI (`copilot`)  | Flat/session-state events JSONL; mirrored calls and native usage                            | [Research](src/providers/copilot/RESEARCH.md)     |
| Hermes Agent (`hermes`)         | Current state.db, historical JSON snapshots and JSONL captures/exports                      | [Research](src/providers/hermes/RESEARCH.md)      |
| OpenClaw (`openclaw`)           | Current per-agent SQLite transcripts, compressed payloads and legacy JSONL                  | [Research](src/providers/openclaw/RESEARCH.md)    |
| Qwen Code (`qwen`)              | Project chat JSONL, native Google message parts and system records                          | [Research](src/providers/qwen/RESEARCH.md)        |
| Devin CLI (`devin`)             | SQLite session metadata and all message-tree nodes with main-chain markers                  | [Research](src/providers/devin/RESEARCH.md)       |
| fx (`fx`)                       | Manifest and checkpoint JSON snapshots; event tail not replayed                             | [Research](src/providers/fx/RESEARCH.md)          |
| Cline CLI/Desktop (`cline`)     | Version-1 manifests and adjacent messages JSON                                              | [Research](src/providers/cline/RESEARCH.md)       |
| DeepSeek Harness (`deepseek`)   | v0–v4 immutable JSONL generations and Zstandard logs                                        | [Research](src/providers/deepseek/RESEARCH.md)    |
| Factory Droid (`droid`)         | Legacy interactive JSONL and captured stream-json records                                   | [Research](src/providers/droid/RESEARCH.md)       |

The linked research owns each provider's native-format evidence and limitations; the coverage
contract owns discovery roots and mapping boundaries.
OAR and ACP define recordings rather than
native stores, so they require explicit input or roots.
All stores share the same engine limits: unencrypted rowid SQLite with committed WAL, bounded
records (16 MiB default) and 32 MiB Zstandard windows.
Coverage is fixture-backed — not a promise
to decode every private future format.

## Custom registries and adapters

```ts
import { codexProvider } from 'huihua/providers/codex'
import { createSessionRegistry } from 'huihua/registry'

const registry = createSessionRegistry([codexProvider])
const { refs } = await registry.scan()
```

The root `sessions` composes every builtin provider; `huihua/registry` exposes the same registry
without loading them.
The public [SPI](src/contracts/provider.ts) is thin —
`defineProvider({ id, detect, scan, read })`, plus optional `open`, `parse` and `stream`
capabilities. `huihua/ingest` re-exports the bounded primitives builtin adapters are built on —
`jsonlProvider`, the JSON and SQLite store factories, `Ingestion`, `openFrom`, framing, traversal,
failure and value helpers — so third-party adapters conform to the same scan, ordering,
cancellation and evidence rules without duplicating them.
Supported exports are the root, `/registry`, `/observe`, `/ingest`,
`/testing` and `/providers/{claude,codex,cursor,opencode,pi,oar,acp,kimi,grok,antigravity,morph,copilot,hermes,openclaw,qwen,devin,fx,cline,deepseek,droid}`.
Internal paths are not package exports.

## Boundaries

Huihua reads local session evidence and nothing else: it never executes agents, connects to
networks, writes to or repairs stores, and never opens a database through a SQLite engine or
creates sidecars and locks.
It provides no runtime control, search, indexing or UI, and does
not infer facts that a source does not establish.

## Example packages

| Name                                           | Description                                                                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@huihua/usage`](packages/usage/package.json) | A derivative package that uses Huihua to report daily token usage and model breakdowns from local coding-agent sessions. See the [Usage guide](docs/usage-report.md). |

## Development

Use the pinned pnpm version and run `pnpm check` before submitting changes;
the [contributing guide](CONTRIBUTING.md) describes the validation pipeline, fixture rules and
review policy, and the [architecture contract](docs/architecture.md) owns layer and API semantics.
The opt-in [`pnpm bench`](docs/jsonl-benchmark.md) command measures synthetic large JSONL reads;
it is not part of `pnpm check`.

## License

[MIT](LICENSE) © 2026 wibus-wee.
