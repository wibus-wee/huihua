import * as Comlink from 'comlink'
import type { Diagnostic, ScanEvent, ScanFailure, SessionEvent, SessionFrame, SessionRef } from 'huihua/browser'
import { millisOf } from 'huihua/browser'
import { create } from 'zustand'

import type { HuihuaWorkerApi, MountSummary, RawRecordEnvelope } from './huihua.worker.ts'

/** One rendered timeline row: a single event, or a tool call paired with its result. */
export interface TimelineRow {
  readonly key: string
  readonly event: SessionEvent
  readonly result?: SessionEvent
}

export interface SessionView {
  readonly ref: SessionRef
  readonly readMode: 'incremental' | 'buffered'
  readonly done: boolean
  readonly rows: readonly TimelineRow[]
  readonly diagnostics: readonly Diagnostic[]
  /** diagnostics grouped by code, for the collapsed footer bar */
  readonly diagnosticCounts: ReadonlyMap<string, number>
  /** Late-arriving metadata patches, merged as they stream in. */
  readonly title: string | undefined
  readonly workspace: SessionRef['workspace']
  readonly usageCount: number
  readonly openError: string | undefined
}

interface MountedFile {
  readonly path: string
  readonly size: number
}

interface ViewerState {
  readonly mount: MountSummary | undefined
  readonly mountedFiles: readonly MountedFile[]
  readonly walWarnings: readonly string[]
  readonly scanning: boolean
  readonly scanDone: boolean
  readonly refs: readonly { ref: SessionRef, displayPath: string }[]
  readonly failures: readonly ScanFailure[]
  readonly view: SessionView | undefined
  readonly inspectorSequence: number | undefined
  readonly inspectorRecord: RawRecordEnvelope | undefined
  readonly status: string | undefined
  readonly error: string | undefined

  setStatus: (status: string | undefined) => void
  setError: (error: string | undefined) => void
  mountEntries: (entries: readonly { path: string, blob: Blob }[]) => Promise<void>
  reset: () => Promise<void>
  selectSession: (ref: SessionRef) => Promise<void>
  inspectEvent: (sequence: number) => void
  closeInspector: () => void
  exportSession: () => Promise<void>
}

const worker = Comlink.wrap<HuihuaWorkerApi>(
  new Worker(new URL('./huihua.worker.ts', import.meta.url), { type: 'module' }),
)

/**
 * Only refs that resolve to a SQLite session store get a -wal warning. IDE-internal
 * databases (memories/goals/thread_history) are not session stores and never warned.
 */
function walWarningsFor(refs: readonly { ref: SessionRef, displayPath: string }[], mountedPaths: ReadonlySet<string>): string[] {
  const warnings: string[] = []
  for (const { ref, displayPath } of refs) {
    if (!/sqlite|vscdb/i.test(ref.source.format))
      continue
    if (!mountedPaths.has(`${displayPath}-wal`))
      warnings.push(displayPath)
  }
  return warnings
}

/**
 * Rebuilds timeline rows from events: each tool_call row absorbs its tool_result so a
 * call renders as one expandable card. Unpaired results keep their own row.
 */
function pairRows(events: readonly SessionEvent[]): TimelineRow[] {
  const resultsByCallId = new Map<string, SessionEvent>()
  for (const event of events) {
    if (event.type === 'tool_result' && event.data.callId !== undefined)
      resultsByCallId.set(event.data.callId, event)
  }
  const pairedResults = new Set<SessionEvent>()
  const rows: TimelineRow[] = []
  for (const event of events) {
    if (event.type === 'tool_call' && event.data.callId !== undefined) {
      const result = resultsByCallId.get(event.data.callId)
      if (result !== undefined) {
        pairedResults.add(result)
        rows.push({ key: `e${event.sequence}`, event, result })
        continue
      }
    }
    if (event.type === 'tool_result' && pairedResults.has(event))
      continue
    rows.push({ key: `e${event.sequence}`, event })
  }
  return rows
}

export const useViewer = create<ViewerState>()((set, get) => {
  function applyFrames(view: SessionView, frames: readonly SessionFrame[]): SessionView {
    const events = view.rows.map(row => row.event)
    const flat = [...events]
    const diagnostics = [...view.diagnostics]
    let title = view.title
    let workspace = view.workspace
    let usageCount = view.usageCount
    for (const frame of frames) {
      if (frame.type === 'event') {
        flat.push(frame.event)
        if (frame.event.type === 'usage')
          usageCount += 1
      }
      else if (frame.type === 'diagnostic') {
        diagnostics.push(frame.diagnostic)
      }
      else if (frame.type === 'metadata') {
        if (frame.patch.title !== undefined)
          title = frame.patch.title
        if (frame.patch.workspace !== undefined)
          workspace = frame.patch.workspace
      }
      // record frames stay worker-side; the inspector fetches them on demand.
    }
    const diagnosticCounts = new Map<string, number>()
    for (const d of diagnostics)
      diagnosticCounts.set(d.code, (diagnosticCounts.get(d.code) ?? 0) + 1)
    return { ...view, rows: pairRows(flat), diagnostics, diagnosticCounts, title, workspace, usageCount }
  }

  return {
    mount: undefined,
    mountedFiles: [],
    walWarnings: [],
    scanning: false,
    scanDone: false,
    refs: [],
    failures: [],
    view: undefined,
    inspectorSequence: undefined,
    inspectorRecord: undefined,
    status: undefined,
    error: undefined,

    setStatus: status => set({ status }),
    setError: error => set({ error }),

    async mountEntries(entries) {
      if (entries.length === 0)
        return
      set({ status: `Mounting ${entries.length} files…`, error: undefined })
      try {
        const summary = await worker.mount(entries.map(entry => ({ path: entry.path, blob: entry.blob })))
        const mountedPaths = new Set(entries.map(entry => entry.path))
        set({
          mount: summary,
          mountedFiles: entries.map(entry => ({ path: entry.path, size: entry.blob.size })),
          walWarnings: [],
          refs: [],
          failures: [],
          view: undefined,
          inspectorSequence: undefined,
          inspectorRecord: undefined,
          scanDone: false,
          scanning: true,
          status: `Scanning ${summary.files} files (${(summary.bytes / 1024 / 1024).toFixed(1)} MiB)…`,
        })
        await worker.scan(Comlink.proxy((event: ScanEvent) => {
          set((state) => {
            if (event.type === 'ref') {
              const displayPath = event.ref.source.path
              const existing = state.refs.findIndex(item => item.ref.id === event.ref.id && item.ref.provider === event.ref.provider)
              const next = [...state.refs]
              const item = { ref: event.ref, displayPath }
              if (existing >= 0)
                next[existing] = item
              else
                next.push(item)
              return { refs: next }
            }
            return { failures: [...state.failures, event.failure] }
          })
        }))
        set(state => ({
          scanning: false,
          scanDone: true,
          walWarnings: walWarningsFor(state.refs, mountedPaths),
          status: `Found ${state.refs.length} sessions${state.failures.length > 0 ? `, ${state.failures.length} scan failures` : ''}`,
          refs: [...state.refs].sort((a, b) =>
            (millisOf(b.ref.updatedAt) ?? millisOf(b.ref.createdAt) ?? 0)
            - (millisOf(a.ref.updatedAt) ?? millisOf(a.ref.createdAt) ?? 0)),
        }))
      }
      catch (error) {
        set({ scanning: false, error: error instanceof Error ? error.message : String(error), status: undefined })
      }
    },

    async reset() {
      await worker.dispose()
      set({
        mount: undefined,
        mountedFiles: [],
        walWarnings: [],
        scanning: false,
        scanDone: false,
        refs: [],
        failures: [],
        view: undefined,
        inspectorSequence: undefined,
        inspectorRecord: undefined,
        status: undefined,
        error: undefined,
      })
    },

    async selectSession(ref) {
      set({
        view: {
          ref,
          readMode: 'incremental',
          done: false,
          rows: [],
          diagnostics: [],
          diagnosticCounts: new Map(),
          title: ref.title,
          workspace: ref.workspace,
          usageCount: 0,
          openError: undefined,
        },
        inspectorSequence: undefined,
        inspectorRecord: undefined,
        status: `Opening ${ref.id}…`,
      })
      try {
        const opened = await worker.open(ref)
        set(state => state.view === undefined || state.view.ref !== ref
          ? state
          : {
              view: { ...state.view, readMode: opened.readMode },
              status: `Reading ${ref.id}…`,
            })
        await worker.read(Comlink.proxy((frames: readonly SessionFrame[]) => {
          set(state => state.view === undefined || state.view.ref !== ref
            ? state
            : {
                view: applyFrames(state.view, frames),
              })
        }))
        set(state => state.view === undefined || state.view.ref !== ref
          ? state
          : {
              view: { ...state.view, done: true },
              status: undefined,
            })
      }
      catch (error) {
        set(state => ({
          view: state.view === undefined || state.view.ref !== ref
            ? state.view
            : { ...state.view, done: true, openError: error instanceof Error ? error.message : String(error) },
          status: undefined,
        }))
      }
    },

    inspectEvent(sequence) {
      set({ inspectorSequence: sequence, inspectorRecord: undefined })
      const { view } = get()
      const row = view?.rows.find(item => item.event.sequence === sequence)
      if (view === undefined || row === undefined)
        return
      worker.recordAt(view.ref, row.event.record)
        .then((record) => {
          set(state => state.inspectorSequence === sequence ? { inspectorRecord: record } : state)
        })
        .catch(() => {
          set(state => state.inspectorSequence === sequence ? { inspectorRecord: undefined } : state)
        })
    },

    closeInspector() {
      set({ inspectorSequence: undefined, inspectorRecord: undefined })
    },

    async exportSession() {
      const { view } = get()
      if (view === undefined)
        return
      const json = await worker.snapshot(view.ref)
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${view.ref.provider}-${view.ref.id}.session.json`
      anchor.click()
      URL.revokeObjectURL(url)
    },
  }
})
