# Portable parsing

Huihua's parser graph runs unchanged on two platforms: Node, and anything with `Blob` and
`TextDecoder` such as a browser tab or a worker.
The portable entry is the same source with different platform arms, not a second parser.
This document owns the seam contract, the mount model, the packaging decisions and the known
behaviour differences; [the architecture contract](architecture.md) still owns schema, discovery and
failure semantics.

## Entry points

| Specifier        | Platform                                     | Adds                                                  |
| ---------------- | -------------------------------------------- | ----------------------------------------------------- |
| `huihua`         | Node 22.18+                                  | `sessions`, projections, contracts, provider subpaths |
| `huihua/browser` | A browser, a worker, or any host with `Blob` | Everything above, plus `mount` and gesture adapters   |

Both specifiers export the same `SessionRegistry`, schema and failure semantics.
`huihua/browser` is one bundled artifact: a browser consumer installs no Node shim, no polyfill alias
and no `resolve.fallback` configuration.

```ts
import { allProviderRoots, mount, sessions } from 'huihua/browser'

const store = await entriesOfHandOff() // PortableEntry[] from any gesture below
const mounted = mount(store, { as: 'home' })

const { refs, failures } = await sessions.scan({ homeDir: mounted.homeDir })
mounted.describe(refs[0]!.source.path) // synthetic path -> the relative path that was handed over
mounted.dispose() // releases the mount table entry
```

`scanStream` accepts the same options and emits refs as they are discovered.
A failure never retracts a ref, exactly as on Node.

## Handing over data

| Gesture                          | Adapter                | Support                                                                |
| -------------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| Drag and drop, including folders | `entriesFromDrop`      | Chrome, Edge, Safari, Firefox; recursive, and keeps dot-directories    |
| `<input type="file">`            | `entriesFromFileList`  | All evergreen browsers; uses `webkitRelativePath` when present         |
| `showDirectoryPicker()`          | `entriesFromDirectory` | Chromium; the handle can be persisted and re-attached on a later visit |

Adapters return `PortableEntry[]` and never read file contents.
`mount` rejects empty input and any path containing `..`, so a hand-off cannot address files outside
what the user selected.

## Mount model

`mount` builds one read-only virtual tree and returns:

| Member     | Meaning                                                                            |
| ---------- | ---------------------------------------------------------------------------------- |
| `root`     | Synthetic root of this mount, for example `/huihua/1/files`                        |
| `homeDir`  | Synthetic home in `home` mode; scan with it so provider defaults resolve inside it |
| `mode`     | `home` when every path is nested, `files` otherwise, unless `as` forces one        |
| `paths`    | Absolute synthetic paths of every mounted file                                     |
| `files`    | Entry count                                                                        |
| `bytes`    | Sum of entry sizes, known without reading anything                                 |
| `describe` | Maps an evidence path back to the relative path the caller handed over             |
| `dispose`  | Removes the mount from the table                                                   |

Home mode exists so provider discovery policy stays untouched: `.claude/projects`,
`.claude*/projects` siblings, `Library/Application Support/Claude/local-agent-mode-sessions`,
`.codex/sessions`, XDG paths and the Cursor families resolve exactly as they do on disk.
File mode passes the mounted paths as explicit roots for every registered provider, so a bare
transcript still certifies through the provider that owns it.
`allProviderRoots(paths)` expands the second case; `rootsFor(providers, paths)` does the same for a
custom registry.

Mounts are zero-copy and multi-mount safe: entries are `Blob` references, reads slice the requested
range, and every mount owns a distinct path prefix.

## Platform seams

Six internal specifiers, declared once in `package.json#imports` and implemented by
`src/shared/platform`:

| Seam      | Node arm       | Browser arm                                                   |
| --------- | -------------- | ------------------------------------------------------------- |
| `#fs`     | `node:fs`      | Mount table over `Blob` slices, streaming and random access   |
| `#path`   | `node:path`    | POSIX subset, differentially tested against `node:path.posix` |
| `#bytes`  | `node:buffer`  | `buffer`, the maintained pure-JS implementation               |
| `#os`     | `node:os`      | Fixed synthetic home                                          |
| `#env`    | `node:process` | Frozen empty environment                                      |
| `#crypto` | `node:crypto`  | `@noble/hashes` SHA-256                                       |

Neither arm exposes a platform fact to provider mapping: providers import the seam, never a builtin.
`tools/policy.ts` enforces the pairing, refuses `node:` imports inside a browser arm or the browser
layer, refuses browser-only dependencies outside their arm and keeps the browser layer DOM-free so a
worker can import it.

The Node build resolves every seam to the same builtins it used before, so no Node behaviour changed;
`pnpm check` re-reads the v1 goldens on that assumption.

## Packaging

| Decision                                                 | Reason                                                                                                                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two builds, one source                                   | `tsdown.config.ts` emits `dist`, `tsdown.browser.config.ts` emits `dist/browser`; the portable entry needs no consumer setup                                           |
| `buffer` and `@noble/hashes` as development dependencies | They are inlined into `dist/browser`, so the published package adds no runtime dependency                                                                              |
| `dist/browser/index.js` is a listed side effect          | The browser byte arm installs the maintained `Buffer` implementation as a global when the host has none, which XXH64 requires                                          |
| `buffer/index.js` import                                 | The bare `buffer` specifier resolves to the Node builtin everywhere except the portable bundle, so the package subpath keeps the dependency visible to static analysis |

## Behaviour and limits

| Fact                                   | Consequence                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Evidence keeps synthetic paths         | `source.path` starts at the mount root; use `describe` for display and diagnostics                                |
| No symbolic links exist in a mount     | `canonicalPath` means "exists", so a store behind a symlink must be handed over as its real directory             |
| No working directory exists            | `resolve` roots relative input at `/`; provider code only ever resolves absolute paths                            |
| SQLite snapshots still verify identity | A mounted store uses size and modification time, so a mutated `Blob` is still reported as changed                 |
| SQLite `-wal` must be handed over too  | Otherwise the newest sessions are invisible; the archive, not the parser, decides what was included               |
| Reads are bounded                      | Streaming keeps the existing 262 KiB chunks and `maxRecordBytes` guard; `snapshot()` is for export, not scrolling |
| No network and no writes               | `tools/portable.ts` refuses a portable artifact containing Node imports, network APIs or unresolved seams         |

## Validation

| Check               | Evidence                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Cross-driver parity | `tools/portable.ts` mounts the fixture corpus and compares every session against the Node driver with `jsonOf`             |
| Seam behaviour      | `tests/portable.test.ts` covers mount placement, path algebra against `node:path.posix`, filesystem semantics and gestures |
| Architecture        | `tools/policy.ts` owns the seam inventory, arm pairing, dependency placement and DOM-free browser layer                    |
| Artifact shape      | `tools/portable.ts` asserts `dist/browser` has no `node:` import, no network API and no unresolved seam                    |

## Non-goals

- Any visual interface, component library or routing belongs to a separate project.
- Archive formats; the caller hands over real entries.
- Writing, repairing or migrating a store, and any network acquisition.
- Runtime control of agents, indexing, search or memory.
