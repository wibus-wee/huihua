# @huihua/web

Browser-based huihua session viewer (MVP).
Mounts a local agent store — a
`~/.claude`-style home directory or a folder of session files — and renders a
streaming session timeline entirely in the browser.
Nothing is uploaded; reads
slice the handed-over blobs through the portable `huihua/browser` bundle inside a
Web Worker.

## Usage

```sh
pnpm --filter huihua build   # required once; the viewer consumes dist/browser
pnpm --filter @huihua/web dev
```

Then drop a store directory onto the page, or use **Choose folder**
(`webkitdirectory`) / **Pick directory** (`showDirectoryPicker`, Chromium only;
the handle is persisted in IndexedDB for re-attach).

## Layout

- `src/huihua.worker.ts` — comlink worker owning mount + scan + open; the
  portable mount table is per-context, so everything huihua-side lives here.
  All `source.path` values are resolved through `store.describe()` before they
  cross to the main thread.
- `src/store.ts` — zustand store; streams frames into timeline rows and pairs
  `tool_call`/`tool_result` by `callId`.
- `src/components/` — drop zone, session list, virtualized timeline, inspector.

## Notes

- `snapshot()` is only used for the export button; the timeline accumulates
  streamed events + metadata patches.
- A `.db`/`.sqlite*`/`.vscdb` file mounted without its `-wal` sibling triggers a
  warning banner (newest sessions stay invisible without it).
