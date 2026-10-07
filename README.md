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

## Read evidence, project what you need

```ts
import { jsonOf, sessions } from 'huihua'
import {
  conversationOf,
  eventsOf,
  fileChangesOf,
  subagentsOf,
  toolCallsOf,
  toolResultsOf,
} from 'huihua/observe'

const { refs } = await sessions.scan({ providers: ['codex'] })
if (refs[0]) {
  const session = await sessions.read(refs[0])
  const conversation = conversationOf(session)
  const calls = toolCallsOf(session)
  const results = toolResultsOf(session)
  const tools = eventsOf(session, 'tool_call', 'tool_result')
  const changes = fileChangesOf(session)
  const agents = subagentsOf(session)
  const json = jsonOf(session) // JSON.stringify(session) works as well
}
```

A session uses `agent-session/v1`: ordered `records` contain native evidence once; normalized
`events` refer to their record sequence.
Messages, reasoning, tools, commands, usage, system and
unknown records retain order.
Repeated IDs, mirrored events, native tool names and Pi branches
survive.
Unknown data is retained rather than dropped.
Missing facts remain absent.
Projections
are disposable views of events, with evidence associations intact.

| Selector                    | Selected events                                               |
| --------------------------- | ------------------------------------------------------------- |
| eventsOf(session, ...types) | One or more explicit event types, with a narrowed result type |
| conversationOf(session)     | User and assistant messages                                   |
| toolCallsOf(session)        | Tool calls                                                    |
| toolResultsOf(session)      | Tool results                                                  |
| fileChangesOf(session)      | File changes                                                  |
| subagentsOf(session)        | Subagent lifecycle events                                     |

Selectors retain order, duplicates and original event objects; they do not merge messages or resolve relationships.
An empty result means no matching normalized events were found, not that the source format lacks the capability.
The [architecture contract](docs/architecture.md#projections-and-review-boundaries) defines selection and evidence semantics.

## Local usage report

The separate `@huihua/usage` workspace CLI reads discovered stores through the public streaming API:

```sh
pnpm build
pnpm --filter @huihua/usage start -- --provider claude --since 2026-01-01 --until 2026-01-31 --timezone America/Los_Angeles --json
```

Its provider matrix, native field evidence, partial/unavailable status and reporting limits are documented in [the usage report guide](docs/usage-report.md).
It reports daily input/output/cache token totals and model breakdowns; JSON also includes per-session totals.
Missing fields are null, ambiguous totals are partial, and unsafe cumulative counters are excluded with diagnostics.
It does not estimate bills or remove native records.
File-backed JSONL handles expose an optional `open.select({ events: ['usage'], records: true, metadataKeys: ['parentSessionId'] })` capability.
This uses the same provider parser while avoiding unwanted event delivery and message content conversion; diagnostics, original sequence numbers and usage semantics survive.
For Claude and Codex, the CLI prefers optional `open.consumeUsage(consumer)`: the provider supplies same-record model/identity context with Usage events, without constructing or delivering complete RawRecord evidence.
It reuses the existing provider parser and preserves all diagnostics; native JSON is still decoded and validated.
For an explicit single-day query (`--since` equals `--until`), Claude/Codex instead use optional `consumeUsageFacts` with the report's timestamp predicate, before allocating usage context and canonical event frames.
The same native mapping and aggregation produce identical reports; complete evidence APIs retain their full path.
Batch UTF-8 decoding remains off by default; worker usage and measured tradeoffs are summarized in the guide.
Use `--workers 2` or `--workers 4` to parse multiple JSONL sessions on separate CPU threads, at increased memory cost; the default is serial.
Workers reuse public provider contracts and the same aggregation rules, including cross-session duplicate diagnostics; single-file and buffered sources remain serial.
Other sources use optional `consume(selection, consumer)`, then `select` or the full stream, with records for attribution.
Callbacks may return a Promise for backpressure; consumption completes after validated EOF and propagates callback errors and cancellation.
Explicit provider filters load only those public provider modules through `huihua/registry`; an unfiltered run uses the complete builtin registry.

Keep the full SessionRef: an ID alone can be ambiguous across stores. `diagnostics` explains partial
parses and unsupported records.
Raw `text` preserves JSON numeric spellings outside JavaScript's
safe integer range; use it when exact native numeric lexemes matter.

## Scan local sources

```ts
const { refs, failures } = await sessions.scan()
for (const failure of failures)
  console.warn(failure.provider, failure.source?.path, failure.message)
```

Scanning preserves refs when another source or provider fails, including refs found before a database scan fails midway.
Missing stores produce no refs or failures.
Invalid requests and caller cancellation still throw.
A discovered ref does not guarantee a later read will succeed.

```ts
for await (const event of sessions.scanStream()) {
  if (event.type === 'ref')
    console.log(event.ref)
  else
    console.warn(event.failure)
}
```

scanStream emits discoveries and failures as they become available; scan collects the same events and sorts its refs.
Both deduplicate by provider and complete source, preserving equal IDs from different stores.
See the [scanning contract](docs/architecture.md#scanning-and-failure-reports) for failure scope, cancellation and third-party SPI migration.

## Parse supplied data without discovery

| Entry point               | Input                           | Output                                             |
| ------------------------- | ------------------------------- | -------------------------------------------------- |
| `parse(provider, input)`  | Explicit file or acquired JSONL | Complete Session snapshot                          |
| `stream(provider, input)` | Acquired JSONL                  | One consumption of incremental SessionFrame values |
| `open(ref)`               | Explicit file/store reference   | Replayable handle with frames and snapshots        |

```ts
import { sessions } from 'huihua'

// A known JSONL file: no detect(), scan(), directory traversal or header pre-read.
const fromFile = await sessions.parse('codex', { path: '/backups/rollout.jsonl' })

// Already acquired JSONL: string, Uint8Array or AsyncIterable<Uint8Array>.
const fromText = await sessions.parse('claude', {
  jsonl: '{"type":"user","sessionId":"example","message":{"content":"hello"}}\n',
  source: 'upload:example',
})
```

JSONL acquisition is supported by Codex, Claude, Pi, Cursor's CLI adapter, OAR, ACP, Kimi, Grok, Morph, Copilot, OpenClaw, Qwen, Droid, DeepSeek and Hermes captures/exports.
File reads and supplied data use the same provider mapping, raw evidence, ordering, diagnostics and record limits.
The provider is explicit; content and file extensions are not used to guess it.
The source label is provenance only and is never opened as a path.
Without an explicit id, the first native identity wins; conflicting later identities are preserved and diagnosed.
If none exists, a labeled source identity is returned.
File inputs default to JSONL; compressed files require format: 'jsonl_zstd'.

A database contains multiple sessions; specify the exact format and native selector:

```ts
const fromDatabase = await sessions.parse('cursor', {
  path: '/backups/state.vscdb',
  format: 'cursor_sqlite',
  id: 'composer-id',
  locator: { storage: 'modern' }, // Use 'legacy' for ItemTable-backed stores.
})
const fromOpenCode = await sessions.parse('opencode', {
  path: '/backups/opencode.db',
  format: 'opencode_sqlite',
  id: 'session-id',
  // locator: { table: 'session_v2' } selects that empirical schema; default is 'session'.
})
```

OpenCode's historical session metadata files use format: 'opencode_files' and retain their message/part directory layout.
OpenCode does not consume arbitrary JSONL exports; unsupported acquired input fails explicitly.
parse() returns a full snapshot; a supplied byte stream is consumed once, incrementally, while the returned Session accumulates in memory.
Use stream() to consume acquired JSONL without collecting that snapshot:

```ts
// bytes is a caller-supplied AsyncIterable<Uint8Array> from an already acquired object.
for await (const frame of sessions.stream('codex', {
  jsonl: bytes,
  source: 'stored-object:rollout',
})) {
  if (frame.type === 'event') {
    // Await your batch writes here; the parser follows consumer backpressure.
  }
}
```

stream() also accepts text or Uint8Array and yields the same record/event/diagnostic/metadata frames as file-backed open().
Each returned sequence permits one consumer; concurrent consumption or replay throws TypeError.
To replay, call stream() again with text/bytes or a fresh byte iterable.
Early return closes the producer's iterator; cancellation is checked between frames and chunks.
Producers waiting on their own I/O must also handle the supplied AbortSignal.
Prefixes remain provisional until successful completion, and early return does not validate an unread suffix.
The [direct acquisition contract](docs/architecture.md#direct-acquisition) defines lifecycle and capability boundaries.
For incremental event consumption from a known file, construct a SessionRef and call open(); refs need not originate from scan().

## Stream large transcripts

```ts
const opened = await sessions.open(refs[0]!)
console.log(opened.readMode) // 'incremental' or 'buffered', selected by this source's adapter.
for await (const frame of opened.stream()) {
  if (frame.type === 'event') {
    // Consume incrementally; record, diagnostic and metadata frames remain available too.
  }
}
const snapshot = await opened.snapshot() // A fresh read, collected into a complete Session
```

`opened.events()` and `opened.records()` filter the same stream.
File-backed JSONL handles also support optional `opened.consume(selection, consumer)` with the same canonical frames and parser.
It completes after validated EOF; synchronous callbacks avoid per-frame iterator steps, and returned Promises provide backpressure.
Callback errors and AbortSignal cancellation stop delivery and close the source.
Handles without this optional capability retain the stream/select APIs.
JSONL reads are incremental and
close on early return or AbortSignal cancellation. `read`/`snapshot` collects the full result;
SQL ordering can buffer a selected session's rows.
readMode makes that buffering visible; it describes iteration, while snapshot always collects the full session.
A streamed prefix remains provisional until
completion, because an unread suffix may contain corruption.
Details and resource limits live in
[the architecture contract](docs/architecture.md).

## Providers and custom roots

```ts
const { refs } = await sessions.scan({
  providers: ['codex'],
  roots: { codex: ['/backups/codex/sessions'] },
})
```

Explicit roots replace defaults and accept a supported file or directory.
Explicit `homeDir`
isolates discovery from the process environment.
Default discovery honors CODEX_HOME,
CLAUDE_CONFIG_DIRS, CLAUDE_CONFIG_DIR, absolute XDG_CONFIG_HOME/XDG_DATA_HOME and PI_CODING_AGENT_DIR.
Claude also discovers `.claude*` sibling configurations and Desktop/Cowork local transcripts.
Qwen uses QWEN_HOME only when its projects directory exists, otherwise falling back to ~/.qwen/projects.
Directory discovery validates Qwen chat layout and native identity; Cursor JSONL must live under agent-transcripts.
Explicit file roots and parse() remain available for acquired backups outside native layouts.
Kimi, Grok, Antigravity and Morph honor the store roots listed in the [coverage contract](docs/architecture.md#provider-coverage-and-format-ownership).
Copilot, Hermes, OpenClaw, Qwen, Devin, fx, Cline, DeepSeek and legacy Droid discover their native roots listed in the coverage contract.
OAR and ACP recordings require explicit input or roots.

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

```ts
const voyage = await sessions.parse('oar', { path: '/backups/run.jsonl' })
const acp = await sessions.parse('acp', { path: '/backups/acp.jsonl' })
const agy = await sessions.parse('antigravity', {
  path: '/backups/conversation.db',
  format: 'antigravity_sqlite',
})
const morph = await sessions.parse('morph', {
  path: '/backups/morph-state',
  format: 'morph_journal',
  id: 'topic-id',
})
```

ACP defines a protocol rather than a universal export container; client-specific archives need their own evidence.
Antigravity's native adapter covers an observed CLI database subset; Google's separate ACP-server/IDE storage is not certified.
Use `oar` or `acp` for recordings of that server.
Kimi reads extracted native directories, not ZIP or Markdown exports.
Morph preserves repeated task snapshots, and OAR preserves submitted requests alongside runtime echoes.

For the new structured stores, parse() requires an explicit format:

```ts
const hermes = await sessions.parse('hermes', {
  path: '/backups/state.db',
  format: 'hermes_sqlite',
  id: 'session-id',
})
const devin = await sessions.parse('devin', {
  path: '/backups/sessions.db',
  format: 'devin_sqlite',
  id: 'session-id',
})
const openclaw = await sessions.parse('openclaw', {
  path: '/backups/openclaw-agent.sqlite',
  format: 'openclaw_sqlite',
  id: 'session-id',
})
const cline = await sessions.parse('cline', {
  path: '/backups/session/session.json',
  format: 'cline_json',
})
// Also supported: hermes_json and fx_json, using the exact snapshot/manifest path.
```

JSON snapshots are bounded complete-file reads and report buffered mode.
Devin retains abandoned branches; filter on native on_main_chain metadata when you need the selected chain.
fx reads checkpoint history and diagnoses its unconsumed event tail.
Cline ignores exported external paths and reads only the adjacent messages file.
DeepSeek selects the highest generation per session directory and retains surface changes without replaying migrations.
OpenClaw cold archives and newer private schemas outside the documented tables remain unsupported.

Cursor discovers ~/.cursor/chats and ~/.cursor/acp-sessions stores, validates native metadata and the root blob,
and reads the confirmed protobuf user/assistant text graph.
Private tool/thinking steps, shell turns and historical blobs remain complete native evidence with diagnostics.
Kimi refs retain every physical agent stream and expose metadata.agentRole, metadata.agentId and, when recorded, metadata.nativeSessionId.
SQLite ingestion supports unencrypted rowid
tables, overflow and committed WAL without source writes; virtual/generated-column/WITHOUT ROWID
schemas fail explicitly.
Active database changes and nonempty rollback journals can return
PartialParse.
Zstandard windows are capped at 32 MiB and dictionary frames are unsupported.
These are fixture-backed boundaries, not a promise to decode every private future product format.

## Compose your own registry

```ts
import { codexProvider } from 'huihua/providers/codex'
import { createSessionRegistry } from 'huihua/registry'

const registry = createSessionRegistry([codexProvider])
const { refs } = await registry.scan()
const provider = registry.require('codex')
```

Third-party adapters use `defineProvider({ id, detect, scan, read })`; scan returns `AsyncIterable<ScanEvent>` with ref and failure events.
Optionally implement `open` for file streaming, `parse` for acquired snapshots and `stream` for acquired frames.
The registry knows no builtin identities; duplicate registration fails.
`registry.require(id)` resolves a registered provider handle or throws ProviderNotFound;
capability support is member presence on that handle, such as `provider.open`.
The public
[SPI](src/contracts/provider.ts) is thin.
The independent `/registry` entrypoint exposes the same registry as the root without loading builtin providers.
Supported exports are the root, `/registry`, `/observe`,
`/testing` and `/providers/{claude,codex,cursor,opencode,pi,oar,acp,kimi,grok,antigravity,morph,copilot,hermes,openclaw,qwen,devin,fx,cline,deepseek,droid}`.
Internal paths are not package exports.

## Development and releases

Use the pinned pnpm version and run pnpm check before submitting changes.
The [quality and release automation](docs/architecture.md#quality-and-release-automation) contract describes CI, version tags and npm Trusted Publisher setup.
The opt-in [`pnpm bench`](docs/jsonl-benchmark.md) command measures synthetic large JSONL reads; it is not part of `pnpm check`.

## License

[MIT](LICENSE) © 2026 wibus-wee.
