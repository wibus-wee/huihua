# Browser-portable parsing for Huihua

Status: proposal, not started.
The design decisions below need an owner decision before code changes.

Owner: the maintainer who accepts the decisions in [Decision log](#decision-log).
Author: agent design session 2026-11-05.

## Purpose / Big Picture

A user should be able to open a static page, hand over the session folders their coding agents
already wrote to disk, and read those sessions in the tab — with no upload, no install, no server,
and no second parser that drifts from this one.

The unit of value is the `agent-session/v1` Session.
Today it can only be produced where
`node:fs` exists.
The goal is to produce the same Session, byte-identical, from bytes the browser
can reach (`File`, `Blob`, `FileSystemDirectoryHandle`) while the Node build keeps its current
behavior exactly.

This is not a rewrite and not a fork.
Measured on 2026-11-05 from [src/index.ts](../../src/index.ts):
42 modules, 7 distinct Node builtins and 4 third-party packages.
Everything that decides meaning —
`contracts`, `Ingestion`, decoders, `observe`, provider mapping — is already platform-free.
What is
not portable is six narrow concerns: byte access, directory listing, path algebra, `Buffer`,
environment lookup and one SHA-256 call.

The user-facing rationale, in order of why this is worth doing:

| Claim                                     | Why it matters                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| The parser runs where the data already is | A session store is local evidence. Moving it to a server is the risk users refuse; a tab has no upload path.              |
| One parser, two runtimes                  | A browser build that drifts would quietly invalidate every compatibility fixture in this repository.                      |
| The tab becomes a converter               | `jsonOf(session)` exports `agent-session/v1`, so the browser is a front door to the same evidence, not a silo.            |
| The seam is useful on Node too            | A `{ path, bytes }` store lets Node read an exported folder, a CI artifact or an Electron hand-off without touching disk. |

## Current state, measured

Reachable from `src/index.ts` today:

| Node builtin       | Importing files | What it is used for                                                               |
| ------------------ | --------------- | --------------------------------------------------------------------------------- |
| `node:path`        | 21              | Provider root algebra, matcher normalization, evidence paths                      |
| `node:os`          | 18              | `homedir()` defaults                                                              |
| `node:process`     | 15              | `process.env` defaults (`CODEX_HOME`, `CLAUDE_CONFIG_DIR(S)`, XDG, provider vars) |
| `node:buffer`      | 9               | `Buffer.alloc/concat/from`, `readUInt32LE`, `toString('hex')`, `subarray`         |
| `node:fs/promises` | 6               | `stat`, `readdir`, `realpath`, `open`                                             |
| `node:fs`          | 1               | `createReadStream` for JSONL framing                                              |
| `node:crypto`      | 1               | Cursor `createHash('sha256')`                                                     |

Third-party packages are already portable: `picomatch`, `@bufbuild/protobuf/wire`, `fzstd`
(dynamically imported, so it stays out of the initial graph) and `xxhashjs` (needs a `Buffer`-like
input).

A browser-platform build already succeeds today, but only by leaving every Node builtin external, so
nothing can load:

| Probe on 2026-11-05 (tsdown 0.23.0, `platform: 'browser'`) | Result                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Bundled output                                             | 226 KB, 53 KB gzip                                                                     |
| Bare specifiers left in the output                         | 7 `node:` specifiers plus the four runtime dependencies                                |
| Failure mode                                               | A static `import` of a `node:` specifier, so the graph fails at load, before any parse |

Three properties of the existing design make the port cheap, and each should be reused rather than
re-created:

1. `ScanOptions.homeDir` and `ScanOptions.roots` already short-circuit `process.env` and `homedir()`
   (`resolveClaudeRoots`, Codex `roots()`).
   Discovery policy therefore needs no change: the browser
   supplies a synthetic home and the existing provider defaults resolve inside it.
2. `jsonlProvider` frames bytes through `jsonLines(path)` while the framing core already accepts an
   arbitrary `AsyncIterable<Uint8Array>` (`jsonLinesFrom`).
   The byte source is already one function
   deep, not spread through 20 providers.
3. `SqliteReader` is a pure-TypeScript page reader over a random-access handle (`read(offset, size)`,
   `stat`, WAL overlay).
   It never uses a SQLite engine, so `File.slice()` is a sufficient
   replacement for `FileHandle`.

## Design

### Six conditional seams, one parser graph

Add an internal specifier per concern, resolved by the `node` condition for the existing build and by
the `browser` condition for the portable build:

| Seam      | Node               | Browser                                                                                               | Why this way                                                                                                                           |
| --------- | ------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `#fs`     | `node:fs/promises` | Mount table over `File`/`Blob` slices, zero-copy                                                      | Only six call sites (`stat`, `readdir`, `realpath`, `open`, `createReadStream`, `exists`)                                              |
| `#path`   | `node:path`        | POSIX subset (`join`, `basename`, `dirname`, `relative`, `resolve`, `isAbsolute`, `sep`, `delimiter`) | `pathMatcher` depends on exact `relative`/`sep` semantics; a differential test against `node:path.posix` makes faithfulness executable |
| `#bytes`  | `node:buffer`      | `buffer` (pure JS, maintained)                                                                        | Keeps ~80 `Buffer` sites, the 256 KiB framing hot path and `xxhashjs` unchanged                                                        |
| `#os`     | `node:os`          | fixed synthetic home                                                                                  | Unused whenever `homeDir` is explicit; no behavior exists to preserve                                                                  |
| `#env`    | `node:process`     | frozen `{}`                                                                                           | Environment-driven defaults are impossible in a tab by construction, which is a property worth stating                                 |
| `#crypto` | `node:crypto`      | `@noble/hashes` SHA-256 (pure JS, no WASM)                                                            | Cursor needs a synchronous hash; WebCrypto would change `persisted.ts` to async for one call site                                      |

Optional later, same mechanism: `#zstd` preferring `DecompressionStream('zstd')` and falling back to
`fzstd`.

Build mechanism: two `tsdown` builds — the existing Node build, and one with
`platform: 'browser'` emitting `dist/browser/` plus a new `./browser` export condition.
Existing
consumers keep resolving the `node` arm of every seam to the same `node:` modules they use today, so
the Node build must stay byte-identical against the v1 goldens.

### Alternatives rejected

| Option                                                                                   | Why not                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A separate browser package or a second parser                                            | Twenty providers, the evidence contract and every fixture would need a second implementation that can drift.                                                                                                                                                                                                                |
| Injecting a driver object through `ScanOptions`/`ReadOptions` and a registry constructor | Providers must keep a default `node:fs` fallback, so the portable bundle still contains `node:` specifiers, or every provider instance must be rebuilt per driver, which forks provider identity. Adding an option to every public read call also pushes a responsibility onto callers that a build condition handles once. |
| A `Buffer`-free migration of the whole graph now                                         | ~80 sites including the JSONL framing hot path; measured only by benchmarks this repository forbids running without explicit authorization. Keep it as a follow-up behind the same seam.                                                                                                                                    |
| Browser-specific provider roots / a browser discovery table                              | Duplicates the discovery policy that `homeDir` already covers; a new policy table would be the second projection the project explicitly avoids.                                                                                                                                                                             |

## User experience

### Handing over data

| Gesture                       | Support                       | Notes                                                                                                                                                                      |
| ----------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drag a folder                 | Chrome, Edge, Safari, Firefox | Recursive `webkitGetAsEntry`; preserves dot-directories such as `.claude`. Primary path.                                                                                   |
| `showDirectoryPicker()`       | Chromium                      | Handles can be persisted in IndexedDB so a revisit re-attaches without re-picking; lists dot-directories.                                                                  |
| `<input webkitdirectory>`     | All evergreen                 | Fallback only: the OS folder picker hides dot-directories unless the user reveals hidden files. Verify per browser during P4 before documenting it as a supported gesture. |
| Drop a single transcript file | All evergreen                 | Works through explicit file roots for every line-based provider; no folder semantics required.                                                                             |

### Placement: a synthetic home, not a browser discovery table

Dropped trees are mounted at `/huihua/<n>/home`, and the caller scans with that `homeDir`.
Provider
default resolution then runs verbatim: `.claude/projects`, `.claude*/projects` siblings,
`Library/Application Support/Claude/local-agent-mode-sessions`, `.codex/sessions`,
`.local/share/opencode`, XDG paths, Cursor families.

Placement rule: a dropped top-level name is matched against the suffixes of
`provider.detect({ homeDir }).roots`; unknown names mount under the home unchanged; single files fall
back to explicit `roots` for every registered provider id.
Nothing in `src/providers/*` changes.

### From gesture to evidence

```ts
import { allProviderRoots, mount, sessions } from 'huihua/browser'

const store = await mount(await entriesOf(dataTransfer)) // { path, file }[] from any gesture
// scanStream(options) emits the same refs progressively for a live UI.
const { refs } = await sessions.scan(
  store.homeDir === undefined
    ? { roots: allProviderRoots(store.paths) }
    : { homeDir: store.homeDir },
)

for await (const frame of (await sessions.open(refs[0]!)).stream())
  consume(frame) // 'record' | 'event' | 'diagnostic' | 'metadata', in source order

store.describe(refs[0]!.source.path) // '/huihua/1/home/.claude/projects/x/123.jsonl' -> 'projects/x/123.jsonl'
```

| Step     | Contract                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Discover | `scanStream` refs and per-source failures; no spinner-then-list, no fatal mode                                                       |
| Read     | `open().stream()` frames only; `snapshot()` is reserved for export, because a large session collected into one object is a tab crash |
| Preserve | Same `records`, same `text` lexemes, same diagnostics and failures; the synthetic path stays in evidence                             |
| Explain  | `store.describe(path)` maps evidence paths back to what the user dropped, so failures are actionable                                 |
| Export   | `jsonOf(session)` produces `agent-session/v1` JSON; the tab is a converter, not a silo                                               |
| Release  | `store.dispose()` drops mount references; nothing is copied until read                                                               |

### Trust properties to enforce, not assert

- The portable graph contains no `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` or remote
  dynamic import; enforced by an architecture check over the same module walk that measures the
  `node:` allowlist.
- Mount reads are zero-copy: `File`/`Blob` references are kept, and only the requested range is read.
  Mounting a multi-gigabyte store must not allocate gigabytes.
- Worker-ready: the portable graph never touches `window` or `document`; only the gesture adapter
  accepts DOM objects, so a worker can mount a structured-cloned `File` and keep the main thread idle.

### Known degradations, to state in UI copy

| Degradation                                            | Consequence                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Symlinks are not followed; `canonicalPath` is identity | A store behind a symlink must be handed over as its real directory                      |
| SQLite `-wal` must be dropped next to the database     | Otherwise the newest sessions are invisible; an additive diagnostic can say so          |
| No permission failures exist                           | Unreadable entries surface through a caller-supplied `onEntryError` instead of `EACCES` |
| Safari has no File System Access API                   | No re-attach; drop or file input only. iOS: single files only, no folder hand-off       |
| Cursor ACP roots require `canonicalPath`               | Always certified in a virtual store; note it in the Cursor compatibility evidence       |

### Developer experience

One import specifier changes: `huihua/browser` instead of `huihua`.
No bundler configuration, no
`resolve.fallback`, no polyfill aliases, no `node:` shims to install, same `SessionRef`/`Session`
types and the same failure semantics.
TypeScript declarations are emitted for both builds from the
same source.

## Plan of work (as executed)

Each phase is independently useful and independently verifiable.
No phase changes provider mapping!

| Phase | Work                                                                                                                                                                                                                       | Acceptance                                                                                                                                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0    | Land `tools/portable.ts`: walk the graph reachable from each entry, assert the `node:` + network allowlists. Wire it into `tools/check.ts`. Seed the allowlist with the table in [Current state](#current-state-measured). | `pnpm check` passes; the allowlist is a ratchet that shrinks each phase                                                                                                                                                                      |
| P1    | Introduce `#fs`, `#path`, `#bytes`, `#os`, `#env`, `#crypto` with Node arms delegating to today's modules. Mechanical import swaps only.                                                                                   | v1 goldens byte-identical; all existing tests pass; no new export; no behavior change                                                                                                                                                        |
| P2    | Browser arms: mount table + Blob-backed handles + POSIX path subset + differential path test. Cover `stat`, `readdir`, `open`, `createReadStream`, `exists`, `realpath`.                                                   | The fixture corpus driven through a mounted fixture tree produces the same sessions as the Node driver for every provider; focused regressions for mount placement, explicit file roots, missing `-wal`, truncated JSONL and unknown folders |
| P3    | `dist/browser` build, `./browser` export, dependency allowlist entries (`buffer`, `@noble/hashes`), bundle-size budget, no-network check                                                                                   | `node --conditions=browser` reads a mounted fixture tree; `dist/browser` contains zero `node:` specifiers and zero network APIs; budget check fails on regression                                                                            |
| P4    | `mount`, `allProviderRoots`, `describe`, `dispose`, gesture adapters, `onEntryError`; README section and `docs/browser-portable.md`                                                                                        | A documented five-gesture matrix, verified per browser, plus a runnable example kept outside the package                                                                                                                                     |
| P5    | Follow-ups, separately scoped: native `zstd` seam, `Uint8Array` migration, IndexedDB handle persistence helper, WAL-missing diagnostic                                                                                     | Each with its own measurement or acceptance evidence                                                                                                                                                                                         |

Estimated effort for P0–P4 is roughly one focused week for someone who already knows this codebase;
P2 is the only phase with real unknowns (WAL, huge files, worker transfer).

## Validation and acceptance

- Cross-driver parity: the same fixture corpus through the Node driver and the mounted driver, compared
  with `jsonOf` on every session — this is the claim "one parser, two runtimes" made executable.
- `node --conditions=browser` runs the portable graph in Node, so the portable arm is unit-testable
  without a browser or a bundler in `pnpm check`.
- The architecture check owns the two allowlists (`node:` specifiers, network APIs) and the module
  walk, so a provider that starts using `node:fs` directly fails the check instead of silently
  breaking the browser build.
- No benchmark runs are proposed.
  Any performance claim for P5 must be authorized separately.

## Compatibility and impact

| Area         | Impact                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public API   | Additive: `./browser` subpath plus `mount`, `allProviderRoots`, `describe`, `dispose`. Existing exports, `agent-session/v1` and Node behavior unchanged             |
| Evidence     | Unchanged: synthetic mount paths appear in `source.path`; `store.describe` maps them back without adding schema fields                                              |
| Dependencies | `buffer` and `@noble/hashes` under the `browser` condition only, with reasons recorded in the policy allowlist. Both pure JS, no WASM, no native code               |
| Boundaries   | Still no network, no writes, no runtime control, no indexing, no UI. The package ships mount helpers; any visual surface stays outside this repository              |
| Docs         | New row in [docs/architecture.md](../architecture.md) once P1 lands, a new `docs/browser-portable.md` owner for the driver and gesture contract, README table entry |

## Decision log

Decided in this proposal:

- Port the seams instead of forking the parser; a browser build that can drift from the fixtures is
  not acceptable.
- Conditional `#` specifiers rather than option-injected drivers, so the portable graph contains no
  `node:` specifiers at all.
- Keep `Buffer` behind a seam for v1; migrate to `Uint8Array` later only with measurements.
- Synthetic home plus existing provider defaults instead of browser-specific roots.
- Export as `./browser`; the word "portable" already means explicit-file acquisition in this
  repository's vocabulary, so reusing it for a runtime would be ambiguous.
- Portable graph stays DOM-free and worker-ready.

Questions this work settled instead of deferring:

1. Bundle cost: `buffer` and `@noble/hashes` are inlined into the portable artifact from development
   dependencies, so publishing adds no runtime dependency and the Node build keeps native Buffer.
2. The package ships mount helpers only; any demo page or visual surface stays outside this repository.
3. `mount` infers `home` or `files` from path depth and accepts an explicit `as` override.
4. No new diagnostic was added: a missing `-wal` still yields the unchanged snapshot behaviour.
5. The artifact is asserted structurally (no Node import, no network API, no unresolved seam) rather
   than by a byte budget.
6. Validation stays Node-level: fixture parity against the built portable artifact plus unit tests
   for the arms.
   No browser lane was added.

## Context and orientation

- [src/shared/paths.ts](../../src/shared/paths.ts) owns the single walker, `pathMatcher`, `exists`,
  `canonicalPath` and `ioError`; it is the `#fs` and `#path` consumer.
- [src/shared/jsonl.ts](../../src/shared/jsonl.ts) owns framing; `jsonLines(path)` reads through
  `createReadStream` (262 KiB) and `jsonLinesFrom(bytes)` already accepts any byte iterable.
- [src/shared/sqlite.ts](../../src/shared/sqlite.ts) owns the page reader and WAL overlay over a
  `FileHandle`; [src/shared/sqlite-store.ts](../../src/shared/sqlite-store.ts) and
  [src/shared/json-store.ts](../../src/shared/json-store.ts) are the store factories.
- [src/registry.ts](../../src/registry.ts) owns scan orchestration;
  [src/contracts/provider.ts](../../src/contracts/provider.ts) owns the SPI that must not grow a
  runtime concern.
- [tools/policy.ts](../../tools/policy.ts) is where the executable architecture checks live;
  [tools/check.ts](../../tools/check.ts) is the pinned pipeline.
- [tests/oracle.ts](../../tests/oracle.ts) and [tools/fixtures.ts](../../tools/fixtures.ts) own the
  fixture corpus and goldens that P1 and P2 must reuse rather than extend.

## Out of scope

- Zip, tar or archive ingestion; the browser hands over real entries.
- Any visual application, component library or routing inside this package.
- Writing, repairing or migrating agent stores.
- Reading Google Drive/iCloud-style remote stores, or any network source.
- Runtime control of agents, indexing, search or memory.
